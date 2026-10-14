import type { DevWorktreeCheck } from "./contracts";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${new Intl.NumberFormat().format(n)} ${n === 1 ? one : many}`;
}

/**
 * What git found in a worktree that exists nowhere else, one line each.
 * Empty when git checked it and found nothing: only then may it be
 * removed. An unknown count is a risk, not a pass. The Dev tab's confirm,
 * main's recheck before `git worktree remove`, and its log all use this,
 * so they cannot disagree about which worktrees are held back.
 */
export function worktreeRisks(check: DevWorktreeCheck): string[] {
  const risks: string[] = [];
  if (!check.checked) risks.push(check.problem ?? "git could not check it.");
  if (check.lockReason !== null) {
    risks.push(`Locked with git worktree lock${check.lockReason ? `: ${check.lockReason}` : ""}.`);
  }
  if (!check.checked) return risks;
  if (check.changedFiles === null) risks.push("Could not check for uncommitted changes.");
  else if (check.changedFiles > 0) risks.push(`${plural(check.changedFiles, "file")} with uncommitted changes.`);
  if (check.commitsOnlyHere === null) risks.push("Could not check for commits outside a branch.");
  else if (check.commitsOnlyHere > 0) {
    risks.push(`${plural(check.commitsOnlyHere, "commit")} on its detached HEAD ${check.commitsOnlyHere === 1 ? "is" : "are"} on no branch.`);
  }
  return risks;
}
