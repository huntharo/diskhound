import { createHash, randomBytes } from "node:crypto";
import * as FS from "node:fs";
import * as HTTP from "node:http";
import * as NET from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { MCP_AGENT_CAPABILITIES, type McpAgentCapability } from "../../shared/agentAccess";
import { McpPolicyStore } from "../accessPolicy";
import { AgentAccessServer, allowedOrigin, isLoopbackAddress, withDefaultArguments } from "../agentAccessServer";
import { AgentAccessService } from "../agentAccessService";
import type { TrashRequest } from "../backend";
import { ConsentBroker, type ConsentSender, type ConsentWindow } from "../consentBroker";
import { loadSkillCatalog } from "../skills";
import { createFakeBackend, RecordingActivity, SKILLS_DIR, type FakeBackend } from "./fakeBackend";

const SKILLS = loadSkillCatalog(SKILLS_DIR);
const ALL_SCOPES = MCP_AGENT_CAPABILITIES.join(" ");
// Loopback redirect (RFC 8252). Nothing listens here: the test reads the
// 302 Location instead of following it.
const REDIRECT_URI = "http://127.0.0.1:47999/callback";

// ── Consent window stand-in ────────────────────────────────

class FakeConsentWindow implements ConsentWindow {
  private static nextId = 1;
  readonly webContentsId = FakeConsentWindow.nextId++;
  private readonly listeners: (() => void)[] = [];
  private destroyed = false;
  onClosed(listener: () => void) {
    this.listeners.push(listener);
  }
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const listener of this.listeners.splice(0)) listener();
  }
  isDestroyed() {
    return this.destroyed;
  }
  get main(): ConsentSender {
    return { webContentsId: this.webContentsId, isMainFrame: true };
  }
}

// ── Harness ────────────────────────────────────────────────

let tempDir: string;
let policy: McpPolicyStore;
let backend: FakeBackend;
let activity: RecordingActivity;
let windows: FakeConsentWindow[];
let broker: ConsentBroker;
let onChanged: ReturnType<typeof vi.fn<() => void>>;
let server: AgentAccessServer;
let base: string;
let clients: Client[];

beforeEach(async () => {
  tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-agent-server-test-"));
  policy = new McpPolicyStore(Path.join(tempDir, "mcp-policy.json"));
  backend = createFakeBackend();
  activity = new RecordingActivity();
  windows = [];
  broker = new ConsentBroker(
    () => {
      const window = new FakeConsentWindow();
      windows.push(window);
      return window;
    },
    () => policy.sessions().filter((session) => session.revokedAt === null).map((session) => session.name),
  );
  onChanged = vi.fn<() => void>();
  clients = [];
  server = new AgentAccessServer({
    backend,
    activity,
    skills: SKILLS,
    policy,
    clientsFile: Path.join(tempDir, "mcp-oauth-clients.json"),
    requestConsent: broker.request,
    onChanged,
    port: 0,
  });
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  broker.close();
  await server.stop();
  FS.rmSync(tempDir, { recursive: true, force: true });
});

// ── HTTP helpers ───────────────────────────────────────────

interface RawResponse {
  status: number;
  headers: HTTP.IncomingHttpHeaders;
  body: string;
}

/** node:http so the test controls Host and Origin exactly (fetch owns Host). */
function rawRequest(options: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = HTTP.request(
      {
        host: "127.0.0.1",
        port: server.port,
        method: options.method ?? "GET",
        path: options.path,
        headers: { host: `127.0.0.1:${server.port}`, ...options.headers },
        agent: false,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
});
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function register(name = "Test Agent CLI", redirectUris = [REDIRECT_URI]): Promise<{ client_id: string } & Record<string, unknown>> {
  const response = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { client_id: string };
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string | undefined> = {}): URL {
  const url = new URL(`${base}/authorize`);
  const params: Record<string, string | undefined> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    resource: server.mcpUrl,
    scope: ALL_SCOPES,
    ...extra,
  };
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url;
}

/** GET /authorize and return the approval id from the waiting page. */
async function openApproval(url: URL): Promise<string> {
  const response = await fetch(url, { redirect: "manual" });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  const html = await response.text();
  expect(html).toContain("Continue in DiskHound");
  expect(html).not.toMatch(/<script|<form/i);
  const id = /url=\/authorize\/status\?id=([A-Za-z0-9_-]+)/.exec(html)?.[1];
  expect(id).toBeTruthy();
  return id!;
}

