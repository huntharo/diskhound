import { createServer, type Server as HttpServer } from "node:http";

import express, { type NextFunction, type Request, type Response } from "express";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { AGENT_ACCESS_HOST, AGENT_ACCESS_PORT, MCP_AGENT_CAPABILITIES, agentAccessMcpUrl } from "../shared/agentAccess";
import { McpPolicyStore, PolicyFileAuthorizer } from "./accessPolicy";
import { AgentOAuth, type RequestConsent } from "./agentOAuth";
import type { AgentActivitySink, DiskhoundAgentBackend } from "./backend";
import { createDiskhoundMcpServer } from "./server";
import type { SkillCatalog } from "./skills";

export interface AgentAccessServerOptions {
  backend: DiskhoundAgentBackend;
  activity: AgentActivitySink;
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
