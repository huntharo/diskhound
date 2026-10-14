import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BIN,
  callTool,
  chooseAction,
  connectAgent,
  mcpStatus,
  openReview,
  resultText,
  reviewRow,
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

test("only a Cleanup Operator can ask for the Trash, and the user approves it in DiskHound", async ({ launch, scanTree }, testInfo) => {
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

  // The home folder is refused before it reaches the list.
  const home = await handle.app.evaluate(({ app }) => app.getPath("home"));
  const refused = await callTool(agent, "diskhound_move_to_trash", { paths: [home] });
  expect(refused.isError).toBe(true);
  expect(resultText(refused)).toContain("never lets agents remove this folder");

  // The request returns at once: the item waits on the review list.
  const queued = await callTool(agent, "diskhound_move_to_trash", request);
  expect(queued.isError, resultText(queued)).not.toBe(true);
  expect(resultText(queued)).toMatch(/^Added 1 item \(\d[\d.]* [KM]B\) to DiskHound's review list\. Nothing has moved yet\./);
  expect(queued.structuredContent).toMatchObject({ queued: true, waitingForUser: true, action: "trash", items: [{ path: docs, trash: "yes" }] });
  expect(existsSync(docs)).toBe(true);
  const waiting = await callTool(agent, "diskhound_status");
  expect(resultText(waiting)).toMatch(/Removal requests: 1 item \(.+\) waiting for the user to review in DiskHound/);

  // A quiet count in the header: no dialog, no focus taken.
  await expect(page.locator(".agent-pill.review .agent-pill-count")).toHaveText("1");
  await expect(page.locator(".rv-sheet")).toHaveCount(0);
  const sheet = await openReview(page);
  const row = reviewRow(sheet, docs);
  await expect(sheet.locator(".rv-group-name")).toHaveText(["Tidy-up"]);
  await expect(sheet.locator(".rv-reason")).toHaveText("“Old reports”");
  await expect(row.locator(".rv-check")).toBeChecked();
  // A Cleanup Operator can't delete, so the Trash is the only action.
  await expect(row.getByRole("radio")).toHaveCount(0);
  await sheet.getByRole("button", { name: `Move 1 to ${BIN}` }).click();
  await expect(sheet.locator(".rv-done")).toHaveText(/^Removed 1 item for 1 agent\. Moved 1 to the (Trash|Recycle Bin)/);
  await expect(row.locator(".rv-result")).toHaveText(`Moved to the ${BIN}`);
  expect(existsSync(docs)).toBe(false);
  expect(existsSync(join(trashDir, "docs"))).toBe(true);
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".agent-pill.review")).toHaveCount(0);

  // The agent reads what the user decided.
  const decided = await callTool(agent, "diskhound_status");
  expect(resultText(decided)).toMatch(/Removal request decided .+: Moved 1 item to the (Trash|Recycle Bin)/);
  expect(await trash.dialogs()).toEqual([]);

  // Folders keeps the row marked as trashed.
  await openTab(page, "Folders");
  await expect(page.locator(".folder-row.deleted", { hasText: "docs" }).locator(".deleted-path-badge")).toBeVisible();

  await agent.close();
});