/** Poll the waiting page's status URL until DiskHound has decided. */
async function waitForRedirect(id: string, timeoutMs = 3_000): Promise<URL> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/authorize/status?id=${id}`, { redirect: "manual" });
    if (response.status === 302) return new URL(response.headers.get("location")!);
    expect(response.status).toBe(200);
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the approval redirect");
}

function latestWindow(): FakeConsentWindow {
  const window = windows.at(-1);
  if (!window) throw new Error("no consent window was opened");
  return window;
}

/** What the user does in the native approval window. */
function approve(roleId: string, sessionName = "My Agent"): void {
  const window = latestWindow();
  const prompt = broker.read(window.main);
  if (!prompt) throw new Error("consent window has no prompt");
  expect(broker.decide(window.main, { requestId: prompt.requestId, decision: "allow", sessionName, roleId })).toEqual({ ok: true });
}

function exchange(params: Record<string, string>): Promise<Response> {
  return fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

/** Full manual OAuth dance. Returns the bearer token. */
async function login(roleId = "builtin.guide", scope = ALL_SCOPES, sessionName = "My Agent"): Promise<{ token: string; clientId: string }> {
  const { client_id: clientId } = await register();
  const { verifier, challenge } = pkce();
  const id = await openApproval(authorizeUrl(clientId, challenge, { scope }));
  approve(roleId, sessionName);
  const callback = await waitForRedirect(id);
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();
  const response = await exchange({
    grant_type: "authorization_code",
    code: code!,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    resource: server.mcpUrl,
  });
  expect(response.status).toBe(200);
  const tokens = (await response.json()) as OAuthTokens;
  return { token: tokens.access_token, clientId };
}

async function mcpClient(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "diskhound-http-test", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function text(result: CallToolResult): string {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
}

// ── Tests ──────────────────────────────────────────────────

describe("AgentAccessServer basics", () => {
  it("binds an ephemeral loopback port when given port 0", () => {
    expect(server.listening).toBe(true);
    expect(server.port).toBeGreaterThan(0);
    expect(server.mcpUrl).toBe(`http://127.0.0.1:${server.port}/mcp`);
  });

  it("stops cleanly and can be stopped twice", async () => {
    await server.stop();
    expect(server.listening).toBe(false);
    await server.stop();
  });

  it("restarts on the same port and keeps registered clients across instances", async () => {
    const { client_id: clientId } = await register();
    const port = server.port;
    await server.stop();
    await server.start();
    expect(server.port).toBe(port);

    // A fresh instance (an app relaunch) reads the persisted client store.
    await server.stop();
    server = new AgentAccessServer({
      backend,
      activity,
      skills: SKILLS,
      policy,
      clientsFile: Path.join(tempDir, "mcp-oauth-clients.json"),
      requestConsent: broker.request,
      onChanged,
      port: 0,
    });
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
    await openApproval(authorizeUrl(clientId, pkce().challenge));
    expect(broker.read(latestWindow().main)?.clientName).toBe("Test Agent CLI");
  });
});

