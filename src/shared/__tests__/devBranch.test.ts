import { execFileSync } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readDevBranch, type GitRunner } from "../devBranch";

/** Answers from a table keyed by the git subcommand. */
function fakeGit(answers: Record<string, string | null>): GitRunner {
  return async (_cwd, args) => answers[args[0]] ?? null;
}

describe("readDevBranch", () => {
  it("names the checked-out branch", async () => {
    const git = fakeGit({ "symbolic-ref": "feat/dev-branch-chip", "rev-parse": "0123456789abcdef" });
    expect(await readDevBranch("/repo", git)).toEqual({ name: "feat/dev-branch-chip", detached: false });
  });

  it("falls back to the commit on a detached HEAD", async () => {
    const git = fakeGit({ "symbolic-ref": null, "rev-parse": "0123456789abcdef" });
    expect(await readDevBranch("/repo", git)).toEqual({ name: "0123456789abcdef", detached: true });
  });

  it("is null outside a checkout or without git", async () => {
    expect(await readDevBranch("/repo", fakeGit({}))).toBeNull();
  });

  it("runs git in the directory it was given", async () => {
    const seen: string[] = [];
    await readDevBranch("/some/checkout", async (cwd) => {
      seen.push(cwd);
      return null;
    });
    expect(seen).toEqual(["/some/checkout", "/some/checkout"]);
  });
});

describe("readDevBranch against real git", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) FS.rmSync(dir, { recursive: true, force: true });
  });

  function tempRepo(branch: string): string {
    const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-dev-branch-"));
    dirs.push(dir);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    git("init", "--quiet", "--initial-branch", branch);
    git("-c", "user.name=DiskHound", "-c", "user.email=test@diskhound.invalid",
      "commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", "init");
    return dir;
  }

  it("reads the branch, then the commit once HEAD is detached", async () => {
    const dir = tempRepo("codex/long-branch-name-214447");
    expect(await readDevBranch(dir)).toEqual({ name: "codex/long-branch-name-214447", detached: false });

    execFileSync("git", ["-C", dir, "checkout", "--quiet", "--detach"]);
    const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(await readDevBranch(dir)).toEqual({ name: sha, detached: true });
  });
});
