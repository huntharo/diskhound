import { execFileSync } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DevArtifact, DevArtifactReport, DevGitRepoInfo } from "../contracts";
import {
  annotateGitRepos,
  checkGitRepo,
  checkGitWorktree,
  displayRemoteUrl,
  gitRepoInfoFromConfig,
  parseGitRemotes,
  worktreeAdminDir,
  type GitCommand,
} from "../gitRepo";

const CONFIG = `[core]
\trepositoryformatversion = 0
\tbare = false
[remote "upstream"]
\turl = https://github.com/openclaw/openclaw.git
\tfetch = +refs/heads/*:refs/remotes/upstream/*
[remote "origin"]
\turl = git@github.com:me/openclaw.git ; my fork
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
\turl = not-a-remote
`;

describe("parseGitRemotes", () => {
  it("reads every [remote] section's name and url in order", () => {
    expect(parseGitRemotes(CONFIG)).toEqual([
      { name: "upstream", url: "https://github.com/openclaw/openclaw.git" },
      { name: "origin", url: "git@github.com:me/openclaw.git" },
    ]);
  });

  it("finds no remote in a repo made with git init", () => {
    expect(parseGitRemotes("[core]\n\tbare = false\n")).toEqual([]);
  });

  it("keeps a remote that has no url yet", () => {
    expect(parseGitRemotes('[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'))
      .toEqual([{ name: "origin", url: null }]);
  });
});

describe("displayRemoteUrl", () => {
  it("drops users, passwords and tokens", () => {
    expect(displayRemoteUrl("https://me:ghp_secret123@github.com/me/app.git")).toBe("github.com/me/app");
    expect(displayRemoteUrl("https://oauth2:glpat-xyz@gitlab.example.com:8443/group/app")).toBe("gitlab.example.com/group/app");
    expect(displayRemoteUrl("ssh://git@github.com:22/me/app.git")).toBe("github.com/me/app");
  });

  it("turns scp-style URLs into host/path", () => {
    expect(displayRemoteUrl("git@github.com:me/app.git")).toBe("github.com/me/app");
    expect(displayRemoteUrl("github.com:me/app")).toBe("github.com/me/app");
  });

  it("keeps local paths, which name another folder", () => {
    expect(displayRemoteUrl("/Users/me/backups/app.git")).toBe("/Users/me/backups/app.git");
    expect(displayRemoteUrl("C:\\repos\\app")).toBe("C:\\repos\\app");
    expect(displayRemoteUrl("file:///srv/git/app.git/")).toBe("file:///srv/git/app.git");
  });
});

describe("gitRepoInfoFromConfig", () => {
  it("shows origin's URL, else the first remote's", () => {
    expect(gitRepoInfoFromConfig(CONFIG)).toEqual({
      remotes: ["upstream", "origin"],
      remoteUrl: "github.com/me/openclaw",
      readable: true,
    });
    expect(gitRepoInfoFromConfig('[remote "backup"]\n\turl = /mnt/backup/app\n').remoteUrl).toBe("/mnt/backup/app");
  });
});

function repoRow(path: string): DevArtifact {
  return {
    path,
    kind: "git-repo",
    projectPath: Path.dirname(path),
    projectName: Path.basename(Path.dirname(path)),
    size: 1,
    fileCount: 1,
    previousSize: null,
    deltaBytes: null,
  };
}

function reportOf(artifacts: DevArtifact[]): DevArtifactReport {
  return {
    artifacts,
    totalBytes: 0,
    totalFiles: 0,
    projectCount: 0,
    kindTotals: [],
    generatedAt: 0,
    rootPath: "/",
  };
}

describe("annotateGitRepos", () => {
  const info: DevGitRepoInfo = { remotes: ["origin"], remoteUrl: "github.com/me/app", readable: true };

  it("returns a report with no repos untouched, reading nothing", async () => {
    const report = reportOf([{ ...repoRow("/a/node_modules"), kind: "node-modules" }]);
    let reads = 0;
    const out = await annotateGitRepos(report, new Map(), async () => { reads += 1; return info; });
    expect(out).toBe(report);
    expect(reads).toBe(0);
  });

  it("reads each repo once, and a rebuilt report from the cache", async () => {
    const cache = new Map<string, DevGitRepoInfo>();
    const read: string[] = [];
    const reader = async (gitDir: string) => { read.push(gitDir); return info; };
    const report = reportOf([repoRow("/a/.git"), repoRow("/b/.git")]);
    const out = await annotateGitRepos(report, cache, reader);
    expect(out.artifacts.map((a) => a.git)).toEqual([info, info]);
    expect(read.sort()).toEqual(["/a/.git", "/b/.git"]);

    await annotateGitRepos(reportOf([repoRow("/b/.git"), repoRow("/c/.git")]), cache, reader);
    expect(read.sort()).toEqual(["/a/.git", "/b/.git", "/c/.git"]);
  });
});

