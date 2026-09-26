import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { MCP_AGENT_CAPABILITIES, MCP_SERVER_NAME, SKILLS_EXTENSION_ID } from "../../shared/agentAccess";
import { FixedMcpAuthorizer, McpPolicyStore, PolicyFileAuthorizer, type McpAuthorizer } from "../accessPolicy";
import { AgentActivityLog } from "../activityLog";
import { createDiskhoundMcpServer, FREE_UP_SPACE_SKILL, INVESTIGATE_GROWTH_SKILL } from "../server";
import { loadSkillCatalog, type SkillCatalog } from "../skills";
import {
  createFakeBackend,
  NOW,
  RecordingActivity,
  roleAuthorization,
  ROOT,
  SKILLS_DIR,
  type FakeBackend,
} from "./fakeBackend";

const SKILLS = loadSkillCatalog(SKILLS_DIR);
const Loose = z.object({}).passthrough();

const EXPECTED_TOOLS = [
  "diskhound_status",
  "diskhound_scan_summary",
  "diskhound_list_folder",
  "diskhound_search_files",
  "diskhound_cleanup_suggestions",
  "diskhound_dev_artifacts",
  "diskhound_scan_history",
  "diskhound_changes",
  "diskhound_duplicates",
  "diskhound_start_scan",
  "diskhound_cancel_scan",
  "diskhound_find_duplicates",
  "diskhound_show",
  "diskhound_reveal_path",
  "diskhound_move_to_trash",
];
const READ_TOOLS = [
  "diskhound_status",
  "diskhound_scan_summary",
  "diskhound_list_folder",
  "diskhound_search_files",
  "diskhound_cleanup_suggestions",
  "diskhound_dev_artifacts",
  "diskhound_scan_history",
  "diskhound_changes",
  "diskhound_duplicates",
];

interface Harness {
  client: Client;
  server: McpServer;
  backend: FakeBackend;
  activity: RecordingActivity;
}

const open: Harness[] = [];

async function connect(options: {
  roleId?: string;
  authorizer?: McpAuthorizer;
  skills?: SkillCatalog;
  backend?: FakeBackend;
} = {}): Promise<Harness> {
  const backend = options.backend ?? createFakeBackend();
  const activity = new RecordingActivity();
  const server = createDiskhoundMcpServer({
    backend,
    activity,
    skills: options.skills ?? SKILLS,
    authorizer: options.authorizer ?? new FixedMcpAuthorizer(roleAuthorization(options.roleId ?? "builtin.operator")),
    now: () => NOW,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "diskhound-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const harness = { client, server, backend, activity };
  open.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of open.splice(0)) {
    await harness.client.close();
    await harness.server.close();
  }
});

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function text(result: CallToolResult, index = 0): string {
  const block = result.content[index];
  if (!block || block.type !== "text") throw new Error(`content[${index}] is not text`);
  return block.text;
}

function structured<T = Record<string, any>>(result: CallToolResult): T {
  expect(result.isError, result.isError ? text(result) : "").not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as T;
}

async function mcpError(promise: Promise<unknown>): Promise<McpError> {
  const error = await promise.then(
    () => {
      throw new Error("expected the request to fail");
    },
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(McpError);
  return error as McpError;
}

describe("initialize", () => {
  it("identifies as DiskHound and declares tools, prompts, resources, and the skills extension", async () => {
    const { client } = await connect();
    expect(client.getServerVersion()).toMatchObject({ name: MCP_SERVER_NAME, title: "DiskHound", version: "9.9.9-test" });
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tools).toBeDefined();
    expect(capabilities?.prompts).toBeDefined();
    expect(capabilities?.resources).toBeDefined();
    expect(capabilities?.extensions?.[SKILLS_EXTENSION_ID]).toEqual({ directoryRead: true });
  });

  it("sends platform-specific instructions that point at both skills", async () => {
    const { client } = await connect();
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("macOS");
    expect(instructions).toContain(FREE_UP_SPACE_SKILL);
    expect(instructions).toContain(INVESTIGATE_GROWTH_SKILL);
    expect(instructions).toContain("diskhound_move_to_trash");
  });
});

