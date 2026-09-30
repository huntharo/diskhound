import { createServer, type Server as HttpServer } from "node:http";

import express, { type NextFunction, type Request, type Response } from "express";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { AGENT_ACCESS_HOST, AGENT_ACCESS_PORT, MCP_AGENT_CAPABILITIES, agentAccessMcpUrl } from "../shared/agentAccess";
import { McpPolicyStore, PolicyFileAuthorizer, type McpAuthorization } from "./accessPolicy";
import { AgentOAuth, type RequestConsent } from "./agentOAuth";
import type { AgentActivitySink, DiskhoundAgentBackend } from "./backend";
import type { AgentSecuritySink } from "./securityLog";
import { createDiskhoundMcpServer, TOOL_CAPABILITIES, toolActionText } from "./server";
import type { SkillCatalog } from "./skills";

/**
 * The session's permissions on every /mcp response. The stdio helper
 * compares it between calls and tells its client to reload the tool
 * list (notifications/tools/list_changed) when a role changes.
 */
export const CAPABILITIES_HEADER = "DiskHound-Capabilities";

export interface AgentAccessServerOptions {
  backend: DiskhoundAgentBackend;
  activity: AgentActivitySink;
  security?: AgentSecuritySink;
  skills: SkillCatalog;
  policy: McpPolicyStore;
  clientsFile: string;
  requestConsent: RequestConsent;
  onChanged: () => void;
  /** Tests pass 0 for an ephemeral port. */
  port?: number;
}

/** Per-token queue depth before we answer 429. */
const MAX_PENDING_PER_TOKEN = 16;

/**
 * Loopback-only MCP endpoint with its own OAuth authorization server.
 *
 * Ported from PwrGit's AgentAccessServer with PwrSnap's refinements:
 *   - Host must equal the bound `127.0.0.1:<port>` exactly (DNS
 *     rebinding), the TCP peer must be loopback, and any Origin must be
 *     a loopback origin. Checked before every route.
 *   - `/mcp` is POST-only and says so before auth. Claude Code and
 *     Codex open a GET stream on connect; letting the SDK accept it
 *     leaves a never-ending response pinned to the process.
 *   - Stateless Streamable HTTP: one short-lived McpServer per POST,
 *     bound to that request's bearer token. DiskHound keeps no
 *     per-agent state between calls, so there is nothing to reclaim
 *     when a Session is revoked.
 */
export class AgentAccessServer {
  private http: HttpServer | undefined;
  private oauth: AgentOAuth | undefined;
  private boundPort: number;
  private readonly pendingByToken = new Map<string, number>();
  /** One per in-flight /mcp request; stop() aborts them all. */
  private readonly inFlight = new Set<AbortController>();

  constructor(private readonly options: AgentAccessServerOptions) {
    this.boundPort = options.port ?? AGENT_ACCESS_PORT;
  }

  get port(): number {
    return this.boundPort;
  }
  get mcpUrl(): string {
    return agentAccessMcpUrl(this.boundPort);
  }
  get listening(): boolean {
    return this.http?.listening === true;
  }

  async start(): Promise<void> {
    if (this.http) return;
    const app = express();
    app.disable("x-powered-by");
    app.use((req, res, next) => {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        res.status(403).json({ error: "non_loopback_client" });
        return;
      }
      if (req.headers.host !== `${AGENT_ACCESS_HOST}:${this.boundPort}` || !allowedOrigin(req.headers.origin)) {
        res.status(403).json({ error: "forbidden_origin" });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      next();
    });

    const http = createServer(app);
    this.http = http;
    try {
      await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(this.boundPort, AGENT_ACCESS_HOST, () => {
          http.off("error", reject);
          const address = http.address();
          if (address && typeof address !== "string") this.boundPort = address.port;
          resolve();
        });
      });

