import { execFile } from "node:child_process";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";

import type { DevArtifactReport, DevGitRepoCheck, DevGitRepoInfo } from "./contracts";

/**
 * Remote names and URLs from the text of a `.git/config`. Only
 * `[remote "name"]` sections count; `include` and `includeIf` files are
 * not followed, so a remote defined only there reads as missing.
 */
export function parseGitRemotes(configText: string): Array<{ name: string; url: string | null }> {
  const remotes: Array<{ name: string; url: string | null }> = [];
  let current: { name: string; url: string | null } | null = null;
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      const section = /^\[\s*remote\s+"((?:[^"\\]|\\.)*)"\s*\]/i.exec(line);
      current = section ? { name: section[1]!.replace(/\\(.)/g, "$1"), url: null } : null;
      if (current) remotes.push(current);
      continue;
    }
    if (!current || current.url !== null) continue;
    const entry = /^url\s*=\s*(.*)$/i.exec(line);
    if (!entry) continue;
    let value = entry[1]!.replace(/\s+[#;].*$/, "").trim();
    if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) value = value.slice(1, -1);
    current.url = value || null;
  }
  return remotes;
}

/**
 * A remote URL fit to show: host and path, with any user, password or
 * token dropped. `git@github.com:me/app.git` → `github.com/me/app`.
 * Local paths are kept as they are, since they name another folder.
 */
export function displayRemoteUrl(url: string): string {
  const trimmed = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(trimmed);
  let hostAndPath: string;
  if (scheme) {
    if (scheme[1]!.toLowerCase() === "file") return trimmed.replace(/\/+$/, "");
    const rest = scheme[2]!;
    const slash = rest.indexOf("/");
    const authority = slash >= 0 ? rest.slice(0, slash) : rest;
    const path = slash >= 0 ? rest.slice(slash) : "";
    const host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d+$/, "");
    hostAndPath = `${host}${path}`;
  } else {
    // scp-like `[user@]host:path`, as long as it is not a Windows drive.
    const scp = /^(?:[^@/\\]+@)?([^:/\\]+):(?!\\)(.+)$/.exec(trimmed);
    if (!scp || /^[A-Za-z]$/.test(scp[1]!)) return trimmed.replace(/[\\/]+$/, "");
    hostAndPath = `${scp[1]}/${scp[2]!.replace(/^\/+/, "")}`;
  }
  return hostAndPath.replace(/\/+$/, "").replace(/\.git$/i, "");
}

export function gitRepoInfoFromConfig(configText: string): DevGitRepoInfo {
  const remotes = parseGitRemotes(configText);
  const preferred = remotes.find((remote) => remote.name === "origin" && remote.url)
    ?? remotes.find((remote) => remote.url);
  return {
    remotes: remotes.map((remote) => remote.name),
    remoteUrl: preferred?.url ? displayRemoteUrl(preferred.url) : null,
    readable: true,
  };
}

const UNREADABLE: DevGitRepoInfo = { remotes: [], remoteUrl: null, readable: false };

/** One read: `<gitDir>/config`. */
export async function readGitRepoInfo(gitDir: string): Promise<DevGitRepoInfo> {
  try {
    return gitRepoInfoFromConfig(await FSP.readFile(Path.join(gitDir, "config"), "utf8"));
  } catch {
    return UNREADABLE;
  }
}

const ANNOTATE_CONCURRENCY = 16;

/**
 * Attach remotes to every `git-repo` row. `cache` is keyed by the `.git`
 * path and outlives the report, so a report rebuilt after a delete or a
 * tab switch reads nothing. A report with no repos comes back as is.
 */
export async function annotateGitRepos(
  report: DevArtifactReport,
  cache: Map<string, DevGitRepoInfo>,
  read: (gitDir: string) => Promise<DevGitRepoInfo> = readGitRepoInfo,
): Promise<DevArtifactReport> {
  const missing: string[] = [];
  let repos = 0;
  for (const artifact of report.artifacts) {
    if (artifact.kind !== "git-repo") continue;
    repos += 1;
    if (!cache.has(artifact.path)) missing.push(artifact.path);
  }
  if (repos === 0) return report;
  let next = 0;
  const worker = async () => {
    while (next < missing.length) {
      const gitDir = missing[next++]!;
      cache.set(gitDir, await read(gitDir));
    }
  };
  await Promise.all(Array.from({ length: Math.min(ANNOTATE_CONCURRENCY, missing.length) }, worker));
  return {
    ...report,
    artifacts: report.artifacts.map((artifact) => {
      if (artifact.kind !== "git-repo") return artifact;
      const git = cache.get(artifact.path);
      return git ? { ...artifact, git } : artifact;
    }),
  };
}

/**
 * Runs `git -C cwd ...args`. Resolves stdout (possibly empty), or null
 * when git failed or is not on PATH.
 */
export type GitCommand = (cwd: string, args: string[]) => Promise<string | null>;

const runGitCommand: GitCommand = (cwd, args) =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { encoding: "utf8", timeout: 20_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });

function lines(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.length > 0);
}

function count(output: string | null): number | null {
  if (output === null) return null;
  const n = Number.parseInt(output.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * What would be lost with this checkout: commits no remote has,
 * uncommitted files, stashes, and worktrees that use its `.git`.
 *
 * Read-only. `--no-optional-locks` keeps `status` from rewriting the
 * index, and fsmonitor is off so no hook command configured in the
 * repo runs.
 */
export async function checkGitRepo(
  checkoutPath: string,
  git: GitCommand = runGitCommand,
  readInfo: (gitDir: string) => Promise<DevGitRepoInfo> = readGitRepoInfo,
): Promise<DevGitRepoCheck> {
  const info = await readInfo(Path.join(checkoutPath, ".git"));
  const base = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
  const gitDir = await git(checkoutPath, [...base, "rev-parse", "--git-dir"]);
  if (gitDir === null) {
    return {
      gitAvailable: false,
      remotes: info.remotes,
      remoteUrl: info.remoteUrl,
      unpushedCommits: null,
      changedFiles: null,
      stashes: null,
      linkedWorktrees: [],
    };
  }
  const [unpushed, status, stashes, worktrees] = await Promise.all([
    git(checkoutPath, [...base, "rev-list", "--count", "--branches", "--not", "--remotes"]),
    git(checkoutPath, [...base, "status", "--porcelain", "--untracked-files=normal"]),
    git(checkoutPath, [...base, "stash", "list"]),
    git(checkoutPath, [...base, "worktree", "list", "--porcelain"]),
  ]);
  const worktreePaths = worktrees === null
    ? []
    : lines(worktrees)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  const self = Path.resolve(checkoutPath).toLowerCase();
  return {
    gitAvailable: true,
    remotes: info.remotes,
    remoteUrl: info.remoteUrl,
    unpushedCommits: count(unpushed),
    changedFiles: status === null ? null : lines(status).length,
    stashes: stashes === null ? null : lines(stashes).length,
    // The first entry is the main checkout itself.
    linkedWorktrees: worktreePaths.filter((path, i) => i > 0 && Path.resolve(path).toLowerCase() !== self),
  };
}
