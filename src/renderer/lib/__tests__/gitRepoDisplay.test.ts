import { describe, expect, it } from "vitest";

import type { DevArtifact, DevGitRepoCheck } from "../../../shared/contracts";
import {
  artifactsInsideCheckout,
  gitCheckLosesHistory,
  gitRemoteBadge,
  gitRemovalConfirm,
  gitRepoManagedBy,
  gitRepoRemovalBlock,
} from "../gitRepoDisplay";

function row(path: string, kind: DevArtifact["kind"] = "git-repo", size = 1): DevArtifact {
  return {
    path,
    kind,
    projectPath: null,
    projectName: "Unscoped",
    size,
    fileCount: 1,
    previousSize: null,
    deltaBytes: null,
  };
}

const CLEAN: DevGitRepoCheck = {
  gitAvailable: true,
  remotes: ["origin"],
  remoteUrl: "github.com/openclaw/openclaw",
  unpushedCommits: 0,
  changedFiles: 0,
  stashes: 0,
  linkedWorktrees: [],
};

describe("gitRepoRemovalBlock", () => {
  it("allows an ordinary checkout", () => {
    expect(gitRepoRemovalBlock(row("/Users/me/github/openclaw/.git"), "/")).toBeNull();
    expect(gitRepoRemovalBlock(row("C:\\src\\openclaw\\.git"), "C:\\")).toBeNull();
  });

  it("never offers a home folder, a drive root or the scan root", () => {
    expect(gitRepoRemovalBlock(row("/Users/me/.git"), "/")).toMatch(/whole folder/);
    expect(gitRepoRemovalBlock(row("/home/me/.git"), "/")).toMatch(/whole folder/);
    expect(gitRepoRemovalBlock(row("C:\\Users\\me\\.git"), "C:\\")).toMatch(/whole folder/);
    expect(gitRepoRemovalBlock(row("C:\\.git"), "C:\\")).toMatch(/whole folder/);
    expect(gitRepoRemovalBlock(row("/Users/me/github/app/.git"), "/Users/me/github/app")).toMatch(/scan started/);
  });

  it("leaves clones a tool keeps to that tool", () => {
    expect(gitRepoRemovalBlock(row("/opt/homebrew/.git"), "/")).toMatch(/Homebrew keeps/);
    expect(gitRepoRemovalBlock(row("/opt/homebrew/Library/Taps/homebrew/homebrew-core/.git"), "/")).toMatch(/Homebrew/);
    expect(gitRepoRemovalBlock(row("/Users/me/.nvm/.git"), "/")).toMatch(/\.nvm/);
    expect(gitRepoRemovalBlock(row("/Users/me/.cargo/git/checkouts/serde-1/abc/.git"), "/")).toMatch(/\.cargo/);
    expect(gitRepoRemovalBlock(row("C:\\Users\\me\\scoop\\buckets\\main\\.git"), "C:\\")).toMatch(/Scoop keeps/);
    expect(gitRepoRemovalBlock(row("C:\\Users\\me\\AppData\\Local\\nvim-data\\lazy\\x\\.git"), "C:\\")).toMatch(/AppData/);
  });
});

describe("gitRepoManagedBy", () => {
  it("does not flag ordinary folders", () => {
    expect(gitRepoManagedBy("/Users/me/github/openclaw")).toBeNull();
    expect(gitRepoManagedBy("/Users/me/Library-projects/app")).toBeNull();
    expect(gitRepoManagedBy("C:\\scoop-notes\\app")).toBeNull();
  });

  it("looks only below the scan root", () => {
    expect(gitRepoManagedBy("/Users/me/.codex/worktrees/a1/code/app", "/Users/me/.codex/worktrees/a1")).toBeNull();
    expect(gitRepoManagedBy("/Users/me/.codex/worktrees/a1/code/app", "/")).toBe(".codex");
    expect(gitRepoManagedBy("/Users/me/Library/Caches/x", "/Users/me")).toBe("Library");
  });
});