describe("checkGitRepo", () => {
  const readInfo = async (): Promise<DevGitRepoInfo> => ({ remotes: ["origin"], remoteUrl: "github.com/me/app", readable: true });

  /** Answers keyed by the git subcommand after the global options. */
  function fakeGit(answers: Record<string, string | null>): { git: GitCommand; calls: string[][] } {
    const calls: string[][] = [];
    const git: GitCommand = async (_cwd, args) => {
      calls.push(args);
      const sub = args.find((arg, i) => i >= 3 && !arg.startsWith("-"))!;
      return sub in answers ? answers[sub]! : null;
    };
    return { git, calls };
  }

  it("counts what would be lost", async () => {
    const { git, calls } = fakeGit({
      "rev-parse": ".git\n",
      "rev-list": "3\n",
      status: " M src/a.ts\n?? notes.txt\n",
      stash: "stash@{0}: WIP on main: abc wip\n",
      worktree: "worktree /Users/me/app\nHEAD abc\nbranch refs/heads/main\n\nworktree /Users/me/app-feat\nHEAD def\nbranch refs/heads/feat\n\n",
    });
    expect(await checkGitRepo("/Users/me/app", git, readInfo)).toEqual({
      gitAvailable: true,
      remotes: ["origin"],
      remoteUrl: "github.com/me/app",
      unpushedCommits: 3,
      changedFiles: 2,
      stashes: 1,
      linkedWorktrees: ["/Users/me/app-feat"],
    });
    // Read-only: no optional index write, no fsmonitor hook.
    for (const args of calls) expect(args.slice(0, 3)).toEqual(["--no-optional-locks", "-c", "core.fsmonitor=false"]);
  });

  it("tells a clean repo from a failed command", async () => {
    const { git } = fakeGit({ "rev-parse": ".git", "rev-list": "0", status: "", stash: "", worktree: null });
    expect(await checkGitRepo("/r", git, readInfo)).toMatchObject({
      unpushedCommits: 0,
      changedFiles: 0,
      stashes: 0,
      linkedWorktrees: [],
    });
    const failing = fakeGit({ "rev-parse": ".git", "rev-list": null, status: null, stash: null, worktree: null });
    expect(await checkGitRepo("/r", failing.git, readInfo)).toMatchObject({
      gitAvailable: true,
      unpushedCommits: null,
      changedFiles: null,
      stashes: null,
    });
  });

  it("reports git as unavailable when it cannot run in the checkout", async () => {
    const { git, calls } = fakeGit({});
    expect(await checkGitRepo("/r", git, readInfo)).toMatchObject({ gitAvailable: false, remotes: ["origin"] });
    expect(calls).toHaveLength(1);
  });
});

describe("checkGitRepo against real git", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) FS.rmSync(dir, { recursive: true, force: true });
  });

  const hasGit = (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasGit)("finds local-only commits, changes, stashes and worktrees", async () => {
    const base = FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-git-check-"));
    dirs.push(base);
    const repo = Path.join(base, "app");
    FS.mkdirSync(repo);
    const run = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    run("init", "-q", "-b", "main");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "t");
    run("config", "commit.gpgsign", "false");
    FS.writeFileSync(Path.join(repo, "a.txt"), "one\n");
    run("add", "a.txt");
    run("commit", "-q", "-m", "one");
    FS.writeFileSync(Path.join(repo, "a.txt"), "two\n");
    run("stash", "-q");
    FS.writeFileSync(Path.join(repo, "new.txt"), "untracked\n");
    run("worktree", "add", "-q", Path.join(base, "app-feat"));

    const indexBefore = FS.statSync(Path.join(repo, ".git", "index")).mtimeMs;
    const check = await checkGitRepo(repo);
    expect(check).toMatchObject({
      gitAvailable: true,
      remotes: [],
      remoteUrl: null,
      unpushedCommits: 1,
      changedFiles: 1,
      stashes: 1,
    });
    expect(check.linkedWorktrees.map((p) => Path.basename(p))).toEqual(["app-feat"]);
    expect(FS.statSync(Path.join(repo, ".git", "index")).mtimeMs).toBe(indexBefore);
  });
});

describe("worktreeAdminDir", () => {
  it("resolves a worktree's gitdir and rejects a submodule's", () => {
    const wt = Path.resolve("/wt/app/feat");
    expect(worktreeAdminDir(wt, `gitdir: ${Path.resolve("/src/app/.git/worktrees/feat")}\n`))
      .toBe(Path.resolve("/src/app/.git/worktrees/feat"));
    expect(worktreeAdminDir(wt, "gitdir: ../../../src/app/.git/worktrees/feat"))
      .toBe(Path.resolve("/src/app/.git/worktrees/feat"));
    expect(worktreeAdminDir(wt, "gitdir: ../.git/modules/lib")).toBeNull();
    expect(worktreeAdminDir(wt, "ref: refs/heads/main")).toBeNull();
    expect(worktreeAdminDir(wt, "gitdir:")).toBeNull();
  });
});

