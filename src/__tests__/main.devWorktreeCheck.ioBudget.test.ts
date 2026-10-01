import "node:fs";
import "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DevWorktreeCheck } from "../shared/contracts";
import { expectIoBudget, measureFsIo } from "../test/ioBudget";
import { bootMainProcess, type MainProcess } from "../test/mainProcessHarness";
import { seedProfile } from "../test/mainProfileFixture";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFsPromises(await importOriginal()));
vi.mock("node:child_process", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentChildProcess(await importOriginal()));
vi.mock("node:worker_threads", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentWorkerThreads(await importOriginal()));
vi.mock("electron", async () =>
  (await import("../test/mainProcessHarness")).fakeElectron());
vi.mock("../shared/crashLog", async (importOriginal) =>
  (await import("../test/mainProcessHarness")).settledCrashLog(await importOriginal()));

/** A bulk delete of 12 agent worktrees; the last 3 hold uncommitted work. */
const WORKTREES = 12;
const DIRTY = 3;

let main: MainProcess;
let root: string;
let worktrees: string[];
const hasGit = await (async () => {
  const { execFileSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

beforeAll(async () => {
  // Real repo and worktrees, made with the host fs and git before the
  // measured ones are in play for main.
  const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const { execFileSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  root = realFs.realpathSync(realFs.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-wt-budget-")));
  worktrees = [];
  if (!hasGit) return;
  const repo = Path.join(root, "github", "app");
  realFs.mkdirSync(repo, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  realFs.writeFileSync(Path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "one");
  for (let i = 0; i < WORKTREES; i++) {
    const wt = Path.join(root, "claude-worktrees", "app", `wt-${i}`);
    git(repo, "worktree", "add", "-q", "-b", `wt-${i}`, wt);
    if (i >= WORKTREES - DIRTY) realFs.writeFileSync(Path.join(wt, "a.txt"), "edited\n");
    worktrees.push(wt);
  }
  main = await bootMainProcess({
    seed: (userData) => seedProfile(userData, { roots: [{ rootPath: root, scans: 1 }] }).then(() => undefined),
  });
}, 60_000);

afterAll(async () => {
  const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  realFs.rmSync(root, { recursive: true, force: true });
});

describe("Dev Artifacts worktree check before a delete", () => {
  it.skipIf(!hasGit)("reads 3 small files and runs 3 git commands per worktree, and logs the ones held back", async () => {
    const measured = await measureFsIo(
      () => Promise.all(worktrees.map((wt) => main.invoke<DevWorktreeCheck>("diskhound:check-git-worktree", wt))),
      { countProcesses: true },
    );
    const checks = measured.result;
    expect(checks.filter((c) => c.checked && c.changedFiles === 0 && c.commitsOnlyHere === 0)).toHaveLength(WORKTREES - DIRTY);
    expect(checks.slice(-DIRTY).every((c) => c.changedFiles === 1)).toBe(true);
    expectIoBudget({
      scenario: "main-dev-worktree-check",
      note: `one bulk delete that includes ${WORKTREES} worktrees: per worktree, its .git file, its admin HEAD and a `
        + `locked probe, plus git rev-parse, status and rev-list; one crash.log append for the ${DIRTY} held back. `
        + `Runs only on a delete click, never on a timer: 0 writes/day at any setting. A 500-worktree delete runs `
        + `1,500 git processes, 6 worktrees at a time.`,
      io: measured.io,
    });
  });
});
