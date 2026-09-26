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

import { MCP_AGENT_CAPABILITIES, type McpAgentCapability } from "../shared/agentAccess";
import { findRole, isCapability, type McpPolicyStore } from "./accessPolicy";

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
  scopes: McpAgentCapability[];
  signal: AbortSignal;
}
export interface ConsentDecision {
  decision: "allow" | "deny";
  sessionName: string;
  roleId: string;
}
export type RequestConsent = (request: ConsentRequest) => Promise<ConsentDecision>;

class Clients implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  constructor(private readonly file: string, private readonly policy: McpPolicyStore) {
    try {
      const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(saved) || saved.length > CLIENT_LIMIT) throw new Error("Invalid OAuth client store");
      for (const value of saved) {
        const client = OAuthClientInformationFullSchema.parse(value);
        this.clients.set(client.client_id, client);
      }
    } catch (cause) {
      // A corrupt store only costs agents a re-registration; don't let it
      // stop the listener from starting.
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") this.clients.clear();
    }
  }

  getClient(id: string) {
    return this.clients.get(id);
  }

  registerClient: NonNullable<OAuthRegisteredClientsStore["registerClient"]> = async (input) => {
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
      const approved = new Set(
        this.policy.sessions().filter((s) => s.revokedAt === null).map((s) => s.oauth?.clientId),
      );
      const evict = [...this.clients.keys()].find((id) => !approved.has(id));
      if (evict === undefined) throw new InvalidRequestError("OAuth client limit reached");
      this.clients.delete(evict);
    }
    this.clients.set(client.client_id, client);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify([...this.clients.values()]), { mode: 0o600 });
    renameSync(temporary, this.file);
    return client;
  };
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
}

export class AgentOAuth implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly codes = new Map<string, IssuedCode>();
  private readonly approvals = new Map<string, BrowserApproval>();

  constructor(private readonly options: {
    policy: McpPolicyStore;
    clientsFile: string;
    resource: URL;
    requestConsent: RequestConsent;
    onChanged: () => void;
  }) {
    this.clientsStore = new Clients(options.clientsFile, options.policy);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, response: Response): Promise<void> {
    this.prune();
    this.validateResource(params.resource);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) {
      throw new InvalidRequestError("A valid S256 code challenge is required");
    }
    const scopes = params.scopes?.length ? params.scopes : DEFAULT_SCOPES;
    if (!scopes.every(isCapability)) throw new InvalidScopeError("Unknown DiskHound permission");
    if (this.approvals.size >= PENDING_LIMIT || this.codes.size >= PENDING_LIMIT) {
      throw new InvalidRequestError("Too many pending approvals");
    }
    const id = opaque();
    const record: BrowserApproval = { controller: new AbortController(), expires: Date.now() + TTL_MS };
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
      clientName: client.client_name?.trim() || "Local MCP client",
      scopes: scopes as McpAgentCapability[],
      signal: record.controller.signal,
    })
      .then(finish)
      .catch(() => finish({ decision: "deny", sessionName: "", roleId: "" }));
    this.waitingPage(response, id);
  }

  status(id: string, response: Response): void {
    this.prune();
    const record = this.approvals.get(id);
    if (!record) {
      response.status(404).type("text").send("Approval expired. Start a new DiskHound login from your agent.");
      return;
    }
    if (!record.redirect) {
      this.waitingPage(response, id);
      return;
    }
    this.approvals.delete(id);
    response.setHeader("Cache-Control", "no-store");
    response.redirect(302, record.redirect);
  }

  private waitingPage(response: Response, id: string) {
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
        `<p>Review the Session name and permissions in DiskHound’s approval window. This page updates on its own once you decide.</p>` +
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
    const issued = this.options.policy.createSession(record.decision.sessionName, record.decision.roleId, {
      clientId: client.client_id,
      scopes: record.scopes,
    });
    this.options.onChanged();
    return { access_token: issued.token, token_type: "bearer", scope: record.scopes.join(" ") };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new InvalidGrantError("DiskHound tokens do not expire or refresh");
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const auth = this.options.policy.authorize(token);
      const session = this.options.policy.sessions().find((s) => s.id === auth.sessionId);
      if (!session?.oauth) throw new Error("OAuth Session required");
      return { token, clientId: session.oauth.clientId, scopes: [...auth.capabilities], resource: this.options.resource };
    } catch {
      throw new InvalidTokenError("Invalid or revoked DiskHound Session");
    }
  }

  async revokeToken(client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    try {
      const auth = this.options.policy.authorize(request.token);
      const session = this.options.policy.sessions().find((s) => s.id === auth.sessionId);
      if (session?.oauth?.clientId === client.client_id) {
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