describe("tools/list", () => {
  it("lists every DiskHound tool with a title, description, and object input schema", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description?.length, tool.name).toBeGreaterThan(20);
      expect(tool.inputSchema.type, tool.name).toBe("object");
    }
  });

  it("defines all four annotation hints on every tool", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const annotations = tool.annotations ?? {};
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof annotations[hint], `${tool.name}.${hint}`).toBe("boolean");
      }
      expect(annotations.openWorldHint, tool.name).toBe(false);
    }
  });

  it("marks read tools read-only and only the trash tool destructive", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of READ_TOOLS) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
      expect(byName.get(name)?.annotations?.destructiveHint, name).toBe(false);
    }
    for (const name of EXPECTED_TOOLS.filter((tool) => !READ_TOOLS.includes(tool))) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(false);
    }
    const destructive = tools.filter((tool) => tool.annotations?.destructiveHint).map((tool) => tool.name);
    expect(destructive).toEqual(["diskhound_move_to_trash"]);
  });

  it("requires paths for list_folder and move_to_trash", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("diskhound_list_folder")?.inputSchema.required).toEqual(["path"]);
    expect(byName.get("diskhound_move_to_trash")?.inputSchema.required).toEqual(["paths"]);
  });
});

describe("read tools", () => {
  it("diskhound_status returns structured content plus a text summary and its JSON", async () => {
    const { client, backend } = await connect({ roleId: "builtin.guide" });
    const result = await call(client, "diskhound_status");
    const value = structured(result);
    expect(value.app).toEqual({ name: "DiskHound", version: "9.9.9-test", platform: "darwin" });
    expect(value.session).toEqual({
      name: "Test Agent",
      role: "Cleanup Guide",
      capabilities: ["disk.read", "scan.run", "app.navigate"],
    });
    expect(value.drives).toEqual([
      expect.objectContaining({ drive: "/", usedPercent: 76, free: "120 GB", total: "500 GB" }),
    ]);
    expect(value.scannedRoots).toEqual([
      expect.objectContaining({ rootPath: ROOT, age: "1 h ago", scansKept: 3, size: "70.0 GB" }),
    ]);
    expect(value.currentRoot).toBe(ROOT);
    expect(value.skills).toEqual([FREE_UP_SPACE_SKILL, INVESTIGATE_GROWTH_SKILL]);
    expect(value.note).toContain("APFS");

    expect(result.content).toHaveLength(2);
    expect(text(result)).toContain("Drives: / 120 GB free of 500 GB.");
    expect(text(result)).toContain(`Scanned roots: ${ROOT} (1 h ago).`);
    expect(JSON.parse(text(result, 1))).toEqual(value);
    expect(backend.navigate).not.toHaveBeenCalled();
  });

  it("diskhound_scan_summary uses the current root and caps each list", async () => {
    const { client, backend } = await connect({ roleId: "builtin.reader" });
    const value = structured(await call(client, "diskhound_scan_summary", { limit: 1 }));
    expect(value.rootPath).toBe(ROOT);
    expect(value.totals).toMatchObject({ files: 120_000, size: "70.0 GB" });
    expect(value.largestFiles).toHaveLength(1);
    // Sorted by size, not by the snapshot's order.
    expect(value.heaviestFolders).toEqual([expect.objectContaining({ path: `${ROOT}/Library` })]);
    expect(backend.latestSnapshot).toHaveBeenCalledWith(ROOT);
  });

  it("diskhound_list_folder drills into a folder, largest first", async () => {
    const { client, backend } = await connect({ roleId: "builtin.reader" });
    const value = structured(await call(client, "diskhound_list_folder", { path: `${ROOT}/Developer/` }));
    expect(backend.folderChildren).toHaveBeenCalledWith(ROOT, `${ROOT}/Developer`);
    expect(value.path).toBe(`${ROOT}/Developer`);
    expect(value.folders.map((dir: { name: string }) => dir.name)).toEqual(["app", "scratch"]);
    expect(value.folders[0].percent).toBe(90);
    expect(value.hiddenByProtectedFolders).toEqual({ count: 1, bytes: 64 * 1024 ** 2, size: "64.0 MB" });
    expect(value.truncated).toBe(false);
  });

  it("diskhound_list_folder reports paths outside any scan as a tool error", async () => {
    const { client } = await connect({ roleId: "builtin.reader" });
    const outside = await call(client, "diskhound_list_folder", { path: "/Volumes/External" });
    expect(outside.isError).toBe(true);
    expect(text(outside)).toContain("diskhound_start_scan");

    const empty = await call(client, "diskhound_list_folder", { path: `${ROOT}/Nothing/Here` });
    expect(empty.isError).toBe(true);
    expect(text(empty)).toContain("nothing recorded");
  });

  it("diskhound_search_files normalizes the extension and defaults the query to the separator", async () => {
    const { client, backend } = await connect({ roleId: "builtin.reader" });
    const value = structured(await call(client, "diskhound_search_files", { extension: "ISO", minSizeBytes: 1024 }));
    expect(backend.searchIndex).toHaveBeenCalledWith(ROOT, { query: "/", extension: ".iso", minSizeBytes: 1024, limit: 50 });
    expect(value.results.map((hit: { sizeBytes: number }) => hit.sizeBytes)).toEqual([5 * 1024 ** 3, 3 * 1024 ** 3]);
    expect(value.matched).toBe("8.0 GB");
  });

  it("diskhound_changes picks the baseline from `since` and summarizes the diff", async () => {
    const { client, backend } = await connect({ roleId: "builtin.reader" });
    const value = structured(await call(client, "diskhound_changes", { since: "1w" }));
    expect(backend.diff).toHaveBeenCalledWith("scan-1", "scan-3");
    expect(value.net).toBe("+10.0 GB");
    expect(value.folders[0]).toMatchObject({ path: `${ROOT}/Downloads`, delta: "+5.0 GB" });

    const byDefault = structured(await call(client, "diskhound_changes"));
    expect(byDefault.baselineId).toBe("scan-2");

    const files = structured(await call(client, "diskhound_changes", { detail: "files", baselineId: "scan-2", limit: 1 }));
    expect(backend.fullDiff).toHaveBeenCalledWith("scan-2", "scan-3", 1);
    expect(files.changes).toHaveLength(1);
  });

  it("diskhound_changes warns when the hardlink accounting differs between scans", async () => {
    const { client, backend } = await connect({ roleId: "builtin.reader" });
    const plain = await backend.diff("scan-1", "scan-3");
    backend.diff.mockResolvedValueOnce(plain && { ...plain, hardlinkAccountingChanged: true });
    const result = await call(client, "diskhound_changes", { since: "1w" });
    expect(structured(result).hardlinkAccountingChanged).toBe(true);
    expect(text(result)).toContain("Part of this change is accounting");
  });

  it("diskhound_changes warns when one scan walked the macOS Data volume twice", async () => {
    const { client, backend } = await connect({ roleId: "builtin.reader" });
    const plain = await backend.diff("scan-1", "scan-3");
    backend.diff.mockResolvedValueOnce(plain && { ...plain, volumeAccountingChanged: true });
    const result = await call(client, "diskhound_changes", { since: "1w" });
    expect(structured(result).volumeAccountingChanged).toBe(true);
    expect(text(result)).toContain("walked the macOS Data volume twice");
  });

  // SDK 1.30.0's McpServer parses tools/call `arguments` as given, so
  // omitting it (optional in the spec) fails here. The HTTP layer
  // defaults it to {} (withDefaultArguments, covered in
  // agentAccessServer.test.ts); this pins the SDK behavior so we notice
  // when an upgrade makes that shim unnecessary.
  it.fails("the bare SDK rejects a tools/call without `arguments`", async () => {
    const { client } = await connect({ roleId: "builtin.reader" });
    const result = (await client.callTool({ name: "diskhound_status" })) as CallToolResult;
    expect(result.isError).not.toBe(true);
  });

  it("diskhound_duplicates explains when no search has run", async () => {
    const { client } = await connect({ roleId: "builtin.reader" });
    const result = await call(client, "diskhound_duplicates");
    expect(structured(result)).toEqual({ rootPath: ROOT, running: false, progress: null });
    expect(text(result)).toContain("diskhound_find_duplicates");
  });
});

