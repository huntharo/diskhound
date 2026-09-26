import { existsSync, rmSync } from "node:fs";
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

  // The pill opens Settings, which lists the session and what it did.
  await page.locator(".agent-pill").click();
  const section = page.locator("#settings-ai-agents");
  await expect(section.locator(".agent-session-row")).toHaveCount(1);
  await expect(section.locator(".agent-session-row .protected-folder-name")).toHaveText("Follow-along");
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

  // The approval window preselects Cleanup Guide, which can't ask.
  const denied = await callTool(agent, "diskhound_move_to_trash", request);
  expect(denied.isError).toBe(true);
  expect(resultText(denied)).toContain("does not grant: files.trash");
  await expect(page.locator(".agent-pill")).toHaveClass(/\bfailed\b/);

  // The user raises the role in Settings. The next call uses it.
  await openTab(page, "Settings");
  const role = page.locator("#settings-ai-agents .agent-session-row select");
  await role.selectOption("builtin.operator");
  await expect(role).toHaveValue("builtin.operator");

  // The home folder is refused before any dialog.
  const home = await handle.app.evaluate(({ app }) => app.getPath("home"));
  const refused = await callTool(agent, "diskhound_move_to_trash", { paths: [home] });
  expect(refused.isError).toBe(true);
  expect(resultText(refused)).toContain("never lets agents move this folder");
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