      const resource = new URL(this.mcpUrl);
      const issuer = new URL(resource.origin);
      const oauth = new AgentOAuth({
        policy: this.options.policy,
        clientsFile: this.options.clientsFile,
        resource,
        requestConsent: this.options.requestConsent,
        onChanged: this.options.onChanged,
      });
      this.oauth = oauth;

      app.get("/authorize/status", (req, res) => {
        oauth.status(typeof req.query.id === "string" ? req.query.id : "", res);
      });
      // The stdio helper withdraws its request when its client hangs up.
      // The same answer either way, so it reveals nothing about ids.
      app.post("/authorize/cancel", express.urlencoded({ extended: false, limit: "1kb" }), (req, res) => {
        const id = (req.body as { id?: unknown } | undefined)?.id;
        oauth.cancel(typeof id === "string" ? id : "");
        res.status(204).end();
      });
      app.all("/authorize", (req, res, next) => {
        if (req.method !== "GET") {
          res.setHeader("Allow", "GET");
          res.status(405).end();
          return;
        }
        // URL parameters can request authorization, never decide it.
        if (["decision", "diskhound_decision", "approve", "consent_transaction"].some((key) => key in req.query)) {
          res.status(400).json({ error: "invalid_request" });
          return;
        }
        next();
      });
      app.use("/authorize", authorizationHandler({ provider: oauth }));
      app.use("/register", clientRegistrationHandler({ clientsStore: oauth.clientsStore, clientIdGeneration: false }));
      app.use("/token", tokenHandler({ provider: oauth }));
      app.use("/revoke", revocationHandler({ provider: oauth }));
      app.use(mcpAuthMetadataRouter({
        resourceServerUrl: resource,
        resourceName: "DiskHound",
        scopesSupported: [...MCP_AGENT_CAPABILITIES],
        oauthMetadata: {
          issuer: issuer.href,
          authorization_endpoint: new URL("/authorize", issuer).href,
          token_endpoint: new URL("/token", issuer).href,
          registration_endpoint: new URL("/register", issuer).href,
          revocation_endpoint: new URL("/revoke", issuer).href,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          token_endpoint_auth_methods_supported: ["none"],
          revocation_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: [...MCP_AGENT_CAPABILITIES],
        },
      }));
      app.all("/mcp", (req, res, next) => {
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          res.status(405).json({ error: "method_not_allowed" });
          return;
        }
        next();
      });
      app.post("/mcp", express.json({ limit: "256kb" }), (req, res, next) => {
        void this.handleMcp(req, res, oauth).catch(next);
      });
      app.use((_req, res) => {
        res.status(404).json({ error: "not_found" });
      });
      // Last: never fall back to Express's HTML error page (with stack).
      app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        const status = (error as { status?: number }).status;
        if (res.headersSent) {
          res.end();
          return;
        }
        res.status(status === 413 ? 413 : status === 400 ? 400 : 500).json({ error: "request_failed" });
      });
    } catch (cause) {
      await this.stop();
      throw cause;
    }
  }

  private async handleMcp(req: Request, res: Response, oauth: AgentOAuth): Promise<void> {
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization?.trim() ?? "")?.[1];
    try {
      if (!token) throw new Error("missing token");
      await oauth.verifyAccessToken(token);
    } catch {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${new URL(this.mcpUrl).origin}/.well-known/oauth-protected-resource/mcp", ` +
          `scope="${MCP_AGENT_CAPABILITIES.join(" ")}"`,
      );
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    // What this session may do right now decides which tools the
    // per-request server registers. Tool calls re-check on their own.
    let session: McpAuthorization;
    try {
      session = this.options.policy.authorize(token);
    } catch {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.setHeader(CAPABILITIES_HEADER, [...session.capabilities].sort().join(","));
    if (this.refuseHiddenTool(req.body, session, res)) return;

    const pending = this.pendingByToken.get(token) ?? 0;
    if (pending >= MAX_PENDING_PER_TOKEN) {
      res.status(429).json({ error: "too_many_requests" });
      return;
    }
    this.pendingByToken.set(token, pending + 1);
    // A trash request can wait minutes for its dialog. If the agent hangs
    // up or the server stops (closeAllConnections), drop it rather than
    // ask the user on behalf of nobody.
    const closed = new AbortController();
    this.inFlight.add(closed);
    res.once("close", () => {
      if (!res.writableFinished) closed.abort();
    });
    const mcp = createDiskhoundMcpServer({
      backend: this.options.backend,
      activity: this.options.activity,
      skills: this.options.skills,
      authorizer: new PolicyFileAuthorizer(this.options.policy, token),
      granted: session.capabilities,
      security: this.options.security,
      signal: closed.signal,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, withDefaultArguments(req.body));
    } finally {
      this.inFlight.delete(closed);
      const left = (this.pendingByToken.get(token) ?? 1) - 1;
      if (left <= 0) this.pendingByToken.delete(token);
      else this.pendingByToken.set(token, left);
      await transport.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
    }
  }

  /**
   * A call to a DiskHound tool this session's role doesn't grant. The
   * tool isn't in the session's tools/list, so the agent has a stale
   * list (its role was lowered) or guessed. Answer it as a failed tool
   * call that says why, and log it for the user.
   */
  private refuseHiddenTool(body: unknown, session: McpAuthorization, res: Response): boolean {
    const message = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { name?: unknown } } | null;
    if (!message || typeof message !== "object" || Array.isArray(message) || message.method !== "tools/call") return false;
    const name = message.params?.name;
    if (typeof name !== "string") return false;
    const required = TOOL_CAPABILITIES[name];
    if (!required) return false;
    const missing = required.filter((capability) => !session.capabilities.includes(capability));
    if (missing.length === 0) return false;
    this.options.security?.record({
      sessionId: session.sessionId,
      sessionName: session.sessionName,
      roleName: session.roleName,
      kind: "tool_not_allowed",
      tool: name,
      detail: `Tried to ${toolActionText(name)}; ${session.roleName} doesn't allow it.`,
    });
    this.options.activity.record({
      sessionId: session.sessionId,
      sessionName: session.sessionName,
      tool: name,
      summary: `Blocked: tried to ${toolActionText(name)} (${session.roleName})`,
      ok: false,
    });
    res.status(200).json({
      jsonrpc: "2.0",
      id: message.id ?? null,
      result: {
        isError: true,
        content: [{
          type: "text",
          text: `${name} isn't available to this DiskHound session (${session.roleName} doesn't grant ${missing.join(", ")}). ` +
            "Nothing was changed, and DiskHound logged the attempt. Ask the user to change this session's role in " +
            "DiskHound → Settings → AI Agents if they want you to do this, then reload your tool list.",
        }],
      },
    });
    return true;
  }

  async stop(): Promise<void> {
    for (const request of this.inFlight) request.abort();
    this.inFlight.clear();
    this.oauth?.close();
    this.oauth = undefined;
    const http = this.http;
    this.http = undefined;
    if (!http) return;
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function allowedOrigin(origin: string | undefined): boolean {
  // CLI agents send no Origin. Browsers must come from loopback;
  // opaque ("null") origins from sandboxed frames fail.
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * `arguments` is optional on tools/call and prompts/get, and rmcp-based
 * clients (Codex) leave it out for tools that take none. SDK 1.30
 * validates it as given, so a missing object fails even when every
 * field is optional. Default it to {} (per message, batches included).
 */
export function withDefaultArguments(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(withDefaultArguments);
  if (!body || typeof body !== "object") return body;
  const message = body as { method?: unknown; params?: Record<string, unknown> };
  if (message.method !== "tools/call" && message.method !== "prompts/get") return body;
  if (!message.params || typeof message.params !== "object" || message.params.arguments !== undefined) return body;
  return { ...message, params: { ...message.params, arguments: {} } };
}
