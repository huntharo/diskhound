import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

test("permanently removes clean worktrees with Git and preserves ones with new work", async ({ launch }, testInfo) => {
  const root = testInfo.outputPath("dev");
  const repo = join(root, "repo");
  const clean = join(root, "clean-worktree");
  const dirty = join(root, "dirty-worktree");
  const changedAfterCheck = join(root, "changed-after-check");
  mkdirSync(repo, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  // Git prints `D:/a/...` on Windows, so compare resolved paths, not text.
  const registered = (wt: string) => git(repo, "worktree", "list", "--porcelain")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .some((line) => resolve(line.slice("worktree ".length)).toLowerCase() === resolve(wt).toLowerCase());
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  write(root, ["repo", "README.md"], "one\n");
  write(root, ["repo", ".gitignore"], "node_modules/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "one");
  git(repo, "worktree", "add", "-q", "-b", "clean", clean);
  git(repo, "worktree", "add", "-q", "-b", "dirty", dirty);
  git(repo, "worktree", "add", "-q", "-b", "race", changedAfterCheck);
  write(root, ["clean-worktree", "node_modules", "build.bin"], randomBytes(PACK_BYTES));
  write(root, ["dirty-worktree", "notes.txt"], "uncommitted work\n");

  const handle = await launch();
  const { page } = handle;
  await scanFolderFromPicker(handle, root);
  await openTab(page, "Dev Artifacts");
  const rows = page.locator(".dev-row");
  await expect(rows).toHaveCount(4);
  const row = (name: string) => rows.filter({ has: page.locator(".dev-row-tail", { hasText: new RegExp(`^${name}$`) }) });
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    const message = dialog.message();
    dialogs.push(message);
    // Introduce an untracked file after the renderer's screening, before
    // the main process rechecks immediately before removal.
    if (message.includes("Git will permanently remove") && existsSync(clean) === false) {
      write(root, ["changed-after-check", "new-work.txt"], "keep this work\n");
    }
    await dialog.accept();
  });

  await row("clean-worktree").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(row("clean-worktree")).toHaveCount(0);
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toContain("Git will permanently remove these worktrees and their registrations.");
  expect(existsSync(clean)).toBe(false);
  expect(registered(clean)).toBe(false);
  expect(git(repo, "branch", "--list", "clean")).toContain("clean");

  await row("dirty-worktree").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Nothing deleted", { exact: true })).toBeVisible();
  expect(dialogs).toHaveLength(1);
  expect(existsSync(join(dirty, "notes.txt"))).toBe(true);
  expect(registered(dirty)).toBe(true);

  await row("changed-after-check").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Could not delete", { exact: true })).toBeVisible();
  await expect(row("changed-after-check")).toHaveCount(1);
  expect(dialogs).toHaveLength(2);
  expect(existsSync(join(changedAfterCheck, "new-work.txt"))).toBe(true);
  expect(registered(changedAfterCheck)).toBe(true);
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
  // cannot vouch for it: Delete leaves it in place and explains why.
  dialogs.length = 0;
  await worktree.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Nothing deleted", { exact: true })).toBeVisible();
  await expect(page.getByText(/Its repository is gone/)).toBeVisible();
  await expect(rows).toHaveCount(2);
  expect(dialogs).toHaveLength(0);
  expect(await handle.app.evaluate(() => (globalThis as typeof globalThis & { trashed?: string[] }).trashed))
    .toEqual([join(rootPath, "scratch")]);
});
import { execFileSync } from "node:child_process";
