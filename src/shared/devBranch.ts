import { execFile } from "node:child_process";

import type { DevBranch } from "./contracts";

/** Runs `git -C cwd ...args`; resolves trimmed stdout, or null on any failure. */
export type GitRunner = (cwd: string, args: string[]) => Promise<string | null>;

const runGit: GitRunner = (cwd, args) =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        const value = error ? "" : stdout.trim();
        resolve(value.length > 0 ? value : null);
      },
    );
  });

/**
 * The branch checked out at `cwd`, or the commit when HEAD is detached.
 * Null when `cwd` isn't a Git checkout or `git` isn't on PATH.
 *
 * `symbolic-ref` rather than `branch --show-current`: it predates Git
 * 2.22, and it also names an unborn branch in a repo with no commits.
 */
export async function readDevBranch(cwd: string, git: GitRunner = runGit): Promise<DevBranch | null> {
  const branch = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch !== null) return { name: branch, detached: false };
  const commit = await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return commit !== null ? { name: commit, detached: true } : null;
}
