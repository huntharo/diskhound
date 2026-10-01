import type { DevWorktreeCheck } from "../../shared/contracts";

/** git processes per worktree check: 3. Six at a time keeps a bulk delete of
 *  hundreds of worktrees to about 18 git processes. */
export const WORKTREE_CHECK_CONCURRENCY = 6;

/**
 * Check each worktree with git, `concurrency` at a time, in the order
 * given. A check that throws counts as not checked, so that worktree is
 * held back rather than the whole delete stopping.
 */
export async function checkWorktreesWithGit(
  paths: readonly string[],
  check: (path: string) => Promise<DevWorktreeCheck>,
  options: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<Map<string, DevWorktreeCheck>> {
  const checks = new Map<string, DevWorktreeCheck>();
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const path = paths[next++]!;
      try {
        checks.set(path, await check(path));
      } catch (err) {
        checks.set(path, {
          checked: false,
          problem: `The check failed: ${err instanceof Error ? err.message : String(err)}`,
          branch: null,
          changedFiles: null,
          commitsOnlyHere: null,
          lockReason: null,
        });
      }
      options.onProgress?.(checks.size, paths.length);
    }
  };
  const workers = Math.max(1, Math.min(options.concurrency ?? WORKTREE_CHECK_CONCURRENCY, paths.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return checks;
}