describe("authorization", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-mcp-server-test-"));
  });

  afterEach(() => {
    FS.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns isError (not a protocol error) when the authorizer lacks a capability", async () => {
    const { client, backend } = await connect({ roleId: "builtin.reader" });
    const result = await call(client, "diskhound_move_to_trash", { paths: [`${ROOT}/Downloads/ubuntu.iso`] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("files.trash");
    expect(result.structuredContent).toBeUndefined();
    expect(backend.confirmAndTrash).not.toHaveBeenCalled();
  });

  it("tells the agent to ask the user to change the role in Settings (policy-file authorizer)", async () => {
    const store = new McpPolicyStore(Path.join(tempDir, "mcp-policy.json"));
    const { token } = store.createSession("Codex", "builtin.reader", {
      clientId: "client_1",
      scopes: [...MCP_AGENT_CAPABILITIES],
    });
    const { client, backend } = await connect({ authorizer: new PolicyFileAuthorizer(store, token) });

    const status = structured(await call(client, "diskhound_status"));
    expect(status.session).toMatchObject({ name: "Codex", role: "Disk Explorer" });

    const trash = await call(client, "diskhound_move_to_trash", { paths: [`${ROOT}/Downloads/ubuntu.iso`] });
    expect(trash.isError).toBe(true);
    expect(text(trash)).toContain("files.trash");
    expect(text(trash)).toContain("Settings");
    expect(backend.confirmAndTrash).not.toHaveBeenCalled();
  });

  it("applies a revoke in Settings to the very next tool call", async () => {
    const store = new McpPolicyStore(Path.join(tempDir, "mcp-policy.json"));
    const { session, token } = store.createSession("Codex", "builtin.guide", {
      clientId: "client_1",
      scopes: [...MCP_AGENT_CAPABILITIES],
    });
    const { client } = await connect({ authorizer: new PolicyFileAuthorizer(store, token) });
    expect((await call(client, "diskhound_status")).isError).not.toBe(true);
    store.revokeSession(session.id);
    const after = await call(client, "diskhound_status");
    expect(after.isError).toBe(true);
    expect(text(after)).toContain("revoked");
  });

  it("requires app.navigate only when showInApp is set", async () => {
    const { client, backend } = await connect({ roleId: "builtin.reader" });
    expect((await call(client, "diskhound_list_folder", { path: ROOT })).isError).not.toBe(true);
    const shown = await call(client, "diskhound_list_folder", { path: ROOT, showInApp: true });
    expect(shown.isError).toBe(true);
    expect(text(shown)).toContain("app.navigate");
    expect(backend.navigate).not.toHaveBeenCalled();
  });

  it("start_scan needs app.navigate by default because showInApp defaults to true", async () => {
    const { client, backend } = await connect({ roleId: "builtin.reader" });
    const result = await call(client, "diskhound_start_scan", { rootPath: ROOT });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("scan.run");
    expect(backend.startScan).not.toHaveBeenCalled();
  });
});

