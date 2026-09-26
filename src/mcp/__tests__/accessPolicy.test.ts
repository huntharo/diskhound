import { createHash } from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MCP_AGENT_CAPABILITIES, type McpAgentCapability } from "../../shared/agentAccess";
import {
  FixedMcpAuthorizer,
  McpAccessError,
  McpPolicyStore,
  MCP_POLICY_PROTOCOL,
  MCP_POLICY_VERSION,
  PolicyFileAuthorizer,
  type McpAccessErrorCode,
} from "../accessPolicy";
import { roleAuthorization } from "./fakeBackend";

const ALL_SCOPES: McpAgentCapability[] = [...MCP_AGENT_CAPABILITIES];
const oauth = (scopes: McpAgentCapability[] = ALL_SCOPES) => ({ clientId: "client_abc", scopes });

let tempDir: string;
let policyFile: string;

beforeEach(() => {
  tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-mcp-policy-test-"));
  policyFile = Path.join(tempDir, "nested", "mcp-policy.json");
});

afterEach(() => {
  FS.rmSync(tempDir, { recursive: true, force: true });
});

function accessError(run: () => unknown): McpAccessError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(McpAccessError);
    return error as McpAccessError;
  }
  throw new Error("expected an McpAccessError");
}

function expectCode(run: () => unknown, code: McpAccessErrorCode): McpAccessError {
  const error = accessError(run);
  expect(error.code).toBe(code);
  return error;
}