test("only a Cleanup Admin can ask for a permanent delete, and the user picks what runs", async ({ launch, scanTree }, testInfo) => {
  const handle = await launch({ settings: { agents: { enabled: true } } });
  const { page } = handle;
  await scanFolderFromPicker(handle, scanTree.root);
  const trashDir = testInfo.outputPath("trash");
  const trash = await stubTrash(handle, trashDir);
  const docs = join(scanTree.root, "docs");
  const clip = join(scanTree.root, "videos", "clip.mov");
  const archive = join(scanTree.root, "archive.zip");

  // A Cleanup Operator can ask for the Trash, but not for a permanent delete.
  const operator = await connectAgent(handle, await signIn(handle, { sessionName: "Operator", roleId: "builtin.operator" }));
  const operatorTools = (await operator.listTools()).tools.map((tool) => tool.name);
  expect(operatorTools).toContain("diskhound_move_to_trash");
  expect(operatorTools).not.toContain("diskhound_delete_permanently");
  const refused = await callTool(operator, "diskhound_delete_permanently", { paths: [docs] });
  expect(refused.isError).toBe(true);
  expect(resultText(refused)).toContain("Cleanup Operator doesn't grant files.delete");
  await openTab(page, "Settings");
  const section = page.locator("#settings-ai-agents");
  await expect(section.locator(".agent-blocked-row").first()).toContainText("Tried to delete items permanently");
  await expect(section.locator(".agent-session-row", { hasText: "Operator" }).locator(".agent-blocked-link")).toHaveText("1 blocked");
  // agent-security.log keeps it across restarts.
  const log = join(handle.userDataDir, "agent-security.log");
  await expect.poll(() => (existsSync(log) ? readFileSync(log, "utf8") : "")).toContain("diskhound_delete_permanently");
  await operator.close();

  // Cleanup Admin: the request waits on the list like any other.
  const admin = await connectAgent(handle, await signIn(handle, { sessionName: "Admin", roleId: "builtin.admin" }));
  expect((await admin.listTools()).tools.map((tool) => tool.name)).toContain("diskhound_delete_permanently");
  const queued = await callTool(admin, "diskhound_delete_permanently", { paths: [docs, clip, archive], reason: "Too big to keep" });
  expect(queued.isError, resultText(queued)).not.toBe(true);
  expect(resultText(queued)).toMatch(/^Added 3 items \(.+\) to DiskHound's review list to delete permanently\. Nothing has been deleted yet\./);
  for (const path of [docs, clip, archive]) expect(existsSync(path)).toBe(true);

  // The user skips one, sends one to the Trash instead, and deletes one.
  const sheet = await openReview(page);
  await expect(sheet.getByRole("button", { name: "Delete 3" })).toHaveClass(/\brv-danger\b/);
  await reviewRow(sheet, archive).locator(".rv-check").uncheck();
  await chooseAction(reviewRow(sheet, clip), "trash");
  await expect(reviewRow(sheet, clip).locator(".rv-meta")).toContainText(`You changed this to the ${BIN}.`);
  await expect(sheet.locator(".rv-sum")).toContainText("2 of 3 ticked");
  await sheet.getByRole("button", { name: `Move 1 to ${BIN} · Delete 1` }).click();
  await expect(sheet.locator(".rv-done")).toContainText("Removed 2 items for 1 agent.");
  await expect(sheet.locator(".rv-done")).toContainText("1 skipped.");
  await expect(reviewRow(sheet, docs).locator(".rv-result")).toHaveText("Deleted");
  await expect(reviewRow(sheet, clip).locator(".rv-result")).toHaveText(`Moved to the ${BIN}`);
  await expect(reviewRow(sheet, archive).locator(".rv-result")).toHaveText("Skipped");

  expect(existsSync(docs)).toBe(false);
  expect(existsSync(join(trashDir, "docs"))).toBe(false);
  expect(existsSync(clip)).toBe(false);
  expect(existsSync(join(trashDir, "clip.mov"))).toBe(true);
  expect(existsSync(archive)).toBe(true);
  expect(await trash.dialogs()).toEqual([]);

  // The agent hears each item's outcome.
  const status = await callTool(admin, "diskhound_status");
  expect(resultText(status)).toContain(`The user moved 1 item to the ${BIN} instead of deleting it`);
  expect(resultText(status)).toContain("Deleted 1 item permanently");
  expect(resultText(status)).toContain(`Skipped by the user: ${archive}.`);
  await admin.close();
});

/**
 * Mount a small volume at `mountPoint`, or say why this runner can't.
 * macOS attaches a disk image; Linux mounts a tmpfs with passwordless
 * sudo, which CI has.
 */
function mountVolume(mountPoint: string, image: string): { unmount: () => void } | string {
  mkdirSync(mountPoint, { recursive: true });
  const run = (command: string, args: string[]) => spawnSync(command, args, { encoding: "utf8", timeout: 60_000 });
  if (process.platform === "darwin") {
    const made = run("hdiutil", ["create", "-size", "4m", "-fs", "HFS+", "-volname", "E2EInner", "-ov", image]);
    if (made.status !== 0) return `hdiutil create failed: ${made.stderr}`;
    const attached = run("hdiutil", ["attach", "-nobrowse", "-mountpoint", mountPoint, image]);
    if (attached.status !== 0) return `hdiutil attach failed: ${attached.stderr}`;
    return { unmount: () => void run("hdiutil", ["detach", "-force", mountPoint]) };
  }
  if (process.platform === "linux") {
    const mounted = run("sudo", ["-n", "mount", "-t", "tmpfs", "-o", "size=4m,mode=0777", "e2e-inner", mountPoint]);
    if (mounted.status !== 0) return `sudo mount failed: ${mounted.stderr}`;
    return { unmount: () => void run("sudo", ["-n", "umount", "-l", mountPoint]) };
  }
  return "no unprivileged way to mount a volume inside a folder on this OS";
}

test("a folder with another volume inside isn't shown as moving to the Trash", async ({ launch, scanTree }, testInfo) => {
  test.skip(process.platform === "win32", "Windows mounts a volume on a folder as a link, which the Trash takes without what it points to");
  const media = join(scanTree.root, "media");
  const inner = join(media, "inner");
  mkdirSync(media, { recursive: true });
  writeFileSync(join(media, "cut.mov"), Buffer.alloc(64 * 1024, 1));
  const handle = await launch({ settings: { agents: { enabled: true } } });
  const { page } = handle;
  await scanFolderFromPicker(handle, scanTree.root);
  const mount = mountVolume(inner, testInfo.outputPath("inner.dmg"));
  test.skip(typeof mount === "string", typeof mount === "string" ? mount : "");
  const { unmount } = mount as { unmount: () => void };
  try {
    writeFileSync(join(inner, "on-the-other-volume.txt"), "keep me");
    const trashDir = testInfo.outputPath("trash");
    const trash = await stubTrash(handle, trashDir);
    const agent = await connectAgent(handle, await signIn(handle, { sessionName: "Media", roleId: "builtin.operator" }));

    // The mount point itself is refused: DiskHound never removes a volume.
    const volume = await callTool(agent, "diskhound_move_to_trash", { paths: [inner] });
    expect(volume.isError).toBe(true);
    expect(resultText(volume)).toContain("is mounted here, and DiskHound never removes a volume");

    // The folder holding it is listed as only partly movable.
    const queued = await callTool(agent, "diskhound_move_to_trash", { paths: [media], reason: "Old footage" });
    expect(queued.isError, resultText(queued)).not.toBe(true);
    expect(queued.structuredContent).toMatchObject({ items: [{ path: media, trash: "partly", otherVolumesInside: [{ path: inner }] }] });
    expect(resultText(queued)).toContain("inside it is another volume, which DiskHound leaves alone");

    // On the sheet it starts unticked, with nothing shown as moving to the Trash.
    const sheet = await openReview(page);
    const row = reviewRow(sheet, media);
    await expect(row.locator(".rv-check")).not.toBeChecked();
    await expect(row).toHaveClass(/\boff\b/);
    await expect(row.locator(".rv-meta")).toContainText("inner/ is the volume");
    await expect(row.locator(".rv-meta")).toContainText("DiskHound leaves it alone and removes the rest if you tick this.");
    await expect(sheet.locator(".rv-sum")).toContainText("0 of 1 ticked");
    await expect(sheet.locator(".scan-btn-primary")).toBeDisabled();
    await expect(sheet.locator(".scan-btn-primary")).toHaveText("Remove");

    // Ticking it moves the rest and leaves the volume where it is.
    await row.locator(".rv-check").check();
    await sheet.getByRole("button", { name: `Move 1 to ${BIN}` }).click();
    await expect(row.locator(".rv-result")).toHaveText("Moved, except inner/");
    expect(existsSync(join(trashDir, "cut.mov"))).toBe(true);
    expect(existsSync(join(media, "cut.mov"))).toBe(false);
    expect(readFileSync(join(inner, "on-the-other-volume.txt"), "utf8")).toBe("keep me");
    expect(existsSync(join(trashDir, "media"))).toBe(false);
    expect(await trash.dialogs()).toEqual([]);

    const status = await callTool(agent, "diskhound_status");
    expect(resultText(status)).toContain("Partly removed:");
    await agent.close();
  } finally {
    unmount();
  }
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
  const agent = await connectAgent(handle, await signIn(handle, { roleId: "builtin.operator" }));
  try {
    for (const path of [protectedPath, join(scanTree.root, "docs"), scanTree.root]) {
      const result = await callTool(agent, "diskhound_move_to_trash", { paths: [path] });
      expect(result.isError, resultText(result)).toBe(true);
      expect(resultText(result)).toContain("Protected folder");
    }
    // Refused before the review list: nothing waits there.
    await expect(handle.page.locator(".agent-pill.review")).toHaveCount(0);
    expect(await trash.dialogs()).toEqual([]);
    expect(existsSync(join(scanTree.root, "docs"))).toBe(true);
  } finally { await agent.close(); }
});