describe("showInApp", () => {
  it("navigates the Folders tab to the listed folder when showInApp is true", async () => {
    const { client, backend } = await connect({ roleId: "builtin.guide" });
    await call(client, "diskhound_list_folder", { path: `${ROOT}/Downloads`, showInApp: true });
    expect(backend.navigate).toHaveBeenCalledTimes(1);
    expect(backend.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ view: "folders", rootPath: ROOT, folderPath: `${ROOT}/Downloads` }),
    );
  });

  it("does not navigate when showInApp is false or omitted", async () => {
    const { client, backend } = await connect({ roleId: "builtin.guide" });
    await call(client, "diskhound_list_folder", { path: `${ROOT}/Downloads`, showInApp: false });
    await call(client, "diskhound_list_folder", { path: `${ROOT}/Downloads` });
    await call(client, "diskhound_scan_summary", {});
    expect(backend.navigate).not.toHaveBeenCalled();
  });

  it("start_scan switches the window to the root unless told not to", async () => {
    const { client, backend } = await connect({ roleId: "builtin.guide" });
    const started = structured(await call(client, "diskhound_start_scan", { rootPath: "/Volumes/Data/" }));
    expect(started).toMatchObject({ rootPath: "/Volumes/Data", started: true, status: "running" });
    expect(backend.startScan).toHaveBeenCalledWith("/Volumes/Data");
    expect(backend.navigate).toHaveBeenCalledWith({ view: "overview", rootPath: "/Volumes/Data" });

    backend.navigate.mockClear();
    await call(client, "diskhound_start_scan", { rootPath: "/Volumes/Data", showInApp: false });
    expect(backend.navigate).not.toHaveBeenCalled();
  });

  it("rejects relative paths instead of resolving them against DiskHound's working directory", async () => {
    const { client, backend } = await connect({ roleId: "builtin.guide" });
    const result = await call(client, "diskhound_start_scan", { rootPath: "Downloads" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("absolute path");
    expect(backend.startScan).not.toHaveBeenCalled();
  });

  it("treats a bare Windows drive letter (as diskhound_status reports it) as the drive root", async () => {
    const backend = createFakeBackend();
    backend.platform = "win32";
    const { client } = await connect({ roleId: "builtin.guide", backend });
    await call(client, "diskhound_start_scan", { rootPath: "C:", showInApp: false });
    expect(backend.startScan).toHaveBeenCalledWith("C:\\");
  });

  it("start_scan refuses to restart a running scan unless restart is true", async () => {
    const backend = createFakeBackend();
    backend.activeScans.mockResolvedValue([{ ...(await backend.startScan(ROOT)), filesVisited: 42 }]);
    backend.startScan.mockClear();
    const { client } = await connect({ roleId: "builtin.guide", backend });
    const value = structured(await call(client, "diskhound_start_scan", { rootPath: ROOT }));
    expect(value).toMatchObject({ started: false, alreadyRunning: true, filesVisited: 42 });
    expect(backend.startScan).not.toHaveBeenCalled();

    await call(client, "diskhound_start_scan", { rootPath: ROOT, restart: true });
    expect(backend.startScan).toHaveBeenCalledWith(ROOT);
  });

  it("diskhound_show resolves the scan root for a folder and passes focus through", async () => {
    const { client, backend } = await connect({ roleId: "builtin.guide" });
    const value = structured(await call(client, "diskhound_show", { view: "folders", folderPath: `${ROOT}/Developer/app` }));
    expect(value).toEqual({ view: "folders", rootPath: ROOT, folderPath: `${ROOT}/Developer/app` });
    expect(backend.navigate).toHaveBeenCalledWith({
      view: "folders",
      rootPath: ROOT,
      folderPath: `${ROOT}/Developer/app`,
      focus: false,
    });
  });

  it("diskhound_reveal_path surfaces a backend failure as a tool error", async () => {
    const { client, backend } = await connect({ roleId: "builtin.guide" });
    backend.revealPath.mockResolvedValueOnce({ ok: false, message: "Nothing exists at /nope." });
    const result = await call(client, "diskhound_reveal_path", { path: "/nope" });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Nothing exists at /nope.");
  });
});

