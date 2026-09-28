import { execFileSync } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DevArtifact, DevArtifactReport, DevGitRepoInfo } from "../contracts";
import {
  annotateGitRepos,
  checkGitRepo,
  displayRemoteUrl,
  gitRepoInfoFromConfig,
  parseGitRemotes,
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
