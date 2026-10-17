import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { unzip } from "../src/test/zipReader";
import { BIN, callTool, openReview, resultText, reviewRow, stubTrash, waitForAgentServer } from "./fixtures/agent";
import { expect, test, type AppHandle } from "./fixtures/electron-app";
import { openTab, scanFolderFromPicker } from "./fixtures/steps";

const executable = join(process.cwd(), "native", "diskhound-mcp", "target", "debug", process.platform === "win32" ? "diskhound-mcp.exe" : "diskhound-mcp");

/**
 * Linux E2E points DiskHound at a temp HOME so it does not write the
 * developer's real data directory. The listener key lives there. The
 * helper has to see that same HOME, or it never asks for approval.
 */
function helperEnv(handle: AppHandle): Record<string, string> | undefined {
  if (process.platform !== "linux") return undefined;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.HOME = join(handle.dataDir, "home");
  return env;
}

interface ConnectOptions {
  /** clientInfo.name: "claude-code", or Claude Desktop's extension name. */
  name?: string;
  command?: string;
  args?: string[];
  /** List tools right after connecting, before the user decides, as Claude Desktop does. */
  listEarly?: boolean;
}

/**
 * Connect through the helper. It answers initialize at once and asks the
 * user in the background, so the decision lands after connect returns.
 */
async function connect(handle: AppHandle, decision: "Approve" | "Deny", options: ConnectOptions = {}) {
  const { name = "claude-code", command = executable, args = ["--port", String(handle.agentPort)] } = options;
  await waitForAgentServer(handle);
  const client = new Client({ name, version: "0.1.0" });
  let toolsChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    toolsChanged += 1;
  });
  // Never touch the developer's real OS credential store.
  const transport = new StdioClientTransport({ command, args: ["--ephemeral", ...args], env: helperEnv(handle), stderr: "pipe" });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk) => { diagnostics += chunk.toString(); });
  const opened = handle.app.waitForEvent("window", {
    predicate: async (page) => {
      await page.waitForLoadState("domcontentloaded");
      return /[?&]consent=1\b/.test(page.url());
    },
  });
  // Catch now so an early failure doesn't become an unhandled rejection.
  const connected = client.connect(transport).then(() => null, (error: Error) => error);
  const listed = options.listEarly ? connected.then(() => client.listTools()) : null;
  const approval = await opened;
  const label = name === "claude-code" ? "Claude Code" : "Claude Desktop";
  await expect(approval.locator("h1")).toHaveText(`Approve ${label}?`);
  await expect(approval.locator(".agent-consent-eyebrow")).toContainText("via stdio helper");
  const closed = approval.waitForEvent("close");
  try { await approval.getByRole("button", { name: decision }).click(); }
  catch (error) { if (!approval.isClosed()) throw error; }
  await closed;
  return { client, transport, error: await connected, listed, diagnostics: () => diagnostics, toolsChanged: () => toolsChanged };
}