describe("diskhound_move_to_trash", () => {
  it("passes the Session name, de-duplicated absolute paths, and reason to confirmAndTrash", async () => {
    const { client, backend } = await connect({ roleId: "builtin.operator" });
    const result = await call(client, "diskhound_move_to_trash", {
      paths: [`${ROOT}/Downloads/ubuntu.iso`, `${ROOT}/Downloads/../Downloads/ubuntu.iso`, `${ROOT}/Downloads/installer.dmg`],
      reason: "Old installers",
    });
    expect(backend.confirmAndTrash).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: "Test Agent",
        paths: [`${ROOT}/Downloads/ubuntu.iso`, `${ROOT}/Downloads/installer.dmg`],
        reason: "Old installers",
      }),
    );
    // The host re-checks the Session right before its dialog.
    const [request] = backend.confirmAndTrash.mock.calls[0]!;
    await expect(request.recheck?.()).resolves.toBeUndefined();
    const value = structured(result);
    expect(value).toMatchObject({ confirmed: true, movedCount: 2, movedBytes: 200 * 1024 ** 2, moved: "200 MB" });
    expect(text(result)).toContain("Moved 2 of 2 item(s)");
    expect(text(result)).toContain("Trash");
  });

  it("reports a declined confirmation without claiming anything moved", async () => {
    const { client, backend, activity } = await connect({ roleId: "builtin.operator" });
    backend.confirmAndTrash.mockResolvedValueOnce({ confirmed: false, results: [] });
    const result = await call(client, "diskhound_move_to_trash", { paths: [`${ROOT}/Movies/trip.mov`] });
    expect(result.isError).not.toBe(true);
    expect(structured(result)).toEqual({ confirmed: false, results: [] });
    expect(text(result)).toBe("The user declined. Nothing was moved.");
    expect(activity.entries.at(-1)).toMatchObject({ tool: "diskhound_move_to_trash", ok: true, summary: expect.stringContaining("declined") });
  });

  it("lists items the backend could not move", async () => {
    const { client, backend } = await connect({ roleId: "builtin.operator" });
    backend.confirmAndTrash.mockResolvedValueOnce({
      confirmed: true,
      results: [
        { path: "/a", ok: true, message: "Moved.", sizeBytes: 1024 },
        { path: "/b", ok: false, message: "Protected folder", sizeBytes: null },
      ],
    });
    const result = await call(client, "diskhound_move_to_trash", { paths: ["/a", "/b"] });
    expect(structured(result)).toMatchObject({ movedCount: 1, movedBytes: 1024 });
    expect(text(result)).toContain("Not moved: /b (Protected folder)");
  });

  it("rejects an empty path list at the schema", async () => {
    const { client, backend } = await connect({ roleId: "builtin.operator" });
    const result = await call(client, "diskhound_move_to_trash", { paths: [] });
    expect(result.isError).toBe(true);
    expect(backend.confirmAndTrash).not.toHaveBeenCalled();
  });
});

