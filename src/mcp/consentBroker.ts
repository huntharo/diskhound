import { randomUUID } from "node:crypto";

import {
  BUILT_IN_MCP_ROLES,
  DEFAULT_CONSENT_ROLE_ID,
  type AgentConsentDecision,
  type AgentConsentPrompt,
} from "../shared/agentAccess";
import type { ConsentDecision, RequestConsent } from "./agentOAuth";

/** The slice of a BrowserWindow the broker needs (kept small for tests). */
export interface ConsentWindow {
  readonly webContentsId: number;
  onClosed(listener: () => void): void;
  close(): void;
  isDestroyed(): boolean;
}

/** Who sent an IPC message: the webContents id and whether it was the main frame. */
export interface ConsentSender {
  webContentsId: number;
  isMainFrame: boolean;
}

interface Pending {
  prompt: AgentConsentPrompt;
  window: ConsentWindow;
  finish: (decision: ConsentDecision) => void;
}

const MAX_PENDING = 8;

/**
 * Native approval for agent logins, ported from PwrGit's ConsentBroker.
 *
 * Only the main frame of the window created for a request can read or
 * decide it. Request ids, the browser waiting page, and the main
 * DiskHound window confer no authority. Closing the window, or the
 * OAuth request expiring, is a deny.
 */
export class ConsentBroker {
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly createWindow: () => ConsentWindow,
    private readonly activeSessionNames: () => string[],
  ) {}

  request: RequestConsent = async ({ clientName, scopes, signal }) => {
    const denied: ConsentDecision = { decision: "deny", sessionName: "", roleId: "" };
    if (signal.aborted || this.pending.size >= MAX_PENDING) return denied;
    // Offer only roles that fit inside what the agent asked for, so the
    // user can never grant more than the client requested.
    const roles = BUILT_IN_MCP_ROLES.filter((role) => role.permissions.every((p) => scopes.includes(p)));
    const names = new Set(this.activeSessionNames());
    const base = clientName.slice(0, 180);
    let sessionName = base;
    for (let suffix = 2; names.has(sessionName); suffix++) sessionName = `${base} ${suffix}`;
    const defaultRoleId = roles.some((role) => role.id === DEFAULT_CONSENT_ROLE_ID)
      ? DEFAULT_CONSENT_ROLE_ID
      : roles[roles.length - 1]?.id ?? "";
    const prompt: AgentConsentPrompt = {
      requestId: randomUUID(),
      clientName,
      sessionName,
      requestedScopes: [...scopes],
      roles: roles.map((role) => ({ ...role, permissions: [...role.permissions] })),
      defaultRoleId,
    };
    const window = this.createWindow();
    return new Promise<ConsentDecision>((resolve) => {
      const id = window.webContentsId;
      const abort = () => finish(denied);
      const finish = (decision: ConsentDecision) => {
        if (!this.pending.delete(id)) return;
        signal.removeEventListener("abort", abort);
        resolve(decision);
        if (!window.isDestroyed()) window.close();
      };
      this.pending.set(id, { prompt, window, finish });
      signal.addEventListener("abort", abort, { once: true });
      window.onClosed(abort);
      if (signal.aborted) abort();
    });
  };

  private trusted(sender: ConsentSender): Pending | undefined {
    return sender.isMainFrame ? this.pending.get(sender.webContentsId) : undefined;
  }

  read(sender: ConsentSender): AgentConsentPrompt | null {
    return this.trusted(sender)?.prompt ?? null;
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

  close(): void {
    for (const pending of [...this.pending.values()]) {
      pending.finish({ decision: "deny", sessionName: "", roleId: "" });
    }
  }
}