describe("artifactsInsideCheckout", () => {
  it("lists the trees that go with the checkout, not the repo itself or its neighbours", () => {
    const repo = row("/Users/me/app/.git");
    const inside = row("/Users/me/app/node_modules", "node-modules", 500);
    const nested = row("/Users/me/app/vendor/lib/.git");
    const neighbour = row("/Users/me/app-feat/node_modules", "node-modules");
    expect(artifactsInsideCheckout([repo, inside, nested, neighbour], repo)).toEqual([inside, nested]);
  });
});

describe("gitRemoteBadge", () => {
  it("warns when there is no remote or the config is unreadable", () => {
    expect(gitRemoteBadge({ remotes: [], remoteUrl: null, readable: true })).toMatchObject({ label: "No remote", warn: true });
    expect(gitRemoteBadge({ remotes: [], remoteUrl: null, readable: false })).toMatchObject({ label: "Remote unknown", warn: true });
  });

  it("names where the history also lives", () => {
    expect(gitRemoteBadge({ remotes: ["origin", "upstream"], remoteUrl: "github.com/me/app", readable: true }))
      .toMatchObject({ label: "github.com/me/app +1", warn: false });
    expect(gitRemoteBadge(undefined)).toBeNull();
  });
});

describe("gitRemovalConfirm", () => {
  const repo = row("/Users/me/github/openclaw/.git", "git-repo", 6 * 1024 ** 3);

  it("says a clean repo can be cloned again, and asks once", () => {
    const { first, second } = gitRemovalConfirm({ artifact: repo, check: CLEAN, inside: [], trash: "Trash" });
    expect(first).toContain("Move openclaw to the Trash?");
    expect(first).toContain("/Users/me/github/openclaw");
    expect(first).toContain(".git history 6.0 GB");
    expect(first).toContain("clone it again from github.com/openclaw/openclaw");
    expect(first).not.toContain("⚠");
    expect(second).toBeNull();
  });

  it("leads with every risk and asks twice when history exists only here", () => {
    const check: DevGitRepoCheck = {
      ...CLEAN,
      remotes: [],
      remoteUrl: null,
      unpushedCommits: 12,
      changedFiles: 1,
      stashes: 2,
      linkedWorktrees: ["/Users/me/github/openclaw-feat"],
    };
    const { first, second } = gitRemovalConfirm({
      artifact: repo,
      check,
      inside: [row("/Users/me/github/openclaw/node_modules", "node-modules", 1024 ** 3)],
      trash: "Recycle Bin",
    });
    expect(first).toContain("No remote is configured");
    expect(first).toContain("1 file with uncommitted changes");
    expect(first).toContain("2 stashes");
    expect(first).toContain("1 linked worktree uses this repo");
    expect(first).toContain("/Users/me/github/openclaw-feat");
    expect(first).toContain("1 other listed tree, 1.0 GB");
    expect(second).toContain("With no remote, nothing else holds this history");
    expect(second).toContain("Recycle Bin");
  });

  it("asks twice for unpushed commits, and when git could not check", () => {
    const unpushed = gitRemovalConfirm({ artifact: repo, check: { ...CLEAN, unpushedCommits: 1 }, inside: [], trash: "Trash" });
    expect(unpushed.first).toContain("1 commit on local branches is not on any remote");
    expect(unpushed.second).toContain("Unpushed commits exist only here");

    const noGit: DevGitRepoCheck = { ...CLEAN, gitAvailable: false, unpushedCommits: null, changedFiles: null, stashes: null };
    expect(gitCheckLosesHistory(noGit)).toBe(true);
    const unchecked = gitRemovalConfirm({ artifact: repo, check: noGit, inside: [], trash: "Trash" });
    expect(unchecked.first).toContain("git could not run here");
    expect(unchecked.second).toContain("Nothing was checked");
  });
});
