import { execFileSync } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { removeGitWorktree, type GitCommand } from "../gitRepo";

describe("worktree removal when Git fails", () => {
  const wt = Path.resolve("/wt/feat");
  const admin = Path.resolve("/repo/.git/worktrees/feat");
  const readText = async (path: string) => ({
    [Path.join(wt, ".git")]: `gitdir: ${admin}\n`,
    [Path.join(admin, "HEAD")]: "ref: refs/heads/feat\n",
  })[path] ?? null;
  const clean: GitCommand = async (_cwd, args) => args.includes("rev-parse") ? "feat\n"
    : args.includes("rev-list") ? "0\n" : "";

  it("does not attempt removal when Git is unavailable or a check fails", async () => {
    const remove = vi.fn(async () => "");
    for (const failed of ["all", "status", "rev-list"]) {
      const git: GitCommand = async (cwd, args) => failed === "all" || args.includes(failed) ? null : clean(cwd, args);
      expect(await removeGitWorktree(wt, git, remove, readText)).toMatchObject({ ok: false });
    }
    expect(remove).not.toHaveBeenCalled();
  });

  it("reports a failed removal without forcing or deleting the folder itself", async () => {
    const remove = vi.fn(async () => null);
    expect(await removeGitWorktree(wt, clean, remove, readText)).toMatchObject({ ok: false });
    expect(remove).toHaveBeenCalledExactlyOnceWith(Path.resolve("/repo/.git"), [
      "--git-dir", Path.resolve("/repo/.git"), "--no-optional-locks", "-c", "core.fsmonitor=false",
      "worktree", "remove", "--", wt,
    ]);
  });
});

describe("worktree removal against real Git", () => {
  const dirs: string[] = [];
  const hasGit = (() => {
    try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; }
    catch { return false; }
  })();
  afterEach(() => {
    for (const dir of dirs.splice(0)) FS.rmSync(dir, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  function fixture(detached = false) {
    const root = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-remove-worktree-")));
    dirs.push(root);
    const repo = Path.join(root, "repo");
    const wt = Path.join(root, "worktree with spaces");
    FS.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    git(repo, "config", "commit.gpgsign", "false");
    FS.writeFileSync(Path.join(repo, "a.txt"), "one\n");
    FS.writeFileSync(Path.join(repo, ".gitignore"), "node_modules/\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "one");
    git(repo, "worktree", "add", "-q", ...(detached ? ["--detach"] : ["-b", "feat"]), wt);
    return { repo, wt };
  }

  it.skipIf(!hasGit)("removes a clean checkout, ignored build files, and its registration while retaining its branch", async () => {
    const { repo, wt } = fixture();
    FS.mkdirSync(Path.join(wt, "node_modules"));
    FS.writeFileSync(Path.join(wt, "node_modules", "build.bin"), Buffer.alloc(1024 * 1024));
    expect(await removeGitWorktree(wt)).toMatchObject({ ok: true });
    expect(FS.existsSync(wt)).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(wt);
    expect(git(repo, "branch", "--list", "feat")).toContain("feat");
    // Git's registration no longer prevents checking the same branch out again.
    git(repo, "worktree", "add", "-q", wt, "feat");
    expect(FS.existsSync(Path.join(wt, "a.txt"))).toBe(true);
  });

  it.skipIf(!hasGit)("keeps changed, untracked, and locked worktrees registered and on disk", async () => {
    const { repo, wt } = fixture();
    FS.writeFileSync(Path.join(wt, "a.txt"), "edited\n");
    expect(await removeGitWorktree(wt)).toMatchObject({ ok: false });
    git(wt, "restore", "a.txt");
    FS.writeFileSync(Path.join(wt, "notes.txt"), "keep me\n");
    expect(await removeGitWorktree(wt)).toMatchObject({ ok: false });
    FS.unlinkSync(Path.join(wt, "notes.txt"));
    git(repo, "worktree", "lock", wt);
    expect(await removeGitWorktree(wt)).toMatchObject({ ok: false });
    expect(FS.existsSync(wt)).toBe(true);
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(wt);
  });

  it.skipIf(!hasGit)("keeps a clean detached worktree whose commits exist only there until saved on a branch", async () => {
    const { repo, wt } = fixture(true);
    FS.writeFileSync(Path.join(wt, "a.txt"), "committed work\n");
    git(wt, "add", "a.txt");
    git(wt, "commit", "-q", "-m", "only here");
    expect(await removeGitWorktree(wt)).toMatchObject({ ok: false });
    expect(FS.existsSync(wt)).toBe(true);
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(wt);
    git(wt, "branch", "saved");
    expect(await removeGitWorktree(wt)).toMatchObject({ ok: true });
    expect(git(repo, "show", "saved:a.txt")).toBe("committed work\n");
  });
});
