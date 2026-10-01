import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect, test } from "./fixtures/electron-app";
import { openTab, scanFolderFromPicker } from "./fixtures/steps";

// Whole multiples of 4 KiB, so the allocated size the scanner reports
// is at least the logical size.
const PACK_BYTES = 1024 * 1024;
const SMALL_PACK_BYTES = 256 * 1024;

// Keep the tree out of the uploaded CI artifacts.
test.afterEach(({}, testInfo) => {
  rmSync(testInfo.outputPath("dev"), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function write(root: string, parts: string[], content: string | Buffer): void {
  const target = join(root, ...parts);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** Enough of a `.git` folder for `git rev-parse` to call it a repo. */
function writeRepo(root: string, name: string, config: string, packBytes: number): void {
  write(root, [name, ".git", "HEAD"], "ref: refs/heads/main\n");
  write(root, [name, ".git", "config"], config);
  write(root, [name, ".git", "objects", "pack", "pack-1.pack"], randomBytes(packBytes));
  mkdirSync(join(root, name, ".git", "refs", "heads"), { recursive: true });
  write(root, [name, "README.md"], "hello\n");
}

function writeTree(root: string): void {
  writeRepo(
    root,
    "openclaw",
    "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://me:ghp_token@github.com/openclaw/openclaw.git\n",
    PACK_BYTES,
  );
  // Made with `git init`, never pushed anywhere.
  writeRepo(root, "scratch", "[core]\n\tbare = false\n", SMALL_PACK_BYTES);
  // A linked worktree: its .git is a file pointing into openclaw's.
  write(root, ["openclaw-feat", ".git"], "gitdir: ../openclaw/.git/worktrees/openclaw-feat\n");
  write(root, ["openclaw-feat", "README.md"], "hello\n");
}

test("lists Git repos with their remotes and moves one to the Trash only after two warnings", async ({ launch }, testInfo) => {
  const root = testInfo.outputPath("dev");
  writeTree(root);
  const handle = await launch();
  const { page } = handle;
  const snapshot = await scanFolderFromPicker(handle, root);
  if (snapshot.rootPath === null) throw new Error("scan has no root path");
  const rootPath = snapshot.rootPath;

  const report = await page.evaluate((r) => window.diskhound.getDevArtifacts(r, { sidecarOnly: true }), rootPath);
  const repos = report?.artifacts.filter((a) => a.kind === "git-repo") ?? [];
  expect(repos).toEqual([
    expect.objectContaining({
      path: join(rootPath, "openclaw", ".git"),
      projectPath: join(rootPath, "openclaw"),
      projectName: "openclaw",
      fileCount: 3,
      // The token in the URL never leaves main.
      git: { remotes: ["origin"], remoteUrl: "github.com/openclaw/openclaw", readable: true },
    }),
    expect.objectContaining({
      path: join(rootPath, "scratch", ".git"),
      projectName: "scratch",
      git: { remotes: [], remoteUrl: null, readable: true },
    }),
  ]);
  expect(repos[0]!.size).toBeGreaterThanOrEqual(PACK_BYTES);
  // The linked worktree is a row of its own, under the repo its .git file names.
  expect(report?.artifacts.filter((a) => a.kind === "worktree")).toEqual([
    expect.objectContaining({
      path: join(rootPath, "openclaw-feat"),
      projectPath: join(rootPath, "openclaw"),
      projectName: "openclaw",
      fileCount: 2,
      worktree: { project: join(rootPath, "openclaw") },
    }),
  ]);

  // Stand in for the OS Trash: record the path and leave the files.
  await handle.app.evaluate(({ ipcMain }) => {
    const state = globalThis as typeof globalThis & { trashed?: string[] };
    state.trashed = [];
    ipcMain.removeHandler("diskhound:trash-path");
    ipcMain.handle("diskhound:trash-path", async (_event, target: string) => {
      state.trashed!.push(target);
      return { ok: true, message: "Moved to trash" };
    });
  });

  await openTab(page, "Dev Artifacts");
  await expect(page.locator('.dev-kind-cell[title="Git repos (.git)"] .dev-kind-cell-label')).toHaveText("Git repos");
  const rows = page.locator(".dev-row");
  await expect(rows).toHaveCount(3);
  const repoRows = rows.filter({ has: page.locator(".dev-git-badge") });
  await expect(repoRows).toHaveCount(2);
  const openclaw = repoRows.filter({ has: page.locator(".dev-row-name", { hasText: /^openclaw$/ }) });
  const scratch = repoRows.filter({ has: page.locator(".dev-row-name", { hasText: /^scratch$/ }) });
  const worktree = rows.filter({ hasNot: page.locator(".dev-git-badge") });
  await expect(openclaw.locator(".dev-git-badge")).toHaveText("github.com/openclaw/openclaw");
  await expect(scratch.locator(".dev-git-badge.warn")).toHaveText("No remote");
  await expect(worktree.locator(".dev-row-tail")).toHaveText("openclaw-feat");
  // No checkbox: repos stay out of Delete selected and Delete all.
  await expect(repoRows.locator("input[type=checkbox]")).toHaveCount(0);

  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.accept();
  });
  await scratch.getByRole("button", { name: "Remove…" }).click();
  await expect(rows).toHaveCount(2);
  expect(dialogs).toHaveLength(2);
  expect(dialogs[0]).toContain("No remote is configured");
  expect(dialogs[0]).toContain(join(rootPath, "scratch"));
  expect(dialogs[1]).toContain("nothing else holds this history");
  // The whole checkout, not just its .git.
  expect(await handle.app.evaluate(() => (globalThis as typeof globalThis & { trashed?: string[] }).trashed))
    .toEqual([join(rootPath, "scratch")]);

  const after = await page.evaluate((r) => window.diskhound.getDevArtifacts(r, { sidecarOnly: true }), rootPath);
  expect(after?.artifacts.map((a) => a.kind)).toEqual(["git-repo", "worktree"]);

  // The worktree's repo has no worktrees/openclaw-feat folder, so git
  // cannot vouch for it: Delete moves it to the Trash after two warnings
  // instead of deleting it for good.
  dialogs.length = 0;
  await worktree.getByRole("button", { name: "Delete" }).click();
  await expect(rows).toHaveCount(1);
  expect(dialogs).toHaveLength(2);
  // "Recycle Bin" on Windows.
  expect(dialogs[0]).toMatch(/^Move the openclaw-feat worktree to the (Trash|Recycle Bin)\?/);
  expect(dialogs[0]).toContain("repository is gone");
  expect(dialogs[1]).toContain("cannot be recovered");
  expect(await handle.app.evaluate(() => (globalThis as typeof globalThis & { trashed?: string[] }).trashed))
    .toEqual([join(rootPath, "scratch"), join(rootPath, "openclaw-feat")]);
});
