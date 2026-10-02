import type { DevArtifact, DevGitRepoCheck, DevGitRepoInfo, DevWorktreeCheck } from "../../shared/contracts";
import { basenameOf, dirnameOf } from "../../shared/pathUtils";
import { isUninformativeParent } from "./devArtifactDisplay";
import { formatBytes, formatCount } from "./format";

/** The working folder a `.git` row belongs to. Removing the repo removes this. */
export function gitCheckoutPath(artifact: Pick<DevArtifact, "path">): string {
  return dirnameOf(artifact.path);
}

function pathKey(path: string): string {
  return path.replace(/[\\/]+$/, "").toLowerCase();
}

function isUnder(parent: string, child: string): boolean {
  const p = pathKey(parent);
  const c = pathKey(child);
  return c.length > p.length && (c.startsWith(`${p}/`) || c.startsWith(`${p}\\`));
}

/** The other listed trees inside a repo's checkout. They go with it. */
export function artifactsInsideCheckout(artifacts: readonly DevArtifact[], repo: Pick<DevArtifact, "path">): DevArtifact[] {
  const checkout = gitCheckoutPath(repo);
  const self = pathKey(repo.path);
  return artifacts.filter((artifact) => pathKey(artifact.path) !== self && isUnder(checkout, artifact.path));
}

/**
 * The tool that keeps this clone, when its path says so: Homebrew and
 * its taps, Scoop buckets, or any hidden folder (`~/.nvm`, `~/.oh-my-zsh`,
 * `~/.cargo/git/checkouts`) and app data folder. Removing one of those
 * by hand breaks the tool, so the Dev tab only reveals it.
 *
 * Only folders below `scanRoot` count: a scan started inside a hidden
 * folder is aimed there on purpose.
 */
export function gitRepoManagedBy(checkout: string, scanRoot: string | null = null): string | null {
  const parts = checkout.split(/[\\/]+/).filter(Boolean);
  const rootParts = scanRoot ? scanRoot.split(/[\\/]+/).filter(Boolean) : [];
  const below = scanRoot && isUnder(scanRoot, checkout) ? rootParts.length : 0;
  for (let i = below; i < parts.length; i++) {
    const part = parts[i]!;
    const lower = part.toLowerCase();
    if (lower === "homebrew" || lower === ".linuxbrew") return "Homebrew";
    if (lower === "scoop" && /^(apps|buckets)$/i.test(parts[i + 1] ?? "")) return "Scoop";
    if (lower === "appdata") return "AppData";
    if (lower === "library" && i >= 2 && /^(users|home)$/i.test(parts[i - 2] ?? "")) return "Library";
    if (part.length > 1 && part.startsWith(".")) return part;
  }
  return null;
}

/**
 * Why this checkout gets no Remove button, or null when it may.
 * A dotfiles repo at `~` would take the whole home folder with it.
 */
export function gitRepoRemovalBlock(artifact: Pick<DevArtifact, "path">, scanRoot: string | null): string | null {
  const checkout = gitCheckoutPath(artifact);
  if (isUninformativeParent(checkout)) {
    return `Its working folder is ${checkout}. Removing the repo would remove that whole folder, so DiskHound does not offer it.`;
  }
  if (scanRoot && pathKey(checkout) === pathKey(scanRoot)) {
    return "Its working folder is the folder this scan started from. Remove it from the file manager if you mean to.";
  }
  const tool = gitRepoManagedBy(checkout, scanRoot);
  if (tool === "Homebrew" || tool === "Scoop") {
    return `${tool} keeps this clone. Remove it with ${tool}, not here.`;
  }
  if (tool) {
    return `It sits in ${tool}, where a tool usually keeps its own clones. Remove it with that tool, not here.`;
  }
  return null;
}

export type GitRemoteBadge = { label: string; title: string; warn: boolean };

/** The row's remote: where the history also lives, or a warning that it may not. */
export function gitRemoteBadge(git: DevGitRepoInfo | undefined): GitRemoteBadge | null {
  if (!git) return null;
  if (!git.readable) {
    return {
      label: "Remote unknown",
      title: "Could not read .git/config. Check the remote before removing this repo.",
      warn: true,
    };
  }
  if (git.remotes.length === 0) {
    return {
      label: "No remote",
      title: "No remote is configured. This history may exist only on this disk. Do not remove it unless you are sure you no longer need it.",
      warn: true,
    };
  }
  const more = git.remotes.length > 1 ? ` +${git.remotes.length - 1}` : "";
  const where = git.remoteUrl ?? git.remotes[0]!;
  return {
    label: `${where}${more}`,
    title: `Remotes: ${git.remotes.join(", ")}.${git.remoteUrl ? ` ${git.remoteUrl}` : ""} Commits that were never pushed exist only here.`,
    warn: false,
  };
}

