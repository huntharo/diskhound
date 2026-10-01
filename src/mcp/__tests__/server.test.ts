import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  BUILT_IN_MCP_ROLES,
  MCP_AGENT_CAPABILITIES,
  MCP_SERVER_NAME,
  SKILLS_EXTENSION_ID,
  type McpAgentCapability,
} from "../../shared/agentAccess";
import { FixedMcpAuthorizer, McpPolicyStore, PolicyFileAuthorizer, type McpAuthorizer } from "../accessPolicy";
import { AgentActivityLog } from "../activityLog";
import { createDiskhoundMcpServer, FREE_UP_SPACE_SKILL, INVESTIGATE_GROWTH_SKILL, TOOL_CAPABILITIES } from "../server";
import { loadSkillCatalog, type SkillCatalog } from "../skills";
import {
  createFakeBackend,
  MEASUREMENT,
  NOW,
  RecordingActivity,
  RecordingSecurity,
  roleAuthorization,
  ROOT,
  SKILLS_DIR,
  type FakeBackend,
} from "./fakeBackend";

const SKILLS = loadSkillCatalog(SKILLS_DIR);
const Loose = z.object({}).passthrough();

const EXPECTED_TOOLS = [
  "diskhound_status",
  "diskhound_read_skill",
  "diskhound_scan_summary",
  "diskhound_list_folder",
  "diskhound_search_files",
  "diskhound_cleanup_suggestions",
  "diskhound_dev_artifacts",
  "diskhound_measure_removal",
  "diskhound_scan_history",
  "diskhound_changes",
  "diskhound_duplicates",
  "diskhound_start_scan",
  "diskhound_cancel_scan",
  "diskhound_find_duplicates",
  "diskhound_show",
  "diskhound_reveal_path",
  "diskhound_move_to_trash",
  "diskhound_delete_permanently",
];
const READ_TOOLS = [
  "diskhound_status",
  "diskhound_read_skill",
  "diskhound_scan_summary",
  "diskhound_list_folder",
  "diskhound_search_files",
  "diskhound_cleanup_suggestions",
  "diskhound_dev_artifacts",
  "diskhound_measure_removal",
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
  granted?: readonly McpAgentCapability[];
  security?: RecordingSecurity;
} = {}): Promise<Harness> {
  const backend = options.backend ?? createFakeBackend();
  const activity = new RecordingActivity();
  const server = createDiskhoundMcpServer({
    backend,
    activity,
    skills: options.skills ?? SKILLS,
    authorizer: options.authorizer ?? new FixedMcpAuthorizer(roleAuthorization(options.roleId ?? "builtin.operator")),
    granted: options.granted,
    security: options.security,
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

  it("marks read tools read-only and only the trash and delete tools destructive", async () => {
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
    expect(destructive).toEqual(["diskhound_move_to_trash", "diskhound_delete_permanently"]);
  });

  it("requires paths for list_folder, move_to_trash and delete_permanently", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("diskhound_list_folder")?.inputSchema.required).toEqual(["path"]);
    expect(byName.get("diskhound_move_to_trash")?.inputSchema.required).toEqual(["paths"]);
    expect(byName.get("diskhound_delete_permanently")?.inputSchema.required).toEqual(["paths"]);
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
    expect(text(result)).toContain(`read ${FREE_UP_SPACE_SKILL} with diskhound_read_skill`);
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
    expect(text(result)).toContain("Moved 2 of 2 items (200 MB)");
    expect(text(result)).toContain("Trash");
  });

  it("reports sizes in the units the user picked, so they match the window", async () => {
    const backend = createFakeBackend();
    Object.assign(backend, { sizeUnitBase: () => 1000 as const });
    const { client } = await connect({ roleId: "builtin.operator", backend });
    const result = await call(client, "diskhound_move_to_trash", { paths: [`${ROOT}/Downloads/ubuntu.iso`, `${ROOT}/Downloads/installer.dmg`] });
    // 200 MiB is 210 MB in decimal units (macOS Finder's default).
    expect(text(result)).toContain("Moved 2 of 2 items (210 MB)");
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

describe("diskhound_delete_permanently", () => {
  it("passes the Session, de-duplicated paths and reason to confirmAndDelete, and rechecks files.delete", async () => {
    const { client, backend } = await connect({ roleId: "builtin.admin" });
    const result = await call(client, "diskhound_delete_permanently", {
      paths: [`${ROOT}/Downloads/ubuntu.iso`, `${ROOT}/Downloads/./ubuntu.iso`],
      reason: "Too big for the Trash",
    });
    expect(backend.confirmAndDelete).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: "Test Agent", roleName: "Cleanup Admin", paths: [`${ROOT}/Downloads/ubuntu.iso`], reason: "Too big for the Trash" }),
    );
    const [request] = backend.confirmAndDelete.mock.calls[0]!;
    await expect(request.recheck?.()).resolves.toBeUndefined();
    expect(backend.confirmAndTrash).not.toHaveBeenCalled();
    expect(structured(result)).toMatchObject({ confirmed: true, deletedCount: 1 });
    expect(text(result)).toMatch(/^Deleted 1 of 1 item \(.+\) permanently\./);
  });

  it("reports a declined confirmation without claiming anything was deleted", async () => {
    const { client, backend, activity } = await connect({ roleId: "builtin.admin" });
    backend.confirmAndDelete.mockResolvedValueOnce({ confirmed: false, results: [] });
    const result = await call(client, "diskhound_delete_permanently", { paths: [`${ROOT}/Movies/trip.mov`] });
    expect(text(result)).toBe("The user declined. Nothing was deleted.");
    expect(activity.entries.at(-1)).toMatchObject({ tool: "diskhound_delete_permanently", ok: true, summary: expect.stringContaining("declined") });
  });

  it("refuses an operator session before any dialog, and logs it", async () => {
    const security = new RecordingSecurity();
    const { client, backend } = await connect({ roleId: "builtin.operator", security });
    const result = await call(client, "diskhound_delete_permanently", { paths: ["/a"] });
    expect(result.isError).toBe(true);
    expect(backend.confirmAndDelete).not.toHaveBeenCalled();
    expect(security.events).toEqual([
      expect.objectContaining({
        kind: "tool_not_allowed",
        tool: "diskhound_delete_permanently",
        roleName: "Cleanup Operator",
        detail: "Tried to delete items permanently; Cleanup Operator doesn't allow it.",
      }),
    ]);
  });
});

