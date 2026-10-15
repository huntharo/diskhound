import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  OAuthClientInformationFullSchema,
  type OAuthClientInformationFull,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { MCP_AGENT_CAPABILITIES, type AgentClientVia, type McpAgentCapability } from "../shared/agentAccess";
import { findRole, isCapability, type McpAuthorization, type McpPolicyStore } from "./accessPolicy";

/**
 * OAuth 2.1 authorization server for local agents, ported from PwrGit /
 * PwrSnap. The shape of the flow:
 *
 *   1. The agent registers itself (RFC 7591 DCR). Registration grants
 *      nothing — every client is public (no secret, PKCE required).
 *   2. `/authorize` opens DiskHound's native approval window and
 *      answers the browser with an inert waiting page. No browser form,
 *      script, or URL parameter can approve access; the page only
 *      polls `/authorize/status` for the decision the native window
 *      makes.
 *   3. After approval the status page 302s to the agent's redirect with
 *      a single-use code, which `/token` exchanges for a bearer token.
 *      Tokens do not expire or refresh; they are revoked in Settings.
 */

const TTL_MS = 5 * 60_000;
const PENDING_LIMIT = 64;

/**
 * A redirect an agent may register. Native clients listen on an
 * ephemeral loopback port (RFC 8252). Anything else would let a
 * registration send the authorization code to another host.
 */
export function isLoopbackRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.hash !== "") return false;
  if (url.port === "") return false;
  const host = url.hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}
/**
 * The waiting client checks /authorize/status every 0.5–1 s (the stdio
 * helper and the browser page). Silence this long means it gave up,
 * usually a client's connect timeout, so an approval now reaches nobody.
 */
const STALE_AFTER_MS = 10_000;
/** software_id the bundled stdio helper registers with. */
export const STDIO_HELPER_SOFTWARE_ID = "diskhound-mcp";
const CLIENT_LIMIT = 256;
const opaque = () => randomBytes(32).toString("base64url");

/**
 * Scopes for a client that doesn't ask for any. The requested scopes
 * only cap the Session; the user picks the actual role in the approval
 * window (and can change it later in Settings within that cap), so a
 * client that omits `scope` gets the full menu rather than being stuck
 * read-only until it re-authenticates.
 */
const DEFAULT_SCOPES: McpAgentCapability[] = [...MCP_AGENT_CAPABILITIES];

export interface ConsentRequest {
  clientName: string;
  via: AgentClientVia;
  scopes: McpAgentCapability[];
  signal: AbortSignal;
  /** False once the waiting client stops checking for the decision. */
  clientWaiting: () => boolean;
}
export interface ConsentDecision {
  decision: "allow" | "deny";
  sessionName: string;
  roleId: string;
}
export type RequestConsent = (request: ConsentRequest) => Promise<ConsentDecision>;

class Clients implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  /** Client ids that already have a Session. Only these are written to disk. */
  private readonly durable = new Set<string>();
  private persisted = "";

  constructor(private readonly file: string, private readonly policy: McpPolicyStore) {
    try {
      const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(saved) || saved.length > CLIENT_LIMIT) throw new Error("Invalid OAuth client store");
      const approved = this.liveClientIds();
      let dropped = false;
      for (const value of saved) {
        const client = OAuthClientInformationFullSchema.parse(value);
        if (!approved.has(client.client_id) || !client.redirect_uris?.every(isLoopbackRedirectUri)) {
          dropped = true;
          continue;
        }
        this.clients.set(client.client_id, client);
        this.durable.add(client.client_id);
      }
      const body = this.serialize();
      // Drop unapproved rows and public redirects left by older builds.
      if (dropped) this.write(body);
      else this.persisted = body;
    } catch (cause) {
      // A corrupt store only costs agents a re-registration; don't let it
      // stop the listener from starting.
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") this.clients.clear();
    }
  }

  getClient(id: string) {
    return this.clients.get(id);
  }

  /** Remember a client once its Session exists, so the next launch can find it. */
  retain(clientId: string) {
    if (!this.clients.has(clientId)) return;
    this.durable.add(clientId);
    this.write(this.serialize());
  }

  registerClient: NonNullable<OAuthRegisteredClientsStore["registerClient"]> = async (input) => {
    const redirects = input.redirect_uris ?? [];
    if (redirects.length === 0 || !redirects.every(isLoopbackRedirectUri)) {
      throw new InvalidRequestError("redirect_uris must be http loopback URLs with an explicit port");
    }
    const client: OAuthClientInformationFull = {
      ...input,
      client_id: opaque(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    };
    delete client.client_secret;
    delete client.client_secret_expires_at;
    if (this.clients.size >= CLIENT_LIMIT) {
      // Pending registrations go first. Approved records stay until their
      // sessions are gone: Settings can forget revoked sessions without
      // restarting the listener, and `durable` would otherwise hold those
      // slots until the next launch.
      let evict = this.evictableClientId();
      if (evict === undefined) {
        this.releaseForgotten();
        evict = this.evictableClientId();
      }
      if (this.clients.size >= CLIENT_LIMIT) {
        if (evict === undefined) throw new InvalidRequestError("OAuth client limit reached");
        this.clients.delete(evict);
      }
    }
    this.clients.set(client.client_id, client);
    // Unapproved registrations stay in memory. A restart drops them,
    // and the agent registers again. The file is written in retain().
    return client;
  };

  /** Client ids that still have a session, including a revoked one. */
  private liveClientIds(): Set<string> {
    return new Set(
      this.policy.sessions().map((session) => session.oauth?.clientId).filter((id): id is string => Boolean(id)),
    );
  }

  /**
   * Drop client records whose sessions were forgotten. Revoked sessions
   * still count; Forget revoked is what removes them.
   */
  private releaseForgotten() {
    const live = this.liveClientIds();
    let released = false;
    for (const id of this.durable) {
      if (live.has(id)) continue;
      this.durable.delete(id);
      this.clients.delete(id);
      released = true;
    }
    if (released) this.write(this.serialize());
  }

  private evictableClientId(): string | undefined {
    return [...this.clients.keys()].find((id) => !this.durable.has(id));
  }

  private serialize(): string {
    const kept = [...this.clients.values()].filter((client) => this.durable.has(client.client_id));
    return JSON.stringify(kept);
  }

  private write(body: string) {
    if (body === this.persisted) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, body, { mode: 0o600 });
    renameSync(temporary, this.file);
    this.persisted = body;
  }
}

