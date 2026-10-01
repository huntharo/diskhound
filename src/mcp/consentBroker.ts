import { randomUUID } from "node:crypto";

import {
  BUILT_IN_MCP_ROLES,
  DEFAULT_CONSENT_ROLE_ID,
  type AgentConsentDecision,
  type AgentConsentPrompt,
  type AgentConsentState,
  type AgentPendingApproval,
} from "../shared/agentAccess";
import type { ConsentDecision, RequestConsent } from "./agentOAuth";

/** The slice of a BrowserWindow the broker needs (kept small for tests). */
export interface ConsentWindow {
  readonly webContentsId: number;
  onClosed(listener: () => void): void;
  close(): void;
  isDestroyed(): boolean;
  /** Bring the sheet (and the window it's attached to) to the front. */
  focus?(): void;
  /** Push a state change to the approval UI. */
  send?(channel: string, payload: unknown): void;
}

/** Who sent an IPC message: the webContents id and whether it was the main frame. */
export interface ConsentSender {
  webContentsId: number;
  isMainFrame: boolean;
}

interface Pending {
  prompt: AgentConsentPrompt;
  requestedAt: number;
  stale: boolean;
  clientWaiting: () => boolean;
  /** Set once this request's approval window exists. */
  window: ConsentWindow | null;
  finish: (decision: ConsentDecision) => void;
}

const MAX_PENDING = 8;
const STALE_CHECK_MS = 2_000;
export const AGENT_CONSENT_STATE_CHANNEL = "diskhound:agent-consent-state";

/**
 * Native approval for agent logins, ported from PwrGit's ConsentBroker.
 *
 * Only the main frame of the window created for a request can read or
 * decide it. Request ids, the browser waiting page, and the main
 * DiskHound window confer no authority. Closing the window, or the
 * OAuth request expiring, is a deny.
 *
 * Requests are shown one at a time, in order, as a sheet on the main
 * window; the rest wait in `pending()` so Settings can list them. While
 * one is up, the broker checks every 2 s whether the agent is still
 * waiting for the answer and tells the sheet when it isn't (a client
 * that timed out can't receive an approval).
 */
