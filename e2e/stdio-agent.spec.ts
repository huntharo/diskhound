import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { callTool, resultText, stubTrash, waitForAgentServer } from "./fixtures/agent";
import { expect, test, type AppHandle } from "./fixtures/electron-app";
import { openTab, scanFolderFromPicker } from "./fixtures/steps";

const executable = join(process.cwd(), "native", "diskhound-mcp", "target", "debug", process.platform === "win32" ? "diskhound-mcp.exe" : "diskhound-mcp");

async function connect(handle: AppHandle, decision: "Approve" | "Deny") {
  await waitForAgentServer(handle);
  const client = new Client({ name: "stdio-e2e", version: "1" });
  // Never touch the developer's real OS credential store.
  const transport = new StdioClientTransport({ command: executable, args: ["--ephemeral", "--port", String(handle.agentPort)], stderr: "pipe" });
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
  const approval = await opened;
  await expect(approval.locator(".agent-consent")).toContainText("DiskHound stdio");
  const closed = approval.waitForEvent("close");
  try { await approval.getByRole("button", { name: decision }).click(); }
  catch (error) { if (!approval.isClosed()) throw error; }
  await closed;
  return { client, transport, error: await connected, diagnostics: () => diagnostics };
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
    const listed = await agent.client.listTools();
    expect(listed.tools.some((tool) => tool.name === "diskhound_move_to_trash")).toBe(true);
    await openTab(handle.page, "Settings");
    const section = handle.page.locator("#settings-ai-agents");
    await expect(section.locator(".agent-recipe-command").first()).toContainText("--transport stdio");
    await expect(section.locator(".agent-recipe-command").first()).toContainText(executable);
    await section.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(section.locator(".agent-session-row")).toHaveCount(0);
    await expect(callTool(agent.client, "diskhound_status")).rejects.toThrow(/revoked|closed/i);
    expect(agent.diagnostics()).not.toContain("dhmcp_");
  } finally { await agent.client.close(); }
});

test("stdio denial fails the connection without exposing credentials", async ({ launch }) => {
  const handle = await launch({ settings: { agents: { enabled: true } } });
  const agent = await connect(handle, "Deny");
  try {
    expect(agent.error?.message).toMatch(/denied|closed/i);
    expect(agent.diagnostics()).not.toContain("dhmcp_");
    await openTab(handle.page, "Settings");
    await expect(handle.page.locator("#settings-ai-agents .agent-session-row")).toHaveCount(0);
  } finally { await agent.client.close(); }
});

test("stdio EOF exits while approval is pending", async ({ launch }) => {
  const handle = await launch({ settings: { agents: { enabled: true } } });
  await waitForAgentServer(handle);
  const opened = handle.app.waitForEvent("window");
  const child = spawn(executable, ["--ephemeral", "--port", String(handle.agentPort)], { stdio: "pipe" });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.resume();
  const exited = once(child, "exit");
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "eof", version: "1" } } }) + "\n");
    const approval = await opened;
    await expect(approval.locator(".agent-consent")).toBeVisible();
    child.stdin.end();
    await expect.poll(() => child.exitCode).toBe(0);
    await exited;
    expect(stdout).toBe("");
  } finally { if (child.exitCode === null) child.kill(); }
});


test("closing stdio cancels a pending Trash request", async ({ launch, scanTree }, testInfo) => {
  const handle = await launch({ settings: { agents: { enabled: true } } });
  await scanFolderFromPicker(handle, scanTree.root);
  const trashDir = testInfo.outputPath("stdio-trash");
  await stubTrash(handle, trashDir);
  const agent = await connect(handle, "Approve");
  const target = join(scanTree.root, "docs");
  try {
    expect(agent.error, agent.diagnostics()).toBeNull();
    await openTab(handle.page, "Settings");
    await handle.page.locator("#settings-ai-agents .agent-session-row select").selectOption("builtin.operator");
    await handle.app.evaluate(({ dialog }) => {
      const stub = dialog as unknown as { showMessageBox: () => Promise<unknown>; __release?: () => void };
      stub.showMessageBox = () => new Promise((resolve) => {
        stub.__release = () => resolve({ response: 0, checkboxChecked: false });
      });
    });
    const pending = callTool(agent.client, "diskhound_move_to_trash", { paths: [target], reason: "Test disconnect" }).catch(() => null);
    await expect.poll(() => handle.app.evaluate(({ dialog }) => typeof (dialog as unknown as { __release?: () => void }).__release)).toBe("function");
    await agent.client.close();
    await pending;
    await handle.app.evaluate(({ dialog }) => { (dialog as unknown as { __release: () => void }).__release(); });
    // Wait for the tool to finish after its dialog resolves; the file must stay.
    await expect.poll(() => handle.page.locator(".agent-activity-row").first().textContent()).toMatch(/cancel|disconnect|closed/i);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(trashDir)).toBe(false);
  } finally {
    await agent.client.close();
    rmSync(trashDir, { recursive: true, force: true });
  }
});