interface IssuedCode {
  clientId: string;
  params: AuthorizationParams;
  decision: ConsentDecision;
  scopes: McpAgentCapability[];
  expires: number;
}
interface BrowserApproval {
  controller: AbortController;
  expires: number;
  redirect?: string;
  /** Last time the client asked for the decision (or started the request). */
  lastPolledAt: number;
  clientName: string;
  /** Same client, PKCE challenge, state and redirect: the same login. */
  key: string;
}

function clientVia(client: OAuthClientInformationFull): AgentClientVia {
  return client.software_id === STDIO_HELPER_SOFTWARE_ID ? "stdio" : "http";
}

function clientLabel(client: OAuthClientInformationFull): string {
  return client.client_name?.trim().slice(0, 200) || "Local MCP client";
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export class AgentOAuth implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly clients: Clients;
  private readonly codes = new Map<string, IssuedCode>();
  private readonly approvals = new Map<string, BrowserApproval>();

  constructor(private readonly options: {
    policy: McpPolicyStore;
    clientsFile: string;
    resource: URL;
    requestConsent: RequestConsent;
    onChanged: () => void;
  }) {
    this.clients = new Clients(options.clientsFile, options.policy);
    this.clientsStore = this.clients;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, response: Response): Promise<void> {
    this.prune();
    this.validateResource(params.resource);
    if (!isLoopbackRedirectUri(params.redirectUri) || !client.redirect_uris?.includes(params.redirectUri)) {
      throw new InvalidRequestError("redirect_uri must be a registered http loopback URL");
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) {
      throw new InvalidRequestError("A valid S256 code challenge is required");
    }
    const scopes = params.scopes?.length ? params.scopes : DEFAULT_SCOPES;
    if (!scopes.every(isCapability)) throw new InvalidScopeError("Unknown DiskHound permission");
    // A reloaded tab, or a client that opens the URL itself and prints
    // it too, is the same login: show its waiting page again rather
    // than queue a second approval the user has to deny.
    const key = [client.client_id, params.codeChallenge, params.state ?? "", params.redirectUri].join("\n");
    for (const [existingId, existing] of this.approvals) {
      if (existing.key !== key) continue;
      existing.lastPolledAt = Date.now();
      this.waitingPage(response, existingId, existing.clientName);
      return;
    }
    if (this.approvals.size >= PENDING_LIMIT || this.codes.size >= PENDING_LIMIT) {
      throw new InvalidRequestError("Too many pending approvals");
    }
    const id = opaque();
    const record: BrowserApproval = {
      controller: new AbortController(),
      expires: Date.now() + TTL_MS,
      lastPolledAt: Date.now(),
      clientName: clientLabel(client),
      key,
    };
    this.approvals.set(id, record);
    const timer = setTimeout(() => {
      record.controller.abort();
      this.approvals.delete(id);
    }, TTL_MS);
    timer.unref();

    const finish = (decision: ConsentDecision) => {
      clearTimeout(timer);
      if (record.controller.signal.aborted || Date.now() >= record.expires) return;
      const callback = new URL(params.redirectUri);
      if (params.state !== undefined) callback.searchParams.set("state", params.state);
      const role = findRole(decision.roleId);
      const name = decision.sessionName.trim();
      if (
        decision.decision !== "allow" || !role ||
        name.length === 0 || name.length > 200 ||
        !role.permissions.every((permission) => scopes.includes(permission))
      ) {
        callback.searchParams.set("error", "access_denied");
      } else {
        const code = opaque();
        this.codes.set(code, {
          clientId: client.client_id,
          params,
          decision: { ...decision, sessionName: name },
          // Keep what the client asked for, not just the chosen role:
          // Settings can move the Session to a bigger role later, and
          // this is the ceiling for that.
          scopes: [...scopes] as McpAgentCapability[],
          expires: Date.now() + TTL_MS,
        });
        callback.searchParams.set("code", code);
      }
      record.redirect = callback.href;
    };

    void this.options.requestConsent({
      clientName: record.clientName,
      via: clientVia(client),
      scopes: scopes as McpAgentCapability[],
      signal: record.controller.signal,
      clientWaiting: () => Date.now() - record.lastPolledAt < STALE_AFTER_MS,
    })
      .then(finish)
      .catch(() => finish({ decision: "deny", sessionName: "", roleId: "" }));
    this.waitingPage(response, id, record.clientName);
  }

  status(id: string, response: Response): void {
    this.prune();
    const record = this.approvals.get(id);
    if (!record) {
      response.status(404).type("text").send("Approval expired. Start a new DiskHound login from your agent.");
      return;
    }
    record.lastPolledAt = Date.now();
    if (!record.redirect) {
      this.waitingPage(response, id, record.clientName);
      return;
    }
    this.approvals.delete(id);
    response.setHeader("Cache-Control", "no-store");
    response.redirect(302, record.redirect);
  }

  /**
   * The requester gave up before the user decided (the stdio helper's
   * client hung up). Withdraw the request so its approval sheet closes
   * rather than waiting to be denied. Knowing the opaque id is the
   * permission; once decided, there is nothing left to withdraw.
   */
  cancel(id: string): void {
    const record = this.approvals.get(id);
    if (!record || record.redirect) return;
    this.approvals.delete(id);
    record.controller.abort();
  }

  private waitingPage(response: Response, id: string, clientName: string) {
    // No browser form or script can approve access. The opaque status
    // URL only retrieves a PKCE-bound redirect after the native window
    // has decided.
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    response.type("html").send(
      `<!doctype html><html><head><meta charset="utf-8">` +
        `<meta http-equiv="refresh" content="1;url=/authorize/status?id=${id}">` +
        `<title>Continue in DiskHound</title>` +
        `<style>body{font:15px/1.5 -apple-system,Segoe UI,sans-serif;background:#0a0a0f;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0}main{max-width:420px;text-align:center}h1{font-size:20px;color:#f59e0b}</style>` +
        `</head><body><main><h1>Continue in DiskHound</h1>` +
        `<p><strong>${escapeHtml(clientName)}</strong> is waiting for your approval. Choose what it may do in the DiskHound window. This page updates on its own once you decide.</p>` +
        `</main></body></html>`,
    );
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.requireCode(client, code).params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirect?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.requireCode(client, code);
    if (redirect !== record.params.redirectUri) throw new InvalidGrantError("Redirect does not match");
    this.validateResource(resource);
    this.codes.delete(code);
    const role = findRole(record.decision.roleId);
    if (!role || !role.permissions.every((permission) => record.scopes.includes(permission))) {
      throw new InvalidGrantError("Approved role changed; authorize again");
    }
    const issued = this.options.policy.createSession(
      record.decision.sessionName,
      record.decision.roleId,
      { clientId: client.client_id, scopes: record.scopes },
      { name: clientLabel(client), via: clientVia(client) },
    );
    this.clients.retain(client.client_id);
    this.options.onChanged();
    return { access_token: issued.token, token_type: "bearer", scope: record.scopes.join(" ") };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new InvalidGrantError("DiskHound tokens do not expire or refresh");
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const auth = this.authorizeToken(token);
    return { token, clientId: auth.oauthClientId!, scopes: [...auth.capabilities], resource: this.options.resource };
  }

  /** The OAuth session a bearer token belongs to, from one read of the policy file. */
  authorizeToken(token: string): McpAuthorization {
    try {
      const auth = this.options.policy.authorize(token);
      if (!auth.oauthClientId) throw new Error("OAuth Session required");
      return auth;
    } catch {
      throw new InvalidTokenError("Invalid or revoked DiskHound Session");
    }
  }

  async revokeToken(client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    try {
      const auth = this.options.policy.authorize(request.token);
      if (auth.oauthClientId === client.client_id) {
        this.options.policy.revokeSession(auth.sessionId);
        this.options.onChanged();
      }
    } catch {
      /* RFC 7009: unknown or already-revoked tokens also succeed. */
    }
  }

  close() {
    for (const record of this.approvals.values()) record.controller.abort();
    this.approvals.clear();
    this.codes.clear();
  }

  private validateResource(resource?: URL) {
    if (resource?.href !== this.options.resource.href) {
      throw new InvalidTargetError(`resource must be ${this.options.resource.href}`);
    }
  }

  private requireCode(client: OAuthClientInformationFull, code: string): IssuedCode {
    this.prune();
    const record = this.codes.get(code);
    if (!record || record.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    return record;
  }

  private prune() {
    const now = Date.now();
    for (const [id, record] of this.codes) if (record.expires <= now) this.codes.delete(id);
    for (const [id, record] of this.approvals) {
      if (record.expires <= now) {
        record.controller.abort();
        this.approvals.delete(id);
      }
    }
  }
}

export const SUPPORTED_SCOPES: readonly string[] = MCP_AGENT_CAPABILITIES;
