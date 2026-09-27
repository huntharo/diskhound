import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import type { Response } from "express";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { MCP_AGENT_CAPABILITIES } from "../../shared/agentAccess";
import { McpPolicyStore } from "../accessPolicy";
import { AgentOAuth } from "../agentOAuth";
import { AgentActivityLog } from "../activityLog";

vi.mock("node:fs", async (original) => (await import("../../test/ioBudget")).instrumentFs(await original()));
vi.mock("node:fs/promises", async (original) => (await import("../../test/ioBudget")).instrumentFsPromises(await original()));

const resource = new URL("http://127.0.0.1:51733/mcp");
const redirect = "http://127.0.0.1:47999/callback";
let dir: string;
let policy: McpPolicyStore;
let oauth: AgentOAuth;
let client: OAuthClientInformationFull;
let active: ReturnType<McpPolicyStore["createSession"]>;
const scopes = [...MCP_AGENT_CAPABILITIES];

class Reply {
  body = "";
  location = "";
  setHeader() { return this; }
  type() { return this; }
  status() { return this; }
  send(body: string) { this.body = body; return this; }
  redirect(_status: number, url: string) { this.location = url; }
  get response() { return this as unknown as Response; }
}

async function register(name: string) {
  return await oauth.clientsStore.registerClient!({ client_name: name, redirect_uris: [redirect] }) as OAuthClientInformationFull;
}

beforeEach(async () => {
  dir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-agent-io-"));
  policy = new McpPolicyStore(Path.join(dir, "policy.json"));
  oauth = new AgentOAuth({ policy, clientsFile: Path.join(dir, "clients.json"), resource,
    requestConsent: async () => ({ decision: "allow", sessionName: "Claude Code — cleanup", roleId: "builtin.guide" }),
    onChanged: () => undefined });
  // A used profile: several agents/projects and retained session history.
  for (let i = 0; i < 32; i++) {
    client = await register(`Local development agent ${i.toString().padStart(3, "0")}`);
    active = policy.createSession(`Project ${i.toString().padStart(3, "0")} agent`, "builtin.guide", { clientId: client.client_id, scopes });
  }
});
afterEach(() => { oauth.close(); FS.rmSync(dir, { recursive: true, force: true }); });

function budget(scenario: string, io: Awaited<ReturnType<typeof measureFsIo>>["io"], detail: string) {
  expectIoBudget({ scenario, io, note: `${detail} Not tied to monitoring: at default or aggressive 1-minute monitoring, `
    + `assuming 1 event/day: ${io.writeFile} file writes/day, ${(io.bytesWritten / 1e6).toFixed(3)} MB/day; `
    + `24 events/day: ${24 * io.writeFile} file writes/day, ${(24 * io.bytesWritten / 1e6).toFixed(3)} MB/day. `
    + "Each changed file is atomically replaced with a rename; polling adds no writes." });
}

it("budgets one client registration in a used profile", async () => {
  const { io } = await measureFsIo(() => register("Claude Code — new project"));
  budget("mcp-client-registration", io, "Registration with 32 saved clients; one complete client-store replacement.");
});

it("budgets registration at the 256-client cap", async () => {
  for (let i = 32; i < 256; i++) await register(`Local development agent ${i.toString().padStart(3, "0")}`);
  const { io } = await measureFsIo(() => register("Claude Code — new project"));
  budget("mcp-client-registration-at-cap", io, "256 saved clients; evicts one unapproved client and replaces the bounded store once.");
});

it("budgets OAuth approval, role change, and revocation", async () => {
  const { io } = await measureFsIo(async () => {
    const response = new Reply();
    await oauth.authorize(client, { codeChallenge: "x".repeat(43), redirectUri: redirect, resource, scopes }, response.response);
    const id = /status\?id=([A-Za-z0-9_-]+)/.exec(response.body)![1]!;
    await Promise.resolve();
    const approved = new Reply();
    oauth.status(id, approved.response);
    const code = new URL(approved.location).searchParams.get("code")!;
    const tokens = await oauth.exchangeAuthorizationCode(client, code, undefined, redirect, resource);
    const auth = policy.authorize(tokens.access_token);
    policy.assignRole(auth.sessionId, "builtin.operator");
    await oauth.revokeToken(client, { token: tokens.access_token });
    await expect(oauth.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });
  budget("mcp-session-lifecycle", io, "32 existing sessions; approval, role change and revocation replace the policy three times per lifecycle.");
});

it("does not persist repeated role assignments or revocations", async () => {
  policy.revokeSession(active.session.id);
  const { io } = await measureFsIo(() => {
    policy.assignRole(active.session.id, "builtin.guide");
    policy.revokeSession(active.session.id);
    policy.forgetRevoked();
    policy.forgetRevoked();
  });
  // Only actually removing the revoked record changes disk state.
  budget("mcp-policy-idempotent-updates", io, "Repeated role/revoke/forget requests; only the first forget changes the policy (one replacement).");
});

it("keeps token verification, pending-approval polling and activity reads write-free", async () => {
  const pending = new AgentOAuth({ policy, clientsFile: Path.join(dir, "clients.json"), resource,
    requestConsent: () => new Promise(() => undefined), onChanged: () => undefined });
  try {
    const response = new Reply();
    await pending.authorize(client, { codeChallenge: "x".repeat(43), redirectUri: redirect, resource, scopes }, response.response);
    const id = /status\?id=([A-Za-z0-9_-]+)/.exec(response.body)![1]!;
    const activity = new AgentActivityLog(() => undefined);
    const { io } = await measureFsIo(async () => {
      for (let i = 0; i < 60; i++) {
        await oauth.verifyAccessToken(active.token);
        policy.authorize(active.token, ["disk.read"]);
        await oauth.clientsStore.getClient(client.client_id);
        pending.status(id, new Reply().response);
        activity.record({ sessionId: active.session.id, sessionName: "Agent", tool: "diskhound_status", summary: "Read status", ok: true });
        activity.list();
      }
    });
    budget("mcp-read-poll-activity", io, "60 token/read/poll/activity cycles with 32 sessions; 0 writes/day and 0 MB/day even at one cycle/second (86,400/day).");
  } finally { pending.close(); }
});