describe("AgentAccessService", () => {
  function service(port: number, saveEnabled = vi.fn<(enabled: boolean) => void>()) {
    return {
      saveEnabled,
      service: new AgentAccessService({
        backend,
        activity,
        skills: SKILLS,
        policy,
        clientsFile: Path.join(tempDir, "mcp-oauth-clients.json"),
        requestConsent: broker.request,
        onChanged,
        port,
        saveEnabled,
      }),
    };
  }

  it("turns the listener on and off, persisting the setting", async () => {
    const { service: access, saveEnabled } = service(0);
    const on = await access.setEnabled(true);
    expect(on).toMatchObject({ enabled: true, listening: true });
    expect(on.port).toBeGreaterThan(0);
    expect(on.mcpUrl).toBe(`http://127.0.0.1:${on.port}/mcp`);
    expect(on.error).toBeUndefined();

    const off = await access.setEnabled(false);
    expect(off).toMatchObject({ enabled: false, listening: false });
    expect(saveEnabled.mock.calls).toEqual([[true], [false]]);

    // Serialized: a fast on → off → on ends listening.
    const results = await Promise.all([access.setEnabled(true, false), access.setEnabled(false, false), access.setEnabled(true, false)]);
    expect(results.map((status) => status.listening)).toEqual([true, false, true]);
    expect(access.status().listening).toBe(true);
    expect(saveEnabled).toHaveBeenCalledTimes(2);
    await access.dispose();
    expect(access.status().listening).toBe(false);
  });

  it("reports a busy port instead of throwing", async () => {
    const blocker = NET.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as NET.AddressInfo).port;
    try {
      const { service: access } = service(port);
      const status = await access.setEnabled(true);
      expect(status).toMatchObject({ enabled: true, listening: false, port });
      expect(status.error).toContain(`Port ${port} is already in use`);
      await access.dispose();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("request guards", () => {
  it("answers an unauthenticated POST /mcp with 401 and a discovery challenge", async () => {
    const response = await rawRequest({ method: "POST", path: "/mcp", headers: MCP_HEADERS, body: INITIALIZE });
    expect(response.status).toBe(401);
    const challenge = response.headers["www-authenticate"] ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    expect(challenge).toContain(`scope="${ALL_SCOPES}"`);
    expect(JSON.parse(response.body)).toEqual({ error: "unauthorized" });
  });

  it("rejects an unknown bearer token with 401", async () => {
    const response = await rawRequest({
      method: "POST",
      path: "/mcp",
      headers: { ...MCP_HEADERS, authorization: "Bearer dhmcp_not-a-real-token" },
      body: INITIALIZE,
    });
    expect(response.status).toBe(401);
  });

  it("answers GET and DELETE /mcp with 405 before checking auth", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await rawRequest({ method, path: "/mcp", headers: { accept: "text/event-stream" } });
      expect(response.status, method).toBe(405);
      expect(response.headers.allow).toBe("POST");
      expect(response.headers["www-authenticate"]).toBeUndefined();
    }
  });

  it("rejects a Host header that is not the bound 127.0.0.1:<port>", async () => {
    for (const host of ["localhost:" + server.port, "evil.example", `127.0.0.1:${server.port + 1}`, "127.0.0.1"]) {
      const response = await rawRequest({ path: "/.well-known/oauth-authorization-server", headers: { host } });
      expect(response.status, host).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: "forbidden_origin" });
    }
  });

  it("rejects non-loopback and opaque Origins but allows loopback ones", async () => {
    for (const origin of ["https://evil.example", "http://127.0.0.1.evil.example", "null", "file://", "chrome-extension://abc"]) {
      const response = await rawRequest({ path: "/.well-known/oauth-authorization-server", headers: { origin } });
      expect(response.status, origin).toBe(403);
    }
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:3000", "https://[::1]:8443"]) {
      const response = await rawRequest({ path: "/.well-known/oauth-authorization-server", headers: { origin } });
      expect(response.status, origin).toBe(200);
    }
    // Also enforced on /mcp, before auth.
    const mcp = await rawRequest({ method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, origin: "https://evil.example" }, body: INITIALIZE });
    expect(mcp.status).toBe(403);
  });

  it("answers unknown routes and malformed bodies with JSON, never an HTML stack page", async () => {
    const missing = await rawRequest({ path: "/nope" });
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body)).toEqual({ error: "not_found" });

    const malformed = await rawRequest({ method: "POST", path: "/mcp", headers: MCP_HEADERS, body: "{not json" });
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)).toEqual({ error: "request_failed" });
    expect(malformed.body).not.toContain("at ");
  });

  it("defaults a missing `arguments` only on tools/call and prompts/get", () => {
    expect(withDefaultArguments({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } }))
      .toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", arguments: {} } });
    const given = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x", arguments: { a: 1 } } };
    expect(withDefaultArguments(given)).toBe(given);
    const other = { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} };
    expect(withDefaultArguments(other)).toBe(other);
    expect(withDefaultArguments([{ method: "prompts/get", params: { name: "p" } }, "junk"]))
      .toEqual([{ method: "prompts/get", params: { name: "p", arguments: {} } }, "junk"]);
    expect(withDefaultArguments(undefined)).toBeUndefined();
  });

  it("helper predicates accept only loopback peers and origins", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.2")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(allowedOrigin(undefined)).toBe(true);
    expect(allowedOrigin("http://localhost")).toBe(true);
    expect(allowedOrigin("ftp://localhost")).toBe(false);
    expect(allowedOrigin("not a url")).toBe(false);
  });
});