test("stdio approves natively, calls deferred tools, reads skills, and respects revocation", async ({ launch }) => {
  const handle = await launch({ settings: { agents: { enabled: true } } });
  const agent = await connect(handle, "Approve");
  try {
    expect(agent.error, agent.diagnostics()).toBeNull();
    // A host's search can load one tool without ever sending tools/list.
    const status = await callTool(agent.client, "diskhound_status");
    expect(status.isError, resultText(status)).not.toBe(true);
    expect(agent.client.getInstructions()).toContain("tool catalog");
    expect(agent.client.getInstructions()!.length).toBeLessThanOrEqual(2048);
    const skill = await agent.client.readResource({ uri: "skill://diskhound-free-up-space/SKILL.md" });
    expect(JSON.stringify(skill.contents)).toContain("you decide what to keep or remove");
    // Cleanup Guide, the default, lists no tool that removes files.
    const names = async () => (await agent.client.listTools()).tools.map((tool) => tool.name);
    expect(await names()).not.toContain("diskhound_move_to_trash");
    await openTab(handle.page, "Settings");
    const section = handle.page.locator("#settings-ai-agents");
    const row = section.locator(".agent-session-row", { hasText: "Claude Code" });
    await expect(row.locator(".agent-via")).toHaveText("stdio");

    // A bigger role reaches the agent without reconnecting: the helper
    // sees the new permissions on its next call and reloads the tools.
    await row.locator("select").selectOption("builtin.operator");
    await expect(handle.page.locator(".toast-body", { hasText: "reloads its tools on its own" })).toBeVisible();
    const changedBefore = agent.toolsChanged();
    expect((await callTool(agent.client, "diskhound_status")).isError).not.toBe(true);
    await expect.poll(() => agent.toolsChanged()).toBeGreaterThan(changedBefore);
    expect(await names()).toContain("diskhound_move_to_trash");

    // The prompt for Claude Code, and the command behind it, name this helper.
    await section.getByRole("button", { name: /^Connect another agent/ }).click();
    await section.locator(".agent-client-tabs button", { hasText: "Claude Code" }).click();
    await expect(section.locator(".agent-prompt-text")).toContainText("Add diskhound to my Claude Code user configuration");
    await expect(section.locator(".agent-prompt-text")).toContainText(executable);
    await section.getByRole("button", { name: "Show command" }).click();
    await expect(section.locator(".agent-command-text", { hasText: "--transport stdio" })).toContainText(executable);
    await section.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(section.locator(".agent-session-row")).toHaveCount(0);
    await expect(callTool(agent.client, "diskhound_status")).rejects.toThrow(/revoked|closed/i);
    expect(agent.diagnostics()).not.toContain("dhmcp_");
  } finally { await agent.client.close(); }
});

test("Add to Claude hands Claude an extension whose helper connects as Claude Desktop", async ({ launch }, testInfo) => {
  test.skip(process.platform === "linux", "Claude Desktop isn't made for Linux");
  const handle = await launch({ settings: { agents: { enabled: true } } });
  // Claude would show its install dialog; keep the file instead.
  await handle.app.evaluate(({ shell }) => {
    const stub = shell as unknown as { openPath: (target: string) => Promise<string>; __opened?: string };
    stub.openPath = async (target) => {
      stub.__opened = target;
      return "";
    };
  });
  await openTab(handle.page, "Settings");
  const section = handle.page.locator("#settings-ai-agents");
  await section.locator(".agent-client-tabs button", { hasText: "Claude Desktop" }).click();
  await section.getByRole("button", { name: "Add to Claude" }).click();
  await expect(section.locator(".agent-step-result")).toHaveText("Opened in Claude.");
  const bundle = await handle.app.evaluate(({ shell }) => (shell as unknown as { __opened?: string }).__opened);
  expect(bundle).toMatch(/DiskHound\.mcpb$/);

  // Install it the way Claude does: unpack, then run the manifest's command.
  const installed = testInfo.outputPath("claude-extension");
  for (const entry of unzip(readFileSync(bundle!))) {
    mkdirSync(dirname(join(installed, entry.name)), { recursive: true });
    writeFileSync(join(installed, entry.name), entry.data, { mode: entry.mode });
  }
  const manifest = JSON.parse(readFileSync(join(installed, "manifest.json"), "utf8"));
  expect(readFileSync(join(installed, manifest.server.entry_point)).equals(readFileSync(executable))).toBe(true);
  // Claude Desktop lists tools once, right after connecting, and keeps
  // that list: the helper holds it until the user decides.
  const agent = await connect(handle, "Approve", {
    name: "local-agent-mode-DiskHound",
    command: manifest.server.mcp_config.command.replace("${__dirname}", installed),
    args: manifest.server.mcp_config.args,
    listEarly: true,
  });
  try {
    expect(agent.error, agent.diagnostics()).toBeNull();
    const listed = (await agent.listed!).tools.map((tool) => tool.name);
    expect(listed).toContain("diskhound_list_folder");
    expect((await callTool(agent.client, "diskhound_status")).isError).not.toBe(true);
    // Claude passes on only tools, so the skills have to come through one.
    expect(listed).toContain("diskhound_read_skill");
    const skill = await callTool(agent.client, "diskhound_read_skill", { uri: "skill://diskhound-free-up-space/SKILL.md" });
    expect(skill.isError).not.toBe(true);
    expect(resultText(skill)).toContain("# Free up disk space with DiskHound");
    // The guide recognizes Claude Desktop, so its last step stops waiting.
    await expect(section.locator(".agent-session-row .agent-session-title")).toHaveText("Claude Desktop");
    await section.getByRole("button", { name: /^Connect another agent/ }).click();
    await section.locator(".agent-client-tabs button", { hasText: "Claude Desktop" }).click();
    await expect(section.locator(".agent-live.connected")).toContainText("Connected as Claude Desktop");
  } finally { await agent.client.close(); }
});

