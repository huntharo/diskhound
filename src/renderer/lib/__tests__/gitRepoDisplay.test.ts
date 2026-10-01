import { describe, expect, it } from "vitest";

import type { DevArtifact, DevGitRepoCheck, DevWorktreeCheck } from "../../../shared/contracts";
import {
  artifactsInsideCheckout,
  gitCheckLosesHistory,
  gitRemoteBadge,
  gitRemovalConfirm,
  gitRepoManagedBy,
  gitRepoRemovalBlock,
  worktreeBulkNote,
  worktreeRisks,
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

describe("worktree checks", () => {
  const CLEAR: DevWorktreeCheck = {
    checked: true,
    problem: null,
    branch: "feat",
    changedFiles: 0,
    commitsOnlyHere: 0,
    lockReason: null,
  };

  it("clear only a worktree git checked and found nothing in", () => {
    expect(worktreeRisks(CLEAR)).toEqual([]);
    expect(worktreeRisks({ ...CLEAR, changedFiles: 3 })).toEqual(["3 files with uncommitted changes."]);
    expect(worktreeRisks({ ...CLEAR, branch: null, commitsOnlyHere: 1 }))
      .toEqual(["1 commit on its detached HEAD is on no branch."]);
    expect(worktreeRisks({ ...CLEAR, lockReason: "" })).toEqual(["Locked with git worktree lock."]);
    // Unknown is a risk, not a pass.
    expect(worktreeRisks({ ...CLEAR, changedFiles: null })).toEqual(["Could not check for uncommitted changes."]);
    expect(worktreeRisks({ ...CLEAR, checked: false, problem: "git could not run here.", changedFiles: null, commitsOnlyHere: null }))
      .toEqual(["git could not run here."]);
  });

  it("say in the bulk confirm which worktrees stay and why", () => {
    const kept = Array.from({ length: 7 }, (_, i) => ({
      artifact: { path: `/Users/me/.codex/worktrees/a${i}/app` },
      check: { ...CLEAR, changedFiles: i + 1 },
    }));
    const note = worktreeBulkNote(40, kept);
    expect(note).toContain("Git checked 40 worktrees: no uncommitted changes, no commits outside a branch.");
    expect(note).toContain("Not deleted: 7 worktrees that Git could not clear for removal:");
    expect(note).toContain("    app — 1 file with uncommitted changes.");
    expect(note).toContain("…and 2 more");
    expect(worktreeBulkNote(3, [])).toContain("Git will permanently remove these worktrees and their registrations.");
  });

  it("explains a failed Git check without claiming the worktree has unique work", () => {
    const note = worktreeBulkNote(0, [{
      artifact: { path: "/Users/me/worktrees/feat" },
      check: { ...CLEAR, checked: false, problem: "git could not run here." },
    }]);
    expect(note).toContain("git could not run here.");
    expect(note).toContain("Save their work or resolve the Git checks before trying again.");
    expect(note).not.toContain("work that exists only there");
  });
});