describe("OAuth metadata", () => {
  it("serves protected resource metadata at the path-aware well-known URL", async () => {
    const response = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: server.mcpUrl,
      authorization_servers: [`${base}/`],
      scopes_supported: [...MCP_AGENT_CAPABILITIES],
      resource_name: "DiskHound",
    });
  });

  it("serves authorization server metadata for a public-client, PKCE-only server", async () => {
    const response = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      issuer: `${base}/`,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [...MCP_AGENT_CAPABILITIES],
    });
  });
});

describe("OAuth flow", () => {
  it("registers public clients only and persists them 0600", async () => {
    const response = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Secretive", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "client_secret_post" }),
    });
    expect(response.status).toBe(201);
    const client = (await response.json()) as Record<string, unknown>;
    expect(client.client_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(client.client_secret).toBeUndefined();
    expect(client.token_endpoint_auth_method).toBe("none");
    expect(client.grant_types).toEqual(["authorization_code"]);

    const file = Path.join(tempDir, "mcp-oauth-clients.json");
    const saved = JSON.parse(FS.readFileSync(file, "utf8")) as { client_id: string }[];
    expect(saved.map((entry) => entry.client_id)).toEqual([client.client_id]);
    expect(FS.readFileSync(file, "utf8")).not.toContain("client_secret\"");
    if (process.platform !== "win32") expect(FS.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("walks DCR → authorize → native approval → token → MCP tools", async () => {
    const { client_id: clientId } = await register();
    const { verifier, challenge } = pkce();
    const id = await openApproval(authorizeUrl(clientId, challenge));

    // The native window shows the agent's name and requested scopes.
    const window = latestWindow();
    const prompt = broker.read(window.main)!;
    expect(prompt).toMatchObject({
      clientName: "Test Agent CLI",
      sessionName: "Test Agent CLI",
      requestedScopes: [...MCP_AGENT_CAPABILITIES],
      defaultRoleId: "builtin.guide",
    });

    // Before the user decides, the status URL keeps serving the waiting page.
    const waiting = await fetch(`${base}/authorize/status?id=${id}`, { redirect: "manual" });
    expect(waiting.status).toBe(200);
    await waiting.text();

    approve("builtin.guide", "  My Claude  ");
    const callback = await waitForRedirect(id);
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe("state-123");
    expect(callback.searchParams.get("error")).toBeNull();
    const code = callback.searchParams.get("code")!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The status URL is single-use.
    expect((await fetch(`${base}/authorize/status?id=${id}`, { redirect: "manual" })).status).toBe(404);

    const tokenParams = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource: server.mcpUrl,
    };
    const wrongVerifier = await exchange({ ...tokenParams, code_verifier: pkce().verifier });
    expect(wrongVerifier.status).toBe(400);
    expect(await wrongVerifier.json()).toMatchObject({ error: "invalid_grant" });

    const response = await exchange(tokenParams);
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as OAuthTokens;
    expect(tokens.access_token).toMatch(/^dhmcp_/);
    expect(tokens.token_type.toLowerCase()).toBe("bearer");
    expect(tokens.refresh_token).toBeUndefined();
    expect(onChanged).toHaveBeenCalled();

    // Codes are single-use.
    const replay = await exchange(tokenParams);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });

    // The Session landed in the policy file with the trimmed name and the scope ceiling.
    expect(policy.sessions()).toEqual([
      expect.objectContaining({
        name: "My Claude",
        roleId: "builtin.guide",
        revokedAt: null,
        oauth: { clientId, scopes: [...MCP_AGENT_CAPABILITIES] },
      }),
    ]);

    const client = await mcpClient(tokens.access_token);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("diskhound_status");

    const status = (await client.callTool({ name: "diskhound_status", arguments: {} })) as CallToolResult;
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({
      session: { name: "My Claude", role: "Cleanup Guide", capabilities: ["disk.read", "scan.run", "app.navigate"] },
    });

    const trash = (await client.callTool({ name: "diskhound_move_to_trash", arguments: { paths: ["/Users/test/Downloads/ubuntu.iso"] } })) as CallToolResult;
    expect(trash.isError).toBe(true);
    expect(text(trash)).toContain("files.trash");
    expect(text(trash)).toContain("Settings");
    expect(backend.confirmAndTrash).not.toHaveBeenCalled();

    expect(activity.entries).toEqual([
      expect.objectContaining({ sessionName: "My Claude", tool: "diskhound_status", ok: true }),
      expect.objectContaining({ sessionName: "My Claude", tool: "diskhound_move_to_trash", ok: false }),
    ]);

    // Skills are reachable over HTTP too.
    const skills = await client.readResource({ uri: "skill://diskhound-free-up-space/SKILL.md" });
    expect((skills.contents[0] as { text: string }).text).toContain("name: diskhound-free-up-space");
  });

  it("lets the operator role trash (after the user confirms) and applies role changes on the next call", async () => {
    const { token } = await login("builtin.operator");
    const client = await mcpClient(token);
    const trash = (await client.callTool({ name: "diskhound_move_to_trash", arguments: { paths: ["/tmp/a"] } })) as CallToolResult;
    expect(trash.isError).not.toBe(true);
    expect(backend.confirmAndTrash).toHaveBeenCalledWith(expect.objectContaining({ sessionName: "My Agent", paths: ["/tmp/a"] }));

    const [session] = policy.sessions();
    policy.assignRole(session!.id, "builtin.reader");
    const again = (await client.callTool({ name: "diskhound_move_to_trash", arguments: { paths: ["/tmp/a"] } })) as CallToolResult;
    expect(again.isError).toBe(true);
    expect(backend.confirmAndTrash).toHaveBeenCalledTimes(1);
  });

  it("lets a queued trash request see a revoke, and aborts it when the server stops", async () => {
    const { token } = await login("builtin.operator");
    const client = await mcpClient(token);
    let request: TrashRequest | undefined;
    let dialogUp!: () => void;
    const up = new Promise<void>((resolve) => (dialogUp = resolve));
    backend.confirmAndTrash.mockImplementationOnce((req) => {
      request = req;
      dialogUp();
      // A dialog that stays up until the request is aborted.
      return new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const pending = client
      .callTool({ name: "diskhound_move_to_trash", arguments: { paths: ["/tmp/a"] } })
      .catch((error: unknown) => error);
    await up;

    await expect(request!.recheck!()).resolves.toBeUndefined();
    policy.revokeSession(policy.sessions()[0]!.id);
    await expect(request!.recheck!()).rejects.toMatchObject({ code: "revoked_session" });

    expect(request!.signal!.aborted).toBe(false);
    await server.stop();
    expect(request!.signal!.aborted).toBe(true);
    await pending;
  });

  it("lets the guide role upgrade to operator in Settings when the agent asked for every scope", async () => {
    const { token } = await login("builtin.guide");
    const client = await mcpClient(token);
    const denied = (await client.callTool({ name: "diskhound_move_to_trash", arguments: { paths: ["/tmp/a"] } })) as CallToolResult;
    expect(denied.isError).toBe(true);
    expect(activity.entries.at(-1)).toMatchObject({ tool: "diskhound_move_to_trash", ok: false, sessionName: "My Agent" });

    const [session] = policy.sessions();
    policy.assignRole(session!.id, "builtin.operator");
    const allowed = (await client.callTool({ name: "diskhound_move_to_trash", arguments: { paths: ["/tmp/a"] } })) as CallToolResult;
    expect(allowed.isError).not.toBe(true);
  });

  it("accepts tools/call and prompts/get without `arguments` (rmcp clients omit it)", async () => {
    const { token } = await login("builtin.reader");
    const client = await mcpClient(token);
    const status = (await client.callTool({ name: "diskhound_status" })) as CallToolResult;
    expect(status.isError).not.toBe(true);
    const prompt = await client.getPrompt({ name: "free-up-space" });
    expect(prompt.messages).toHaveLength(2);
  });

  it("caps the Session at the scopes the agent asked for", async () => {
    const { token } = await login("builtin.guide", "disk.read scan.run app.navigate");
    const [session] = policy.sessions();
    expect(session!.oauth?.scopes).toEqual(["disk.read", "scan.run", "app.navigate"]);
    // Settings moves the Session to Operator, but the approved scopes still exclude files.trash.
    policy.assignRole(session!.id, "builtin.operator");
    const client = await mcpClient(token);
    const trash = (await client.callTool({ name: "diskhound_move_to_trash", arguments: { paths: ["/tmp/a"] } })) as CallToolResult;
    expect(trash.isError).toBe(true);
  });

  it("rejects the token on the next request once the Session is revoked", async () => {
    const { token } = await login();
    const ok = await rawRequest({
      method: "POST",
      path: "/mcp",
      headers: { ...MCP_HEADERS, authorization: `Bearer ${token}` },
      body: INITIALIZE,
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ result: { serverInfo: { name: "diskhound" } } });

    policy.revokeSession(policy.sessions()[0]!.id);
    const revoked = await rawRequest({
      method: "POST",
      path: "/mcp",
      headers: { ...MCP_HEADERS, authorization: `Bearer ${token}` },
      body: INITIALIZE,
    });
    expect(revoked.status).toBe(401);
  });

  it("revokes a token through /revoke for the client that owns it", async () => {
    const { token, clientId } = await login();
    const other = await register("Someone Else");
    const wrongClient = await fetch(`${base}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: other.client_id }),
    });
    expect(wrongClient.status).toBe(200);
    expect(policy.sessions()[0]!.revokedAt).toBeNull();

    const response = await fetch(`${base}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: clientId }),
    });
    expect(response.status).toBe(200);
    expect(policy.sessions()[0]!.revokedAt).not.toBeNull();
  });

  it("redirects with error=access_denied when the user denies", async () => {
    const { client_id: clientId } = await register();
    const id = await openApproval(authorizeUrl(clientId, pkce().challenge));
    const window = latestWindow();
    const prompt = broker.read(window.main)!;
    broker.decide(window.main, { requestId: prompt.requestId, decision: "deny", sessionName: "", roleId: "" });
    const callback = await waitForRedirect(id);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe("state-123");
    expect(callback.searchParams.get("code")).toBeNull();
    expect(policy.sessions()).toEqual([]);
  });

  it("treats closing the approval window as a deny", async () => {
    const { client_id: clientId } = await register();
    const id = await openApproval(authorizeUrl(clientId, pkce().challenge));
    latestWindow().close();
    const callback = await waitForRedirect(id);
    expect(callback.searchParams.get("error")).toBe("access_denied");
  });

  it("gives a read-only request only the reader role", async () => {
    const { client_id: clientId } = await register();
    await openApproval(authorizeUrl(clientId, pkce().challenge, { scope: "disk.read" }));
    const prompt = broker.read(latestWindow().main)!;
    expect(prompt.roles.map((role) => role.id)).toEqual(["builtin.reader"]);
    expect(prompt.requestedScopes).toEqual(["disk.read"] satisfies McpAgentCapability[]);
  });

  it("offers every role to a client that asks for no scope", async () => {
    const { client_id: clientId } = await register();
    await openApproval(authorizeUrl(clientId, pkce().challenge, { scope: undefined }));
    expect(broker.read(latestWindow().main)!.requestedScopes).toEqual([...MCP_AGENT_CAPABILITIES]);
  });

  it("refuses authorization requests that can't be satisfied, via the redirect", async () => {
    const { client_id: clientId } = await register();
    // The last flag: whether `state` survives. The SDK's authorize handler
    // only learns `state` after its own schema check, so "plain" PKCE
    // (rejected by that schema) comes back without it.
    const cases: [Record<string, string | undefined>, string, boolean][] = [
      [{ resource: undefined }, "invalid_target", true],
      [{ resource: `${base}/other` }, "invalid_target", true],
      [{ scope: "disk.read root.shell" }, "invalid_scope", true],
      [{ code_challenge: "too-short" }, "invalid_request", true],
      [{ code_challenge_method: "plain" }, "invalid_request", false],
    ];
    for (const [extra, error, keepsState] of cases) {
      const label = JSON.stringify(extra);
      const response = await fetch(authorizeUrl(clientId, pkce().challenge, extra), { redirect: "manual" });
      expect(response.status, label).toBe(302);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin + location.pathname, label).toBe(REDIRECT_URI);
      expect(location.searchParams.get("error"), label).toBe(error);
      if (keepsState) expect(location.searchParams.get("state"), label).toBe("state-123");
    }
    expect(windows).toHaveLength(0);
  });

  it("never lets URL parameters or POSTs decide an approval", async () => {
    const { client_id: clientId } = await register();
    for (const key of ["decision", "approve", "diskhound_decision", "consent_transaction"]) {
      const response = await fetch(authorizeUrl(clientId, pkce().challenge, { [key]: "allow" }), { redirect: "manual" });
      expect(response.status, key).toBe(400);
    }
    const post = await fetch(`${base}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: authorizeUrl(clientId, pkce().challenge).searchParams,
      redirect: "manual",
    });
    expect(post.status).toBe(405);
    expect(windows).toHaveLength(0);

    expect((await fetch(`${base}/authorize/status?id=forged`, { redirect: "manual" })).status).toBe(404);
  });

  it("rejects token requests without the resource or with a different redirect_uri", async () => {
    const { client_id: clientId } = await register();
    const { verifier, challenge } = pkce();
    const id = await openApproval(authorizeUrl(clientId, challenge));
    approve("builtin.reader");
    const code = (await waitForRedirect(id)).searchParams.get("code")!;
    const params = { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT_URI, resource: server.mcpUrl };

    const noResource: Record<string, string> = { ...params };
    delete noResource.resource;
    const missingResource = await exchange(noResource);
    expect(missingResource.status).toBe(400);
    expect(await missingResource.json()).toMatchObject({ error: "invalid_target" });

    const otherRedirect = await exchange({ ...params, redirect_uri: "http://127.0.0.1:47999/elsewhere" });
    expect(otherRedirect.status).toBe(400);
    expect(await otherRedirect.json()).toMatchObject({ error: "invalid_grant" });

    // Another client cannot redeem this client's code.
    const thief = await register("Thief");
    const stolen = await exchange({ ...params, client_id: thief.client_id });
    expect(stolen.status).toBe(400);

    expect((await exchange(params)).status).toBe(200);
  });

  it("refuses refresh tokens", async () => {
    const { client_id: clientId } = await register();
    const response = await exchange({ grant_type: "refresh_token", refresh_token: "x", client_id: clientId });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });
});

describe("SDK client OAuth discovery", () => {
  class TestOAuthProvider implements OAuthClientProvider {
    readonly redirectUrl = REDIRECT_URI;
    readonly clientMetadata: OAuthClientMetadata = {
      client_name: "SDK Discovery Client",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    info: OAuthClientInformationMixed | undefined;
    saved: OAuthTokens | undefined;
    verifier = "";
    authorizationUrl: URL | undefined;
    clientInformation() {
      return this.info;
    }
    saveClientInformation(info: OAuthClientInformationMixed) {
      this.info = info;
    }
    tokens() {
      return this.saved;
    }
    saveTokens(tokens: OAuthTokens) {
      this.saved = tokens;
    }
    redirectToAuthorization(url: URL) {
      this.authorizationUrl = url;
    }
    saveCodeVerifier(verifier: string) {
      this.verifier = verifier;
    }
    codeVerifier() {
      return this.verifier;
    }
  }

  it("discovers metadata, registers, and authorizes with the SDK's own auth() flow", async () => {
    const provider = new TestOAuthProvider();
    expect(await auth(provider, { serverUrl: server.mcpUrl })).toBe("REDIRECT");
    expect(provider.info?.client_id).toBeTruthy();
    const url = provider.authorizationUrl!;
    expect(url.origin + url.pathname).toBe(`${base}/authorize`);
    expect(url.searchParams.get("resource")).toBe(server.mcpUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    const id = await openApproval(url);
    approve("builtin.guide", "SDK Agent");
    const code = (await waitForRedirect(id)).searchParams.get("code")!;
    expect(await auth(provider, { serverUrl: server.mcpUrl, authorizationCode: code })).toBe("AUTHORIZED");
    expect(provider.saved?.access_token).toMatch(/^dhmcp_/);

    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), { authProvider: provider });
    const client = new Client({ name: "sdk-auth-test", version: "1.0.0" });
    await client.connect(transport);
    clients.push(client);
    const status = (await client.callTool({ name: "diskhound_status", arguments: {} })) as CallToolResult;
    expect(status.structuredContent).toMatchObject({ session: { name: "SDK Agent", role: "Cleanup Guide" } });
  });
});