export class ConsentBroker {
  private readonly pendingById = new Map<string, Pending>();
  private readonly queue: string[] = [];
  private showing: string | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly createWindow: () => ConsentWindow | Promise<ConsentWindow>,
    private readonly activeSessionNames: () => string[],
    private readonly onChanged: () => void = () => {},
  ) {}

  request: RequestConsent = async ({ clientName, via, scopes, signal, clientWaiting }) => {
    const denied: ConsentDecision = { decision: "deny", sessionName: "", roleId: "" };
    if (signal.aborted || this.pendingById.size >= MAX_PENDING) return denied;
    // Offer only roles that fit inside what the agent asked for, so the
    // user can never grant more than the client requested.
    const roles = BUILT_IN_MCP_ROLES.filter((role) => role.permissions.every((p) => scopes.includes(p)));
    const names = new Set([
      ...this.activeSessionNames(),
      ...[...this.pendingById.values()].map((pending) => pending.prompt.sessionName),
    ]);
    const base = clientName.slice(0, 180);
    let sessionName = base;
    for (let suffix = 2; names.has(sessionName); suffix++) sessionName = `${base} ${suffix}`;
    const defaultRoleId = roles.some((role) => role.id === DEFAULT_CONSENT_ROLE_ID)
      ? DEFAULT_CONSENT_ROLE_ID
      : roles[roles.length - 1]?.id ?? "";
    const prompt: AgentConsentPrompt = {
      requestId: randomUUID(),
      clientName,
      via,
      sessionName,
      requestedScopes: [...scopes],
      roles: roles.map((role) => ({ ...role, permissions: [...role.permissions] })),
      defaultRoleId,
    };
    return new Promise<ConsentDecision>((resolve) => {
      const id = prompt.requestId;
      const abort = () => finish(denied);
      const finish = (decision: ConsentDecision) => {
        const pending = this.pendingById.get(id);
        if (!pending) return;
        this.pendingById.delete(id);
        const queued = this.queue.indexOf(id);
        if (queued >= 0) this.queue.splice(queued, 1);
        signal.removeEventListener("abort", abort);
        resolve(decision);
        if (pending.window && !pending.window.isDestroyed()) pending.window.close();
        if (this.showing === id) {
          this.showing = null;
          void this.showNext();
        } else {
          this.pushShowingState();
        }
        this.onChanged();
      };
      this.pendingById.set(id, {
        prompt,
        requestedAt: Date.now(),
        stale: false,
        clientWaiting,
        window: null,
        finish,
      });
      signal.addEventListener("abort", abort, { once: true });
      this.queue.push(id);
      this.onChanged();
      this.pushShowingState();
      if (signal.aborted) abort();
      else void this.showNext();
    });
  };

  /** Open the approval sheet for the oldest waiting request, if none is up. */
  private async showNext(): Promise<void> {
    if (this.showing !== null) return;
    const id = this.queue.shift();
    if (id === undefined) {
      this.stopStaleChecks();
      return;
    }
    const pending = this.pendingById.get(id);
    if (!pending) return this.showNext();
    this.showing = id;
    let window: ConsentWindow;
    try {
      window = await this.createWindow();
    } catch {
      pending.finish({ decision: "deny", sessionName: "", roleId: "" });
      return;
    }
    // Decided or aborted while the window was being made.
    if (!this.pendingById.has(id)) {
      if (!window.isDestroyed()) window.close();
      return;
    }
    pending.window = window;
    window.onClosed(() => pending.finish({ decision: "deny", sessionName: "", roleId: "" }));
    this.startStaleChecks();
  }

  /** The client whose request is shown after the current one. */
  private nextClientName(): string | null {
    for (const id of this.queue) {
      const pending = this.pendingById.get(id);
      if (pending) return pending.prompt.clientName;
    }
    return null;
  }

  private stateOf(pending: Pending): AgentConsentState {
    return { requestId: pending.prompt.requestId, stale: pending.stale, next: this.nextClientName() };
  }

  /** Tell the sheet on screen that the queue behind it changed. */
  private pushShowingState(): void {
    const pending = this.showing ? this.pendingById.get(this.showing) : undefined;
    if (pending?.window) pending.window.send?.(AGENT_CONSENT_STATE_CHANNEL, this.stateOf(pending));
  }

  private startStaleChecks(): void {
    if (this.staleTimer) return;
    this.staleTimer = setInterval(() => this.checkStale(), STALE_CHECK_MS);
    this.staleTimer.unref?.();
  }

  private stopStaleChecks(): void {
    if (!this.staleTimer) return;
    clearInterval(this.staleTimer);
    this.staleTimer = null;
  }

  /** Exposed for tests; the timer calls it every 2 s while a request waits. */
  checkStale(): void {
    let changed = false;
    for (const pending of this.pendingById.values()) {
      const stale = !pending.clientWaiting();
      if (stale === pending.stale) continue;
      pending.stale = stale;
      changed = true;
      pending.window?.send?.(AGENT_CONSENT_STATE_CHANNEL, this.stateOf(pending));
    }
    if (changed) this.onChanged();
    if (this.pendingById.size === 0) this.stopStaleChecks();
  }

  private trusted(sender: ConsentSender): Pending | undefined {
    if (!sender.isMainFrame) return undefined;
    return [...this.pendingById.values()].find(
      (pending) => pending.window !== null && pending.window.webContentsId === sender.webContentsId,
    );
  }

  read(sender: ConsentSender): (AgentConsentPrompt & Omit<AgentConsentState, "requestId">) | null {
    const pending = this.trusted(sender);
    if (!pending) return null;
    const { stale, next } = this.stateOf(pending);
    return { ...pending.prompt, stale, next };
  }

  decide(sender: ConsentSender, request: AgentConsentDecision): { ok: boolean; message?: string } {
    const pending = this.trusted(sender);
    if (!pending || request?.requestId !== pending.prompt.requestId) {
      return { ok: false, message: "Approval is only available in the DiskHound window that asked for it." };
    }
    if (request.decision !== "allow" && request.decision !== "deny") {
      return { ok: false, message: "Unknown decision." };
    }
    if (request.decision === "allow" && (
      typeof request.sessionName !== "string" ||
      !request.sessionName.trim() ||
      request.sessionName.trim().length > 200 ||
      !pending.prompt.roles.some((role) => role.id === request.roleId)
    )) {
      return { ok: false, message: "Enter a Session name and choose one of the offered roles." };
    }
    pending.finish({ decision: request.decision, sessionName: request.sessionName, roleId: request.roleId });
    return { ok: true };
  }

  /** Requests waiting for the user, oldest first (the one on screen first). */
  pending(): AgentPendingApproval[] {
    return [...this.pendingById.values()]
      .sort((a, b) => a.requestedAt - b.requestedAt)
      .map((pending) => ({
        requestId: pending.prompt.requestId,
        clientName: pending.prompt.clientName,
        via: pending.prompt.via,
        requestedAt: pending.requestedAt,
        stale: pending.stale,
      }));
  }

  /** Bring the sheet for the request on screen to the front. */
  focus(): boolean {
    const pending = this.showing ? this.pendingById.get(this.showing) : undefined;
    if (!pending?.window || pending.window.isDestroyed()) return false;
    pending.window.focus?.();
    return true;
  }

  /** Deny one waiting request, e.g. from Settings. */
  dismiss(requestId: string): void {
    this.pendingById.get(requestId)?.finish({ decision: "deny", sessionName: "", roleId: "" });
  }

  close(): void {
    // Nothing queued may open a sheet while the rest are denied.
    this.queue.length = 0;
    for (const pending of [...this.pendingById.values()]) {
      pending.finish({ decision: "deny", sessionName: "", roleId: "" });
    }
    this.stopStaleChecks();
  }
}
