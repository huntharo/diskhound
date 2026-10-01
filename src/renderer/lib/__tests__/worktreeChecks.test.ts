import { describe, expect, it } from "vitest";

import type { DevWorktreeCheck } from "../../../shared/contracts";
import { expectNearLinear, measureOps } from "../../../testing/opCounter";
import { checkWorktreesWithGit } from "../worktreeChecks";

const CLEAR: DevWorktreeCheck = {
  checked: true,
  problem: null,
  branch: "feat",
  changedFiles: 0,
  commitsOnlyHere: 0,
  lockReason: null,
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("checkWorktreesWithGit", () => {
  it("runs at most `concurrency` checks at once and reports progress", async () => {
    let running = 0;
    let peak = 0;
    const progress: number[] = [];
    const paths = Array.from({ length: 20 }, (_, i) => `/wt/${i}`);
    const checks = await checkWorktreesWithGit(paths, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await tick();
      running -= 1;
      return CLEAR;
    }, { concurrency: 6, onProgress: (done) => progress.push(done) });
    expect(peak).toBe(6);
    expect(checks.size).toBe(20);
    expect(progress).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("holds back a worktree whose check throws instead of stopping", async () => {
    const checks = await checkWorktreesWithGit(["/wt/a", "/wt/b"], async (path) => {
      if (path === "/wt/a") throw new Error("boom");
      return CLEAR;
    });
    expect(checks.get("/wt/a")).toMatchObject({ checked: false, problem: "The check failed: boom" });
    expect(checks.get("/wt/b")).toEqual(CLEAR);
  });

  it("does work linear in worktrees", async () => {
    const run = async (n: number) => {
      const paths = Array.from({ length: n }, (_, i) => `/wt/${i}`);
      return (await measureOps(() => checkWorktreesWithGit(paths, async () => CLEAR))).ops;
    };
    expectNearLinear("checkWorktreesWithGit", await run(100), await run(800), { maxTotal: 800 * 20 });
  });
});