test("stdio denial fails the connection without exposing credentials", async ({ launch }) => {
  const handle = await launch({ settings: { agents: { enabled: true } } });
  const agent = await connect(handle, "Deny");
  try {
    // Connected before the user answered; the next call says no.
    expect(agent.error, agent.diagnostics()).toBeNull();
    const status = await callTool(agent.client, "diskhound_status");
    expect(resultText(status)).toContain("The user denied this connection in DiskHound");
    expect(agent.diagnostics()).not.toContain("dhmcp_");
    await openTab(handle.page, "Settings");
    await expect(handle.page.locator("#settings-ai-agents .agent-session-row")).toHaveCount(0);
  } finally { await agent.client.close(); }
});

test("stdio EOF exits while approval is pending, and withdraws it", async ({ launch }) => {
  const handle = await launch({ settings: { agents: { enabled: true } } });
  await waitForAgentServer(handle);
  const opened = handle.app.waitForEvent("window");
  const child = spawn(executable, ["--ephemeral", "--port", String(handle.agentPort)], { stdio: "pipe", env: helperEnv(handle) });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.resume();
  const exited = once(child, "exit");
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "eof", version: "1" } } }) + "\n");
    const approval = await opened;
    await expect(approval.locator(".agent-consent")).toBeVisible();
    // Hanging up withdraws the request, so its sheet closes by itself.
    const sheetClosed = approval.waitForEvent("close");
    child.stdin.end();
    await expect.poll(() => child.exitCode).toBe(0);
    await exited;
    await sheetClosed;
    // initialize was answered at once; nothing else was sent.
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 1, result: { serverInfo: { name: "diskhound" } } });
  } finally { if (child.exitCode === null) child.kill(); }
});


test("a Trash request outlives the agent's connection", async ({ launch, scanTree }, testInfo) => {
  const handle = await launch({ settings: { agents: { enabled: true } } });
  await scanFolderFromPicker(handle, scanTree.root);
  const trashDir = testInfo.outputPath("stdio-trash");
  const trash = await stubTrash(handle, trashDir);
  const agent = await connect(handle, "Approve");
  const target = join(scanTree.root, "docs");
  try {
    expect(agent.error, agent.diagnostics()).toBeNull();
    await openTab(handle.page, "Settings");
    await handle.page.locator("#settings-ai-agents .agent-session-row select").selectOption("builtin.operator");
    // The call returns as soon as the item is on the list, then the agent hangs up.
    const queued = await callTool(agent.client, "diskhound_move_to_trash", { paths: [target], reason: "Test disconnect" });
    expect(queued.isError, resultText(queued)).not.toBe(true);
    expect(queued.structuredContent).toMatchObject({ queued: true, items: [{ path: target }] });
    await agent.client.close();
    await expect(handle.page.locator(".agent-activity-row").first()).toContainText(`Asked to move 1 item to the ${BIN}`);
    expect(existsSync(target)).toBe(true);

    // The user approves later; the request is still there.
    const sheet = await openReview(handle.page);
    await sheet.getByRole("button", { name: `Move 1 to ${BIN}` }).click();
    await expect(reviewRow(sheet, target).locator(".rv-result")).toHaveText(`Moved to the ${BIN}`);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(trashDir, "docs"))).toBe(true);
    expect(await trash.dialogs()).toEqual([]);
  } finally {
    await agent.client.close();
    rmSync(trashDir, { recursive: true, force: true });
  }
});