describe("checkGitWorktree", () => {
  const wt = Path.resolve("/wt/app/feat");
  const admin = Path.resolve("/src/app/.git/worktrees/feat");
  /** Files keyed by path; a missing key reads as absent. */
  const files = (extra: Record<string, string> = {}) => async (filePath: string) => ({
    [Path.join(wt, ".git")]: `gitdir: ${admin}\n`,
    [Path.join(admin, "HEAD")]: "ref: refs/heads/feat\n",
    ...extra,
  })[filePath] ?? null;
  function fakeGit(answers: Record<string, string | null>): { git: GitCommand; calls: string[][] } {
    const calls: string[][] = [];
    const git: GitCommand = async (_cwd, args) => {
      calls.push(args);
      const sub = args.find((arg, i) => i >= 3 && !arg.startsWith("-"))!;
      return sub in answers ? answers[sub]! : null;
    };
    return { git, calls };
  }

  it("clears a clean worktree on a branch", async () => {
    const { git, calls } = fakeGit({ "rev-parse": "feat\n", status: "", "rev-list": "0\n" });
    expect(await checkGitWorktree(wt, git, files())).toEqual({
      checked: true,
      problem: null,
      branch: "feat",
      changedFiles: 0,
      commitsOnlyHere: 0,
      lockReason: null,
    });
    // Read-only: no optional index write, no fsmonitor hook.
    expect(calls).toHaveLength(3);
    for (const args of calls) expect(args.slice(0, 3)).toEqual(["--no-optional-locks", "-c", "core.fsmonitor=false"]);
  });

  it("counts uncommitted files and a detached HEAD's own commits, and reads a lock", async () => {
    const { git } = fakeGit({ "rev-parse": "HEAD\n", status: " M a.ts\n?? b.ts\n", "rev-list": "2\n" });
    expect(await checkGitWorktree(wt, git, files({ [Path.join(admin, "locked")]: "on a USB disk\n" }))).toEqual({
      checked: true,
      problem: null,
      branch: null,
      changedFiles: 2,
      commitsOnlyHere: 2,
      lockReason: "on a USB disk",
    });
  });

  it("does not run git without a worktree .git file or when the repo is gone", async () => {
    const { git, calls } = fakeGit({});
    const noPointer = await checkGitWorktree(wt, git, async () => null);
    expect(noPointer).toMatchObject({ checked: false, changedFiles: null });
    expect(noPointer.problem).toMatch(/no \.git file/);
    const gone = await checkGitWorktree(wt, git, async (p) => (p === Path.join(wt, ".git") ? `gitdir: ${admin}` : null));
    expect(gone.problem).toContain("repository is gone");
    expect(calls).toHaveLength(0);
  });

  it("reports a git that cannot run as not checked", async () => {
    const { git } = fakeGit({});
    expect(await checkGitWorktree(wt, git, files())).toMatchObject({ checked: false, problem: "git could not run here." });
  });
});

describe("checkGitWorktree against real git", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) FS.rmSync(dir, { recursive: true, force: true });
  });
  const hasGit = (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasGit)("tells a clean branch worktree from a detached one with its own work", async () => {
    const base = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-wt-check-")));
    dirs.push(base);
    const repo = Path.join(base, "app");
    FS.mkdirSync(repo);
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    git(repo, "config", "commit.gpgsign", "false");
    FS.writeFileSync(Path.join(repo, "a.txt"), "one\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "one");
    const clean = Path.join(base, "wt", "clean");
    const detached = Path.join(base, "wt", "detached");
    git(repo, "worktree", "add", "-q", "-b", "feat", clean);
    git(repo, "worktree", "add", "-q", "--detach", detached);
    FS.writeFileSync(Path.join(detached, "a.txt"), "two\n");
    git(detached, "commit", "-q", "-am", "two");
    FS.writeFileSync(Path.join(detached, "scratch.txt"), "untracked\n");

    expect(await checkGitWorktree(clean)).toEqual({
      checked: true,
      problem: null,
      branch: "feat",
      changedFiles: 0,
      commitsOnlyHere: 0,
      lockReason: null,
    });
    const indexBefore = FS.statSync(Path.join(repo, ".git", "worktrees", "detached", "index")).mtimeMs;
    expect(await checkGitWorktree(detached)).toMatchObject({
      checked: true,
      branch: null,
      changedFiles: 1,
      commitsOnlyHere: 1,
      lockReason: null,
    });
    expect(FS.statSync(Path.join(repo, ".git", "worktrees", "detached", "index")).mtimeMs).toBe(indexBefore);

    git(repo, "worktree", "lock", "--reason", "keep", clean);
    expect((await checkGitWorktree(clean)).lockReason).toBe("keep");
  });
});