describe("activity feed", () => {
  it("records one entry per successful or failed tool call", async () => {
    const { client, activity } = await connect({ roleId: "builtin.guide" });
    await call(client, "diskhound_status");
    await call(client, "diskhound_list_folder", { path: `${ROOT}/Downloads`, showInApp: true });
    await call(client, "diskhound_list_folder", { path: "/Volumes/External" });
    expect(activity.entries).toEqual([
      { sessionId: "session_builtin.guide", sessionName: "Test Agent", tool: "diskhound_status", summary: "Checked drives and scan status", ok: true },
      { sessionId: "session_builtin.guide", sessionName: "Test Agent", tool: "diskhound_list_folder", summary: `Listed ${ROOT}/Downloads (5.0 GB)`, ok: true },
      {
        sessionId: "session_builtin.guide",
        sessionName: "Test Agent",
        tool: "diskhound_list_folder",
        summary: expect.stringContaining("no scan covering /Volumes/External"),
        ok: false,
      },
    ]);
  });

  it("uses the first line of the summary when a tool gives no activity text", async () => {
    const { client, activity } = await connect({ roleId: "builtin.guide" });
    await call(client, "diskhound_cancel_scan", { rootPath: ROOT });
    expect(activity.entries).toEqual([
      expect.objectContaining({ tool: "diskhound_cancel_scan", ok: true, summary: `Cancelled the scan of ${ROOT} (if one was running).` }),
    ]);
  });

  it("feeds AgentActivityLog newest-first with ids and timestamps", async () => {
    const seen: string[] = [];
    let clock = 1_000;
    const log = new AgentActivityLog((entry) => seen.push(entry.id), 2, () => clock++);
    log.record({ sessionId: "s", sessionName: "S", tool: "a", summary: "a", ok: true });
    log.record({ sessionId: "s", sessionName: "S", tool: "b", summary: "b", ok: false });
    log.record({ sessionId: "s", sessionName: "S", tool: "c", summary: "c", ok: true });
    expect(log.list().map((entry) => [entry.id, entry.tool, entry.at])).toEqual([
      ["agent-3", "c", 1002],
      ["agent-2", "b", 1001],
    ]);
    expect(seen).toEqual(["agent-1", "agent-2", "agent-3"]);

    const throwing = new AgentActivityLog(() => {
      throw new Error("window closed");
    });
    expect(() => throwing.record({ sessionId: "s", sessionName: "S", tool: "a", summary: "a", ok: true })).not.toThrow();
  });

  it("records calls rejected for a missing capability", async () => {
    const { client, activity } = await connect({ roleId: "builtin.reader" });
    const result = await call(client, "diskhound_move_to_trash", { paths: ["/a"] });
    expect(result.isError).toBe(true);
    expect(activity.entries).toEqual([
      expect.objectContaining({
        sessionName: "Test Agent",
        tool: "diskhound_move_to_trash",
        ok: false,
        summary: expect.stringContaining("files.trash"),
      }),
    ]);
  });

  it("does not record calls from a revoked Session (it no longer has an identity to show)", async () => {
    const tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-mcp-activity-test-"));
    try {
      const store = new McpPolicyStore(Path.join(tempDir, "mcp-policy.json"));
      const { session, token } = store.createSession("Codex", "builtin.reader", { clientId: "client_1", scopes: [...MCP_AGENT_CAPABILITIES] });
      const { client, activity } = await connect({ authorizer: new PolicyFileAuthorizer(store, token) });
      store.revokeSession(session.id);
      expect((await call(client, "diskhound_status")).isError).toBe(true);
      expect(activity.entries).toEqual([]);
    } finally {
      FS.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("skills extension (SEP-2640)", () => {
  it("skills/list returns every skill with frontmatter and a digest manifest", async () => {
    const { client } = await connect();
    const result = await client.request({ method: "skills/list", params: {} }, Loose);
    const skills = (result as { skills: { uri: string; frontmatter: Record<string, string>; resources: { uri: string; digest: string; size: number }[] }[] }).skills;
    expect((result as { resultType?: string }).resultType).toBe("complete");
    expect(skills.map((skill) => skill.uri)).toEqual([FREE_UP_SPACE_SKILL, INVESTIGATE_GROWTH_SKILL]);
    expect(skills[0]!.frontmatter.name).toBe("diskhound-free-up-space");
    expect(skills[0]!.resources).toHaveLength(5);
    for (const resource of skills.flatMap((skill) => skill.resources)) {
      expect(resource.uri).toMatch(/^skill:\/\/diskhound-[a-z-]+\//);
      expect(resource.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(resource.size).toBeGreaterThan(0);
    }
  });

  it("skills/list works with no params at all", async () => {
    const { client } = await connect();
    const result = (await client.request({ method: "skills/list" }, Loose)) as { skills: unknown[] };
    expect(result.skills).toHaveLength(2);
  });

  it("skills/get returns one skill and rejects unknown URIs with InvalidParams", async () => {
    const { client } = await connect();
    const result = (await client.request({ method: "skills/get", params: { uri: INVESTIGATE_GROWTH_SKILL } }, Loose)) as {
      skill: { uri: string; frontmatter: Record<string, string> };
    };
    expect(result.skill.uri).toBe(INVESTIGATE_GROWTH_SKILL);
    expect(result.skill.frontmatter.name).toBe("diskhound-investigate-growth");

    const unknown = await mcpError(client.request({ method: "skills/get", params: { uri: "skill://nope/SKILL.md" } }, Loose));
    expect(unknown.code).toBe(ErrorCode.InvalidParams);

    // The skill's root directory URI is not a skill URI.
    const root = await mcpError(client.request({ method: "skills/get", params: { uri: "skill://diskhound-free-up-space" } }, Loose));
    expect(root.code).toBe(ErrorCode.InvalidParams);
  });

  it("resources/directory/read lists a skill's children and its subdirectories", async () => {
    const { client } = await connect();
    const top = (await client.request(
      { method: "resources/directory/read", params: { uri: "skill://diskhound-free-up-space" } },
      Loose,
    )) as { resources: { uri: string; name: string; mimeType: string }[] };
    expect(top.resources.map((child) => [child.name, child.mimeType]).sort()).toEqual([
      ["SKILL.md", "text/markdown"],
      ["references", "inode/directory"],
    ]);

    const references = (await client.request(
      { method: "resources/directory/read", params: { uri: "skill://diskhound-free-up-space/references" } },
      Loose,
    )) as { resources: { uri: string }[] };
    expect(references.resources.map((child) => child.uri).sort()).toEqual([
      "skill://diskhound-free-up-space/references/developer-caches.md",
      "skill://diskhound-free-up-space/references/linux.md",
      "skill://diskhound-free-up-space/references/macos.md",
      "skill://diskhound-free-up-space/references/windows.md",
    ]);

    for (const uri of ["skill://nope", "skill://diskhound-free-up-space/SKILL.md", "skill://diskhound-free-up-space/scripts"]) {
      const error = await mcpError(client.request({ method: "resources/directory/read", params: { uri } }, Loose));
      expect(error.code, uri).toBe(ErrorCode.InvalidParams);
    }
  });

  it("serves every skill file through resources/list and resources/read", async () => {
    const { client } = await connect();
    const { resources } = await client.listResources();
    const expected = SKILLS.skills.flatMap((skill) => skill.files.map((file) => file.uri));
    expect(resources.map((resource) => resource.uri).sort()).toEqual([...expected].sort());
    const skillMd = resources.find((resource) => resource.uri === FREE_UP_SPACE_SKILL);
    expect(skillMd).toMatchObject({ name: "diskhound-free-up-space", mimeType: "text/markdown", title: "Skill: diskhound-free-up-space" });

    const read = await client.readResource({ uri: FREE_UP_SPACE_SKILL });
    const onDisk = FS.readFileSync(Path.join(SKILLS_DIR, "diskhound-free-up-space", "SKILL.md"), "utf8");
    expect(read.contents).toEqual([{ uri: FREE_UP_SPACE_SKILL, mimeType: "text/markdown", text: onDisk }]);

    const reference = await client.readResource({ uri: "skill://diskhound-free-up-space/references/macos.md" });
    expect((reference.contents[0] as { text: string }).text).toContain("## APFS clones");
  });

  it("rejects unknown skill resource URIs with InvalidParams", async () => {
    const { client } = await connect();
    const error = await mcpError(client.readResource({ uri: "skill://diskhound-free-up-space/references/solaris.md" }));
    expect(error.code).toBe(ErrorCode.InvalidParams);
  });
});

describe("prompts", () => {
  it("lists both prompt fallbacks with their optional arguments", async () => {
    const { client } = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual(["free-up-space", "investigate-growth"]);
    const freeUp = prompts.find((prompt) => prompt.name === "free-up-space");
    expect(freeUp?.arguments?.map((argument) => [argument.name, argument.required ?? false])).toEqual([
      ["goal", false],
      ["path", false],
    ]);
  });

  it("free-up-space embeds SKILL.md as a resource and then asks", async () => {
    const { client } = await connect();
    const result = await client.getPrompt({ name: "free-up-space", arguments: { goal: "free 50 GB", path: "/" } });
    expect(result.messages).toHaveLength(2);
    const [skill, ask] = result.messages;
    expect(skill!.content).toEqual({
      type: "resource",
      resource: { uri: FREE_UP_SPACE_SKILL, mimeType: "text/markdown", text: SKILLS.skills[0]!.files.find((file) => file.relativePath === "SKILL.md")!.text },
    });
    expect(ask!.content.type).toBe("text");
    expect((ask!.content as { text: string }).text).toContain("on / — goal: free 50 GB");
  });

  it("investigate-growth embeds its SKILL.md and works without arguments", async () => {
    const { client } = await connect();
    const result = await client.getPrompt({ name: "investigate-growth", arguments: {} });
    const resource = result.messages[0]!.content as { type: string; resource: { uri: string; text: string } };
    expect(resource.type).toBe("resource");
    expect(resource.resource.uri).toBe(INVESTIGATE_GROWTH_SKILL);
    expect(resource.resource.text).toContain("name: diskhound-investigate-growth");
  });

  // Same SDK behavior as tools/call above; the HTTP layer defaults it.
  it.fails("the bare SDK rejects a prompts/get without `arguments`", async () => {
    const { client } = await connect();
    const result = await client.getPrompt({ name: "free-up-space" });
    expect(result.messages).toHaveLength(2);
  });

  it("omits the prompts when their skills are missing", async () => {
    const { client } = await connect({ skills: { skills: [SKILLS.skills[1]!] } });
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual(["investigate-growth"]);
  });
});

describe("empty skill catalog", () => {
  // electronHost.ts falls back to `{ skills: [] }` when the skills
  // directory fails to load. The server then advertises only tools, so
  // clients never call list methods that have nothing behind them.
  it("advertises tools only, without prompts, resources, or the skills extension", async () => {
    const { client } = await connect({ skills: { skills: [] } });
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tools).toBeDefined();
    expect(capabilities?.prompts).toBeUndefined();
    expect(capabilities?.resources).toBeUndefined();
    expect(capabilities?.extensions?.[SKILLS_EXTENSION_ID]).toBeUndefined();
  });

  it("still lists every tool", async () => {
    const { client } = await connect({ skills: { skills: [] } });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("diskhound_status");
  });
});
