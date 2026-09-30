import { existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import {
  callTool,
  connectAgent,
  mcpStatus,
  resultText,
  signIn,
  signInDenied,
  stubTrash,
  turnOnAgents,
} from "./fixtures/agent";
import { expect, test } from "./fixtures/electron-app";
import { openTab, scanFolderFromPicker, tab } from "./fixtures/steps";

// Keep the stub Trash out of the uploaded CI artifacts.
test.afterEach(({}, testInfo) => {
  rmSync(testInfo.outputPath("trash"), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("an approved agent reads the scan and the window follows it", async ({ launch, scanTree }) => {
  const handle = await launch();
  const { page } = handle;
  await scanFolderFromPicker(handle, scanTree.root);

  await turnOnAgents(page);
  const agent = await connectAgent(handle, await signIn(handle, { sessionName: "Follow-along" }));

  // The cleanup procedures load from the app's skills folder, as skill
  // resources and as prompts for clients that don't read skills.
  const skill = await agent.readResource({ uri: "skill://diskhound-free-up-space/SKILL.md" });
  expect(JSON.stringify(skill.contents)).toContain("Time Machine");
  const { prompts } = await agent.listPrompts();
  expect(prompts.map((prompt) => prompt.name)).toEqual(
    expect.arrayContaining(["free-up-space", "investigate-growth"]),
  );

  const videos = join(scanTree.root, "videos");
  const listed = await callTool(agent, "diskhound_list_folder", { path: videos, showInApp: true, includeFiles: true });
  expect(listed.isError, resultText(listed)).not.toBe(true);
  expect(listed.structuredContent).toMatchObject({ fileCount: 2 });

  // The window opens the same folder, and the header names the session.
  await expect(tab(page, "Folders")).toHaveClass(/\bactive\b/);
  await expect(page.locator(".folder-crumb.active")).toHaveText("videos");
  await expect(page.locator(".agent-pill")).toHaveClass(/\bactive\b/);
  await expect(page.locator(".agent-pill-name")).toHaveText("Follow-along");

  // Exercise both sides of the responsive breakpoint independently of the
  // runner's display size. Its initial native window may already be narrow.
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.setViewportSize({ width: 1000, height: 720 });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1000);
  await expect(page.locator(".agent-pill-name")).toBeHidden();
  await expect(page.locator(".agent-pill")).toHaveAccessibleName(/Follow-along/);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1280);
  await expect(page.locator(".agent-pill-name")).toBeVisible();
  await page.setViewportSize(viewport);

  // The pill opens a popover with the session and what it did last.
  await page.locator(".agent-pill").click();
  const popover = page.locator(".agent-pop");
  await expect(popover.locator(".agent-pop-row")).toHaveCount(1);
  await expect(popover.locator(".agent-pop-name")).toHaveText("Follow-along");
  await expect(popover.locator(".agent-pop-what")).toContainText("videos");

  // Its link opens Settings → AI Agents, which lists the session too.
  await popover.getByRole("button", { name: "AI Agents settings…" }).click();
  await expect(popover).toHaveCount(0);
  const section = page.locator("#settings-ai-agents");
  await expect(section.locator(".agent-session-row")).toHaveCount(1);
  await expect(section.locator(".agent-session-row .agent-session-title")).toHaveText("Follow-along");
  await expect(section.locator(".agent-session-row select")).toHaveValue("builtin.guide");
  await expect(section.locator(".agent-activity-row").first()).toContainText("Listed");
  await expect(section.locator(".agent-activity-row").first()).toContainText("videos");

  await agent.close();
});

test("only a Cleanup Operator can ask for the Trash, and the user decides", async ({ launch, scanTree }, testInfo) => {
  const handle = await launch({ settings: { agents: { enabled: true } } });
  const { page } = handle;
  await scanFolderFromPicker(handle, scanTree.root);
  const trashDir = testInfo.outputPath("trash");
  const trash = await stubTrash(handle, trashDir);
  const agent = await connectAgent(handle, await signIn(handle, { sessionName: "Tidy-up" }));
  const docs = join(scanTree.root, "docs");
  const request = { paths: [docs], reason: "Old reports" };

  // The approval window preselects Cleanup Guide, which doesn't list
  // the Trash tool. Calling it anyway is refused and logged.
  expect((await agent.listTools()).tools.map((tool) => tool.name)).not.toContain("diskhound_move_to_trash");
  const denied = await callTool(agent, "diskhound_move_to_trash", request);
  expect(denied.isError).toBe(true);
  expect(resultText(denied)).toContain("Cleanup Guide doesn't grant files.trash");
  expect(resultText(denied)).toContain("DiskHound logged the attempt");
  await expect(page.locator(".agent-pill")).toHaveClass(/\bfailed\b/);
  await expect(page.locator(".toast-title", { hasText: "Blocked a request from Tidy-up" })).toBeVisible();

  // The user raises the role in Settings. The next call uses it.
  await openTab(page, "Settings");
  await expect(page.locator("#settings-ai-agents .agent-blocked-row").first()).toContainText("Tried to move items to the Trash");
  const role = page.locator("#settings-ai-agents .agent-session-row select");
  await role.selectOption("builtin.operator");
  await expect(role).toHaveValue("builtin.operator");

  // The home folder is refused before any dialog.
  const home = await handle.app.evaluate(({ app }) => app.getPath("home"));
  const refused = await callTool(agent, "diskhound_move_to_trash", { paths: [home] });
  expect(refused.isError).toBe(true);
  expect(resultText(refused)).toContain("never lets agents remove this folder");
  expect(await trash.prompts()).toHaveLength(0);

  // Cancel, the default button, moves nothing.
  const declined = await callTool(agent, "diskhound_move_to_trash", request);
  expect(resultText(declined)).toContain("The user declined");
  expect(existsSync(docs)).toBe(true);
  const [prompt] = await trash.prompts();
  expect(prompt.message).toMatch(/^“Tidy-up” wants to move 1 item \(\d[\d.]* [KM]B\) to the (Trash|Recycle Bin)\.$/);
  expect(prompt.detail).toContain("Reason: Old reports");
  expect(prompt.detail).toContain("docs");

  // Move to Trash moves it, and Folders keeps the row marked as trashed.
  await trash.answer("move");
  const moved = await callTool(agent, "diskhound_move_to_trash", request);
  expect(moved.isError, resultText(moved)).not.toBe(true);
  expect(moved.structuredContent).toMatchObject({ confirmed: true, movedCount: 1 });
  expect(existsSync(docs)).toBe(false);
  expect(existsSync(join(trashDir, "docs"))).toBe(true);

  await openTab(page, "Folders");
  await expect(page.locator(".folder-row.deleted", { hasText: "docs" }).locator(".deleted-path-badge")).toBeVisible();

  await agent.close();
});

test("only a Cleanup Admin can delete permanently, and every other attempt is logged", async ({ launch, scanTree }, testInfo) => {
  const handle = await launch({ settings: { agents: { enabled: true } } });
  const { page } = handle;
  await scanFolderFromPicker(handle, scanTree.root);
  const trash = await stubTrash(handle, testInfo.outputPath("trash"));
  const docs = join(scanTree.root, "docs");
  const request = { paths: [docs], reason: "Too big for the Trash" };

  // A Cleanup Operator can ask for the Trash, but not for a permanent delete.
  const operator = await connectAgent(handle, await signIn(handle, { sessionName: "Operator", roleId: "builtin.operator" }));
  const operatorTools = (await operator.listTools()).tools.map((tool) => tool.name);
  expect(operatorTools).toContain("diskhound_move_to_trash");
  expect(operatorTools).not.toContain("diskhound_delete_permanently");
  const refused = await callTool(operator, "diskhound_delete_permanently", request);
  expect(refused.isError).toBe(true);
  expect(resultText(refused)).toContain("Cleanup Operator doesn't grant files.delete");
  expect(await trash.prompts()).toHaveLength(0);
  await openTab(page, "Settings");
  const section = page.locator("#settings-ai-agents");
  await expect(section.locator(".agent-blocked-row").first()).toContainText("Tried to delete items permanently");
  await expect(section.locator(".agent-session-row", { hasText: "Operator" }).locator(".agent-blocked-link")).toHaveText("1 blocked");
  // agent-security.log keeps it across restarts.
  const log = join(handle.userDataDir, "agent-security.log");
  await expect.poll(() => (existsSync(log) ? readFileSync(log, "utf8") : "")).toContain("diskhound_delete_permanently");
  await operator.close();

  // Cleanup Admin: the approval sheet warns what it adds, and the user
  // still confirms the delete itself.
  const admin = await connectAgent(handle, await signIn(handle, { sessionName: "Admin", roleId: "builtin.admin" }));
  expect((await admin.listTools()).tools.map((tool) => tool.name)).toContain("diskhound_delete_permanently");
  const declined = await callTool(admin, "diskhound_delete_permanently", request);
  expect(resultText(declined)).toBe("The user declined. Nothing was deleted.");
  expect(existsSync(docs)).toBe(true);
  const [prompt] = await trash.prompts();
  expect(prompt.message).toMatch(/^“Admin” wants to permanently delete 1 item \(\d[\d.]* [KM]B\)\.$/);
  expect(prompt.detail).toContain("Deleted items can't be restored.");

  await trash.answer("move");
  const deleted = await callTool(admin, "diskhound_delete_permanently", request);
  expect(deleted.isError, resultText(deleted)).not.toBe(true);
  expect(deleted.structuredContent).toMatchObject({ confirmed: true, deletedCount: 1 });
  expect(existsSync(docs)).toBe(false);
  expect(existsSync(join(testInfo.outputPath("trash"), "docs"))).toBe(false);
  await admin.close();
});

test("an approval survives a restart, and Revoke locks the agent out", async ({ launch }) => {
  const first = await launch({ settings: { agents: { enabled: true } } });

  // Deny sends the agent back with access_denied and approves nothing.
  const deniedAt = await signInDenied(first, "Stranger");
  expect(deniedAt.searchParams.get("error")).toBe("access_denied");

  const token = await signIn(first, { sessionName: "Keeper" });
  await first.close();

  // Same profile and port: the server comes back on and the token works.
  const second = await launch({ dataDir: first.dataDir, agentPort: first.agentPort });
  const agent = await connectAgent(second, token);
  const status = await callTool(agent, "diskhound_status");
  expect(status.isError, resultText(status)).not.toBe(true);

  await openTab(second.page, "Settings");
  const section = second.page.locator("#settings-ai-agents");
  await expect(section.locator(".agent-session-row")).toHaveCount(1);
  await section.locator(".agent-session-row", { hasText: "Keeper" }).getByRole("button", { name: "Revoke" }).click();
  await expect(section.locator(".agent-session-row")).toHaveCount(0);
  await expect(section.locator(".agent-revoked")).toContainText("Keeper");

  expect(await mcpStatus(second, token)).toBe(401);
  await agent.close();
});


test("protected folders remain protected through symlinked ancestors", async ({ launch, scanTree }, testInfo) => {
  const alias = join(scanTree.root, "alias");
  symlinkSync(scanTree.root, alias, process.platform === "win32" ? "junction" : "dir");
  const protectedPath = join(alias, "docs");
  const handle = await launch({ settings: { agents: { enabled: true }, scanning: { excludedFolderPaths: [protectedPath] } } });
  const trash = await stubTrash(handle, testInfo.outputPath("trash"));
  await trash.answer("move");
  const agent = await connectAgent(handle, await signIn(handle, { roleId: "builtin.operator" }));
  try {
    for (const path of [protectedPath, join(scanTree.root, "docs"), scanTree.root]) {
      const result = await callTool(agent, "diskhound_move_to_trash", { paths: [path] });
      expect(result.isError, resultText(result)).toBe(true);
      expect(resultText(result)).toContain("Protected folder");
    }
    expect(await trash.prompts()).toHaveLength(0);
    expect(existsSync(join(scanTree.root, "docs"))).toBe(true);
  } finally { await agent.close(); }
});