const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("McpPolicyStore", () => {
  it("reads a missing policy file as empty and does not create it", () => {
    const store = new McpPolicyStore(policyFile);
    expect(store.sessions()).toEqual([]);
    expect(store.exists()).toBe(false);
    expect(FS.existsSync(policyFile)).toBe(false);
  });

  it("creates a session with a dhmcp_ token and stores only its SHA-256", () => {
    const fixed = new Date("2026-09-24T12:00:00.000Z");
    const store = new McpPolicyStore(policyFile, () => fixed);
    const { session, token } = store.createSession("  Claude Code  ", "builtin.guide", oauth());

    expect(token).toMatch(/^dhmcp_[A-Za-z0-9_-]{43}$/);
    expect(session).toEqual({
      id: expect.stringMatching(/^session_[0-9a-f-]{36}$/),
      name: "Claude Code",
      roleId: "builtin.guide",
      createdAt: fixed.toISOString(),
      updatedAt: fixed.toISOString(),
      revokedAt: null,
      oauth: { clientId: "client_abc", scopes: ALL_SCOPES },
    });

    const contents = FS.readFileSync(policyFile, "utf8");
    expect(contents).not.toContain(token);
    expect(contents).not.toContain(token.slice("dhmcp_".length));
    const parsed = JSON.parse(contents) as { protocol: string; version: number; sessions: Record<string, unknown>[] };
    expect(parsed.protocol).toBe(MCP_POLICY_PROTOCOL);
    expect(parsed.version).toBe(MCP_POLICY_VERSION);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]!.tokenHash).toBe(sha256Hex(token));

    // The public view never leaks the hash either.
    expect(store.sessions()).toEqual([session]);
    expect(JSON.stringify(store.sessions())).not.toContain(sha256Hex(token));
  });

  it("issues a distinct token and id per session", () => {
    const store = new McpPolicyStore(policyFile);
    const a = store.createSession("Agent", "builtin.reader", oauth());
    const b = store.createSession("Agent", "builtin.reader", oauth());
    expect(a.token).not.toBe(b.token);
    expect(a.session.id).not.toBe(b.session.id);
    expect(store.sessions()).toHaveLength(2);
  });

  it("rejects invalid names and unknown roles", () => {
    const store = new McpPolicyStore(policyFile);
    expectCode(() => store.createSession("   ", "builtin.reader", oauth()), "invalid_input");
    expectCode(() => store.createSession("x".repeat(201), "builtin.reader", oauth()), "invalid_input");
    expectCode(() => store.createSession("Agent", "builtin.admin", oauth()), "invalid_input");
    expect(store.sessions()).toEqual([]);
  });

  it("authorizes a token for the capabilities its role grants", () => {
    const store = new McpPolicyStore(policyFile);
    const { session, token } = store.createSession("Codex", "builtin.guide", oauth());
    const auth = store.authorize(token, ["disk.read", "scan.run"]);
    expect(auth).toEqual({
      sessionId: session.id,
      sessionName: "Codex",
      roleId: "builtin.guide",
      roleName: "Cleanup Guide",
      capabilities: ["disk.read", "scan.run", "app.navigate"],
    });
    // No required capabilities: still identifies the session.
    expect(store.authorize(token).sessionId).toBe(session.id);
  });

  it("throws missing_capability, naming the capability and pointing at Settings", () => {
    const store = new McpPolicyStore(policyFile);
    const { token } = store.createSession("Codex", "builtin.reader", oauth());
    const error = expectCode(() => store.authorize(token, ["disk.read", "files.trash", "scan.run"]), "missing_capability");
    expect(error.message).toContain("does not grant: files.trash, scan.run.");
    expect(error.message).toContain("Settings");
    expect(error.message).toContain("Disk Explorer");
  });

  it("intersects the role with the OAuth scopes the user approved", () => {
    const store = new McpPolicyStore(policyFile);
    const scopes: McpAgentCapability[] = ["disk.read", "scan.run", "app.navigate"];
    const { token } = store.createSession("Agent", "builtin.operator", oauth(scopes));
    const auth = store.authorize(token, ["disk.read"]);
    expect(auth.roleId).toBe("builtin.operator");
    expect(auth.capabilities).toEqual(scopes);
    expectCode(() => store.authorize(token, ["files.trash"]), "missing_capability");
  });

  it("revokes a session so its token stops working", () => {
    let clock = new Date("2026-09-24T12:00:00.000Z");
    const store = new McpPolicyStore(policyFile, () => clock);
    const { session, token } = store.createSession("Agent", "builtin.guide", oauth());
    clock = new Date("2026-09-24T13:00:00.000Z");
    const revoked = store.revokeSession(session.id);
    expect(revoked.revokedAt).toBe(clock.toISOString());
    expect(revoked.updatedAt).toBe(clock.toISOString());
    expectCode(() => store.authorize(token), "revoked_session");

    // Revoking again keeps the original revokedAt.
    const firstRevokedAt = revoked.revokedAt;
    clock = new Date("2026-09-24T14:00:00.000Z");
    expect(store.revokeSession(session.id).revokedAt).toBe(firstRevokedAt);

    expectCode(() => store.revokeSession("session_missing"), "invalid_input");
  });

  it("applies a role change on the next authorize, capped by the approved scopes", () => {
    const store = new McpPolicyStore(policyFile);
    const { session, token } = store.createSession("Agent", "builtin.reader", oauth());
    expectCode(() => store.authorize(token, ["scan.run"]), "missing_capability");

    expect(store.assignRole(session.id, "builtin.operator").roleId).toBe("builtin.operator");
    expect(store.authorize(token, ["files.trash"]).roleName).toBe("Cleanup Operator");

    store.assignRole(session.id, "builtin.reader");
    expectCode(() => store.authorize(token, ["files.trash"]), "missing_capability");

    // A second store on the same file sees the change (no in-memory cache).
    const other = new McpPolicyStore(policyFile);
    expect(other.authorize(token).roleId).toBe("builtin.reader");

    // Moving to a bigger role never exceeds what the agent was approved for.
    const capped = store.createSession("Capped", "builtin.guide", oauth(["disk.read", "scan.run", "app.navigate"]));
    store.assignRole(capped.session.id, "builtin.operator");
    expectCode(() => store.authorize(capped.token, ["files.trash"]), "missing_capability");

    expectCode(() => store.assignRole(session.id, "builtin.root"), "invalid_input");
    expectCode(() => store.assignRole("session_missing", "builtin.reader"), "invalid_input");
  });

  it("forgetRevoked removes only revoked sessions", () => {
    const store = new McpPolicyStore(policyFile);
    const keep = store.createSession("Keep", "builtin.reader", oauth());
    const drop1 = store.createSession("Drop 1", "builtin.reader", oauth());
    const drop2 = store.createSession("Drop 2", "builtin.reader", oauth());
    store.revokeSession(drop1.session.id);
    store.revokeSession(drop2.session.id);

    expect(store.forgetRevoked()).toBe(2);
    expect(store.sessions().map((session) => session.name)).toEqual(["Keep"]);
    expect(store.forgetRevoked()).toBe(0);
    expect(store.authorize(keep.token).sessionName).toBe("Keep");
    expectCode(() => store.authorize(drop1.token), "invalid_session");
  });

  it("rejects unknown tokens as invalid_session", () => {
    const store = new McpPolicyStore(policyFile);
    expectCode(() => store.authorize("dhmcp_nope"), "invalid_session");
    store.createSession("Agent", "builtin.reader", oauth());
    expectCode(() => store.authorize("dhmcp_nope"), "invalid_session");
    expectCode(() => store.authorize(""), "invalid_session");
  });

  it("uses the role's permissions directly for sessions without an OAuth binding", () => {
    const token = "dhmcp_legacy-token";
    FS.mkdirSync(Path.dirname(policyFile), { recursive: true });
    FS.writeFileSync(policyFile, JSON.stringify({
      protocol: MCP_POLICY_PROTOCOL,
      version: MCP_POLICY_VERSION,
      sessions: [{
        id: "session_legacy",
        name: "Legacy",
        roleId: "builtin.operator",
        tokenHash: sha256Hex(token),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        revokedAt: null,
      }],
    }));
    const store = new McpPolicyStore(policyFile);
    expect(store.authorize(token, ["files.trash"]).capabilities).toEqual(["disk.read", "scan.run", "app.navigate", "files.trash"]);
  });

  it("refuses to authorize from a corrupt or foreign policy file", () => {
    FS.mkdirSync(Path.dirname(policyFile), { recursive: true });
    const store = new McpPolicyStore(policyFile);

    FS.writeFileSync(policyFile, "{not json");
    expectCode(() => store.sessions(), "invalid_policy");

    FS.writeFileSync(policyFile, JSON.stringify({ protocol: "other/v1", version: 1, sessions: [] }));
    expectCode(() => store.authorize("dhmcp_x"), "invalid_policy");

    FS.writeFileSync(policyFile, JSON.stringify({ protocol: MCP_POLICY_PROTOCOL, version: 1, sessions: [{ id: "bad id!" }] }));
    expectCode(() => store.sessions(), "invalid_policy");

    const session = {
      id: "session_dup",
      name: "Dup",
      roleId: "builtin.reader",
      tokenHash: sha256Hex("a"),
      createdAt: "x",
      updatedAt: "x",
      revokedAt: null,
    };
    FS.writeFileSync(policyFile, JSON.stringify({ protocol: MCP_POLICY_PROTOCOL, version: 1, sessions: [session, session] }));
    expectCode(() => store.sessions(), "invalid_policy");

    FS.writeFileSync(policyFile, JSON.stringify({
      protocol: MCP_POLICY_PROTOCOL,
      version: 1,
      sessions: [{ ...session, oauth: { clientId: "client", scopes: ["disk.read", "root"] } }],
    }));
    expectCode(() => store.sessions(), "invalid_policy");
  });

  it("reports invalid_role when a stored session points at a role that no longer exists", () => {
    const token = "dhmcp_retired";
    FS.mkdirSync(Path.dirname(policyFile), { recursive: true });
    FS.writeFileSync(policyFile, JSON.stringify({
      protocol: MCP_POLICY_PROTOCOL,
      version: MCP_POLICY_VERSION,
      sessions: [{
        id: "session_retired",
        name: "Retired",
        roleId: "builtin.retired",
        tokenHash: sha256Hex(token),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        revokedAt: null,
      }],
    }));
    expectCode(() => new McpPolicyStore(policyFile).authorize(token), "invalid_role");
  });

  it("caps the file at 256 sessions, evicting the oldest revoked one first", () => {
    const store = new McpPolicyStore(policyFile);
    const created = Array.from({ length: 256 }, (_, index) => store.createSession(`Agent ${index}`, "builtin.reader", oauth()));
    expectCode(() => store.createSession("One too many", "builtin.reader", oauth()), "invalid_input");

    store.revokeSession(created[10]!.session.id);
    store.revokeSession(created[20]!.session.id);
    const next = store.createSession("Replacement", "builtin.reader", oauth());
    const names = store.sessions().map((session) => session.name);
    expect(names).toHaveLength(256);
    expect(names).not.toContain("Agent 10");
    expect(names).toContain("Agent 20");
    expect(store.authorize(next.token).sessionName).toBe("Replacement");
  });

  it.skipIf(process.platform === "win32")("writes the policy file 0600 in a 0700 directory, atomically", () => {
    const store = new McpPolicyStore(policyFile);
    const { session } = store.createSession("Agent", "builtin.reader", oauth());
    expect(FS.statSync(policyFile).mode & 0o777).toBe(0o600);
    expect(FS.statSync(Path.dirname(policyFile)).mode & 0o777).toBe(0o700);

    // A permissive file is tightened on the next write.
    FS.chmodSync(policyFile, 0o644);
    store.revokeSession(session.id);
    expect(FS.statSync(policyFile).mode & 0o777).toBe(0o600);

    // No temp files are left behind.
    expect(FS.readdirSync(Path.dirname(policyFile))).toEqual(["mcp-policy.json"]);
  });
});

describe("PolicyFileAuthorizer", () => {
  it("re-reads the policy file on every call", async () => {
    const store = new McpPolicyStore(policyFile);
    const { session, token } = store.createSession("Agent", "builtin.guide", oauth());
    const authorizer = new PolicyFileAuthorizer(store, token);
    await expect(authorizer.authorize(["scan.run"])).resolves.toMatchObject({ sessionId: session.id });
    store.revokeSession(session.id);
    await expect(authorizer.authorize(["scan.run"])).rejects.toMatchObject({ code: "revoked_session" });
  });
});

describe("FixedMcpAuthorizer", () => {
  it("grants what its authorization lists and rejects the rest", async () => {
    const authorizer = new FixedMcpAuthorizer(roleAuthorization("builtin.reader"));
    await expect(authorizer.authorize(["disk.read"])).resolves.toMatchObject({ roleId: "builtin.reader" });
    await expect(authorizer.authorize()).resolves.toMatchObject({ roleId: "builtin.reader" });
    const error = await authorizer.authorize(["disk.read", "files.trash"]).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(McpAccessError);
    expect(error).toMatchObject({ code: "missing_capability" });
    expect((error as Error).message).toContain("files.trash");
  });
});