describe("role filtering", () => {
  const listed = async (roleId: string) => {
    const role = BUILT_IN_MCP_ROLES.find((candidate) => candidate.id === roleId)!;
    const { client } = await connect({ roleId, granted: role.permissions });
    const { tools } = await client.listTools();
    return { client, role, names: tools.map((tool) => tool.name), tools };
  };

  it.each(BUILT_IN_MCP_ROLES.map((role) => role.id))("lists only the tools %s grants", async (roleId) => {
    const { role, names } = await listed(roleId);
    const expected = Object.entries(TOOL_CAPABILITIES)
      .filter(([, needs]) => needs.every((capability) => role.permissions.includes(capability)))
      .map(([name]) => name);
    expect(names.sort()).toEqual(expected.sort());
  });

  it("hides both removal tools from the default Cleanup Guide and says so in its instructions", async () => {
    const { client, names } = await listed("builtin.guide");
    expect(names).not.toContain("diskhound_move_to_trash");
    expect(names).not.toContain("diskhound_delete_permanently");
    expect(client.getInstructions()).toContain("This session can't move or delete files.");
  });

  it("shows the Trash but not permanent delete to Cleanup Operator", async () => {
    const { client, names } = await listed("builtin.operator");
    expect(names).toContain("diskhound_move_to_trash");
    expect(names).not.toContain("diskhound_delete_permanently");
    expect(client.getInstructions()).toContain("this session can't delete permanently");
  });

  it("drops showInApp from a Disk Explorer's tools, since it can't steer the window", async () => {
    const { tools } = await listed("builtin.reader");
    const list = tools.find((tool) => tool.name === "diskhound_list_folder")!;
    expect(Object.keys(list.inputSchema.properties ?? {})).not.toContain("showInApp");
  });

  it("logs a call that its role lost after the tool list was built", async () => {
    // The server was built for an Operator; the policy now says Reader.
    const security = new RecordingSecurity();
    const { client, backend, activity } = await connect({
      granted: roleAuthorization("builtin.operator").capabilities,
      authorizer: new FixedMcpAuthorizer(roleAuthorization("builtin.reader")),
      security,
    });
    const result = await call(client, "diskhound_move_to_trash", { paths: ["/a"] });
    expect(result.isError).toBe(true);
    expect(backend.confirmAndTrash).not.toHaveBeenCalled();
    expect(security.events).toEqual([
      expect.objectContaining({ kind: "tool_not_allowed", tool: "diskhound_move_to_trash", roleName: "Disk Explorer" }),
    ]);
    expect(activity.entries.at(-1)).toMatchObject({ tool: "diskhound_move_to_trash", ok: false });
  });

  it("maps every registered tool to the capabilities it needs", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(TOOL_CAPABILITIES).sort());
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

describe("diskhound_read_skill", () => {
  // Claude Desktop hands an extension's tools to its chats and Code
  // sessions, but not its resources.
  it("lists the skills and their files when called without a uri", async () => {
    const { client } = await connect({ roleId: "builtin.reader" });
    const value = structured(await call(client, "diskhound_read_skill"));
    expect(value.skills.map((skill: { uri: string }) => skill.uri)).toEqual([FREE_UP_SPACE_SKILL, INVESTIGATE_GROWTH_SKILL]);
    expect(value.skills[0].files).toContain("skill://diskhound-free-up-space/references/macos.md");
  });

  it("returns a skill file's text first, the same text resources/read serves", async () => {
    const { client, activity } = await connect();
    const result = await call(client, "diskhound_read_skill", { uri: FREE_UP_SPACE_SKILL });
    const value = structured(result);
    const read = await client.readResource({ uri: FREE_UP_SPACE_SKILL });
    expect(text(result)).toBe((read.contents[0] as { text: string }).text);
    expect(value).toMatchObject({ uri: FREE_UP_SPACE_SKILL, mimeType: "text/markdown" });
    expect(value.otherFiles).toContain("skill://diskhound-free-up-space/references/developer-caches.md");
    expect(value).not.toHaveProperty("text");
    expect(activity.entries.at(-1)).toMatchObject({ tool: "diskhound_read_skill", summary: "Read the diskhound-free-up-space skill", ok: true });

    const reference = await call(client, "diskhound_read_skill", { uri: "skill://diskhound-free-up-space/references/macos.md/" });
    expect(text(reference)).toContain("## APFS clones");
  });

  it("lists a skill folder's children", async () => {
    const { client } = await connect();
    const result = await call(client, "diskhound_read_skill", { uri: "skill://diskhound-free-up-space/references" });
    expect(text(result).split("\n")).toContain("skill://diskhound-free-up-space/references/linux.md");
  });

  it("reports an unknown uri as a tool error that says how to list them", async () => {
    const { client } = await connect();
    const result = await call(client, "diskhound_read_skill", { uri: "skill://diskhound-free-up-space/references/solaris.md" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Call diskhound_read_skill without a uri");
  });

  it("says so when the build has no skills", async () => {
    const { client } = await connect({ skills: { skills: [] } });
    expect(text(await call(client, "diskhound_read_skill"))).toBe("This DiskHound build has no skills.");
    expect(text(await call(client, "diskhound_status"))).not.toContain("diskhound_read_skill");
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

describe("scan completeness and shared storage", () => {
  it("reports the backend's uncapped visible folder count", async () => {
    const { client, backend } = await connect();
    const children = await backend.folderChildren(ROOT, ROOT);
    backend.folderChildren.mockResolvedValue({ ...children, visibleDirCount: 800,
      dirs: Array.from({ length: 200 }, (_, i) => ({ path: `${ROOT}/dir-${i}`, size: i, fileCount: 1 })) });
    const result = await call(client, "diskhound_list_folder", { path: ROOT, limit: 200 });
    expect(structured(result)).toMatchObject({ folderCount: 800, truncated: true });
    expect(structured(result).folders).toHaveLength(200);
    expect(text(result)).toContain("800 folders");
  });

  it("ranks groups by reclaimable bytes and preserves per-file sharing facts", async () => {
    const { client, backend } = await connect();
    const files = (sharing?: "clone" | "hardlink", reclaimableBytes?: number) => [0, 1].map((i) => ({
      path: `${ROOT}/${sharing ?? "ordinary"}-${i}`, name: `copy-${i}`, parentPath: ROOT,
      modifiedAt: NOW, sharing, reclaimableBytes,
    }));
    backend.duplicates.mockReturnValue({ running: false, progress: null, analysis: {
      rootPath: ROOT, analyzedAt: NOW, totalGroups: 4, totalDuplicateFiles: 8, totalWastedBytes: 120, filesWalked: 8, filesHashed: 8, elapsedMs: 10,
      groups: [
        { hash: "clone", size: 1000, reclaimableBytes: 0, files: files("clone", 0) },
        { hash: "hardlink", size: 2000, reclaimableBytes: 0, files: files("hardlink", 0) },
        { hash: "private", size: 1000, reclaimableBytes: 20, files: files("clone", 20) },
        { hash: "legacy", size: 100, files: files() },
      ],
    } });
    const result = structured(await call(client, "diskhound_duplicates"));
    expect(result.reclaimableBytes).toBe(120);
    expect(result.groups.map((group: { reclaimableBytes: number }) => group.reclaimableBytes)).toEqual([100, 20, 0, 0]);
    expect(result.groups[0].files[0]).toMatchObject({ reclaimableBytes: 100, sharing: null });
    expect(result.groups[1].files[0]).toMatchObject({ reclaimableBytes: 20, sharing: "clone" });
    expect(result.groups[2].files[0]).toMatchObject({ reclaimableBytes: 0, sharing: "clone" });
    expect(result.groups[3].files[0]).toMatchObject({ reclaimableBytes: 0, sharing: "hardlink" });
  });

  it("diskhound_dev_artifacts says what each tree frees alone and bounds the listed set together", async () => {
    const G = 1024 ** 3;
    const { client, backend } = await connect();
    const report = (await backend.devArtifacts(ROOT))!;
    const tree = (path: string, kind: "node-modules" | "rust-target" | "package-cache", size: number) => ({
      path, kind, projectPath: null, projectName: Path.basename(path), size, fileCount: 1, previousSize: null, deltaBytes: null,
    });
    backend.devArtifacts.mockResolvedValue({
      ...report,
      artifacts: [
        {
          ...tree(`${ROOT}/Developer/app/node_modules`, "node-modules", 2 * G),
          // 0.5 GB ordinary + 0.1 GB rewritten clone + 0.2 GB of groups it owns.
          clone: {
            cloneSize: 1.5 * G, clonePrivateSize: 0.1 * G, cloneInternalSize: 0.2 * G,
            cloneSharedSize: 1.2 * G, cloneSharedBlocks: 0.6 * G,
            sharedRoots: 1, sharedWith: [`${ROOT}/Library/pnpm/store`],
          },
        },
        {
          ...tree(`${ROOT}/Developer/app/target`, "rust-target", 6 * G),
          clone: { cloneSize: 0, clonePrivateSize: 0, cloneInternalSize: 0, cloneSharedSize: 0, cloneSharedBlocks: 0, sharedRoots: 0, sharedWith: [] },
        },
        // No clone data: counted at its size, with the path's hint.
        tree(`${ROOT}/Library/pnpm/store`, "package-cache", 1 * G),
      ],
    });
    const result = await call(client, "diskhound_dev_artifacts", {});
    const value = structured(result);
    const byPath = new Map(value.artifacts.map((artifact: { path: string }) => [artifact.path, artifact]));
    expect(byPath.get(`${ROOT}/Developer/app/node_modules`)).toMatchObject({
      sizeBytes: 2 * G, freesAloneBytes: 0.8 * G, sharedBytes: 1.2 * G, sharedWith: [`${ROOT}/Library/pnpm/store`],
    });
    expect(byPath.get(`${ROOT}/Developer/app/target`)).toMatchObject({ freesAloneBytes: 6 * G, sharedBytes: 0 });
    expect(byPath.get(`${ROOT}/Library/pnpm/store`)).not.toHaveProperty("freesAloneBytes");
    expect(byPath.get(`${ROOT}/Library/pnpm/store`)).toHaveProperty("sharingHint", expect.stringContaining("pnpm store"));
    expect(value.listed).toEqual({
      count: 3,
      sizeBytes: 9 * G,
      size: "9.0 GB",
      freesTogether: { atLeastBytes: 7.8 * G, atMostBytes: 8.4 * G, atLeast: "7.8 GB", atMost: "8.4 GB" },
    });
    expect(text(result)).toContain(
      "Removing the 3 listed (9.0 GB) frees 7.8 GB–8.4 GB, after APFS clones.\nFor the exact figure for the trees you pick, call diskhound_measure_removal with their paths.",
    );
    expect(value.notes[0]).toContain("freesAlone is what removing only that tree frees");
  });

  it("diskhound_dev_artifacts leaves out the freed-space fields when no tree was measured", async () => {
    const { client } = await connect();
    const value = structured(await call(client, "diskhound_dev_artifacts", {}));
    expect(value).not.toHaveProperty("listed");
    expect(value.artifacts[0]).not.toHaveProperty("freesAloneBytes");
  });
});

describe("diskhound_measure_removal", () => {
  const G = 1024 ** 3;

  it("passes de-duplicated absolute paths and reports the set, then each path, most freed first", async () => {
    const { client, backend, activity } = await connect({ roleId: "builtin.reader" });
    const result = await call(client, "diskhound_measure_removal", {
      paths: [`${ROOT}/wt/one`, `${ROOT}/wt/two`, `${ROOT}/wt/one`],
    });
    const value = structured(result);
    expect(backend.measureRemoval).toHaveBeenCalledWith([`${ROOT}/wt/one`, `${ROOT}/wt/two`], undefined);
    expect(value.total).toMatchObject({
      sizeBytes: 9 * G, size: "9.0 GB", freesBytes: 4 * G, frees: "4.0 GB",
      freesOneAtATimeBytes: 3 * G, heldElsewhereBytes: 2 * G, heldElsewhere: "2.0 GB",
    });
    expect(value.paths.map((path: { path: string }) => path.path)).toEqual([`${ROOT}/wt/two`, `${ROOT}/wt/one`]);
    expect(value.paths[0]).toMatchObject({ freesAloneBytes: 2 * G, freesAlone: "2.0 GB", sharedBytes: 3 * G });
    expect(value.measuredAt).toBe(new Date(NOW).toISOString());
    const summary = text(result);
    expect(summary).toContain("Removing these 2 items together frees 4.0 GB of the 9.0 GB they take up (3,000 files).");
    expect(summary).toContain("2.0 GB stays in use because files outside them share it");
    expect(summary).toContain("One at a time they'd free 3.0 GB; together frees 1.0 GB more");
    expect(value.notes.join(" ")).toContain("Time Machine local snapshot");
    expect(activity.entries.at(-1)).toMatchObject({ tool: "diskhound_measure_removal", summary: "Measured what removing 2 items frees", ok: true });
  });

  it("says when clones weren't checked and when some bytes are uncertain", async () => {
    const { client, backend } = await connect();
    backend.measureRemoval.mockResolvedValue({
      ...MEASUREMENT,
      cloneMetadata: false,
      total: { ...MEASUREMENT.total, uncertainBytes: G },
      missing: [`${ROOT}/gone`],
    });
    const result = await call(client, "diskhound_measure_removal", { paths: [`${ROOT}/wt/one`, `${ROOT}/gone`], limit: 1 });
    const value = structured(result);
    expect(value.paths).toHaveLength(1);
    expect(value.truncated).toBe(true);
    expect(value.notes.join(" ")).toContain("clones weren't checked");
    expect(value.notes.join(" ")).toContain("uncertainBytes");
    expect(text(result)).toContain("Up to 1.0 GB more might come back");
    expect(text(result)).toContain(`Not found: ${ROOT}/gone.`);
  });

  it("refuses a whole drive and relative paths before measuring", async () => {
    const { client, backend } = await connect();
    const drive = await call(client, "diskhound_measure_removal", { paths: ["/"] });
    expect(drive.isError).toBe(true);
    expect(text(drive)).toContain("is a whole drive");
    const relative = await call(client, "diskhound_measure_removal", { paths: ["wt/one"] });
    expect(relative.isError).toBe(true);
    expect(backend.measureRemoval).not.toHaveBeenCalled();
  });

  it("isn't offered where the backend can't measure (Windows)", async () => {
    const backend = createFakeBackend();
    const { measureRemoval: _unused, ...windows } = backend;
    const { client } = await connect({ backend: { ...windows, platform: "win32" } as unknown as FakeBackend });
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("diskhound_measure_removal");
  });
});