/** Whether the second, blunter confirm is needed: history that exists nowhere else. */
export function gitCheckLosesHistory(check: DevGitRepoCheck): boolean {
  return check.remotes.length === 0 || (check.unpushedCommits ?? 0) > 0 || !check.gitAvailable;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/**
 * Confirm text for moving a checkout to the Trash. `second` is asked only
 * when history would exist nowhere else (see `gitCheckLosesHistory`).
 */
export function gitRemovalConfirm(input: {
  artifact: Pick<DevArtifact, "path" | "size">;
  check: DevGitRepoCheck;
  inside: ReadonlyArray<Pick<DevArtifact, "size">>;
  trash: string;
}): { first: string; second: string | null } {
  const { artifact, check, inside, trash } = input;
  const checkout = gitCheckoutPath(artifact);
  const name = basenameOf(checkout) || checkout;
  const warnings: string[] = [];
  if (!check.gitAvailable) {
    warnings.push("⚠ git could not run here, so DiskHound could not check for unpushed commits or uncommitted changes.");
  }
  if (check.remotes.length === 0) {
    warnings.push("⚠ No remote is configured. This repo's history exists only on this disk.");
  } else if (check.unpushedCommits !== null && check.unpushedCommits > 0) {
    warnings.push(`⚠ ${plural(check.unpushedCommits, "commit")} on local branches ${check.unpushedCommits === 1 ? "is" : "are"} not on any remote.`);
  } else if (check.gitAvailable && check.unpushedCommits === null) {
    warnings.push("⚠ Could not check for unpushed commits.");
  }
  if (check.changedFiles !== null && check.changedFiles > 0) {
    warnings.push(`⚠ ${plural(check.changedFiles, "file")} with uncommitted changes.`);
  }
  if (check.stashes !== null && check.stashes > 0) {
    warnings.push(`⚠ ${plural(check.stashes, "stash", "stashes")}.`);
  }
  if (check.linkedWorktrees.length > 0) {
    const shown = check.linkedWorktrees.slice(0, 3).map((path) => `    ${path}`).join("\n");
    const rest = check.linkedWorktrees.length > 3 ? `\n    …and ${formatCount(check.linkedWorktrees.length - 3)} more` : "";
    warnings.push(`⚠ ${plural(check.linkedWorktrees.length, "linked worktree")} use${check.linkedWorktrees.length === 1 ? "s" : ""} this repo and will stop working:\n${shown}${rest}`);
  }

  const insideBytes = inside.reduce((sum, a) => sum + a.size, 0);
  const lines = [
    `Move ${name} to the ${trash}?`,
    "",
    checkout,
    `.git history ${formatBytes(artifact.size)}, plus the working files`
      + (inside.length > 0 ? ` (${plural(inside.length, "other listed tree")}, ${formatBytes(insideBytes)})` : "")
      + ".",
    "",
  ];
  if (warnings.length > 0) {
    lines.push(...warnings, "");
  } else {
    lines.push(`No unpushed commits, uncommitted changes or stashes. You can clone it again from ${check.remoteUrl ?? check.remotes[0]}.`, "");
  }
  if (check.remotes.length > 0 && warnings.length > 0) {
    lines.push(`Remote: ${check.remoteUrl ?? check.remotes.join(", ")}`, "");
  }
  lines.push(`The whole folder goes to the ${trash}. Space comes back when you empty the ${trash}.`);

  const second = gitCheckLosesHistory(check)
    ? `${name}: are you sure?\n\n`
      + (check.remotes.length === 0
        ? "With no remote, nothing else holds this history. Once the "
        : !check.gitAvailable
          ? "Nothing was checked, so some history may exist only here. Once the "
          : "Unpushed commits exist only here. Once the ")
      + `${trash} is emptied, it cannot be recovered.`
    : null;
  return { first: lines.join("\n"), second };
}

/**
 * What git found in a worktree that exists nowhere else, one line each.
 * Empty when git checked it and found nothing: it can go with a bulk
 * delete. An unknown count is a risk, not a pass.
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

const KEPT_SHOWN = 5;

/**
 * The bulk-delete confirm's worktree paragraph: how many git cleared, and
 * the ones held back with their first reason. Held-back worktrees must
 * have their work saved or their Git problem resolved before deletion.
 */
export function worktreeBulkNote(
  cleared: number,
  kept: ReadonlyArray<{ artifact: Pick<DevArtifact, "path">; check: DevWorktreeCheck }>,
): string {
  const lines: string[] = [];
  if (cleared > 0) {
    lines.push(`Git checked ${plural(cleared, "worktree")}: no uncommitted changes, no commits outside a branch.`);
    lines.push("Git will permanently remove these worktrees and their registrations.");
  }
  if (kept.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Not deleted: ${plural(kept.length, "worktree")} that Git could not clear for removal:`);
    for (const { artifact, check } of kept.slice(0, KEPT_SHOWN)) {
      lines.push(`    ${basenameOf(artifact.path) || artifact.path} — ${worktreeRisks(check)[0] ?? ""}`);
    }
    if (kept.length > KEPT_SHOWN) lines.push(`    …and ${formatCount(kept.length - KEPT_SHOWN)} more`);
    lines.push("Save their work or resolve the Git checks before trying again.");
  }
  return lines.join("\n");
}
