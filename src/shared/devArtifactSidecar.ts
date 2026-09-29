import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";

import type { DevArtifact, DevArtifactCloneInfo, DevArtifactKind, DevArtifactReport } from "./contracts";
import { classifyArtifactPath } from "./devArtifacts";
import { basenameOf, dirnameOf, normPath } from "./pathUtils";

export const DEV_ARTIFACTS_SIDECAR_SUFFIX = ".dev-artifacts.json";
/** Largest trees kept on disk and in the Dev list. Native used to write
 *  ~30k roots + every project marker (~17 MB on C:). Parsing that in the
 *  load worker exited 1; Dev then classified the 1.1M-line folder tree. */
export const DEV_SIDECAR_ROOT_CAP = 2_500;

export interface DevArtifactRootRec {
  path: string;
  kind: DevArtifactKind;
  size: number;
  files: number;
  /** APFS clone accounting from the native macOS scan (optional). */
  clone?: DevArtifactCloneInfo;
}

export interface DevArtifactSidecar {
  version: 1;
  rootPath: string;
  generatedAt: number;
  roots: DevArtifactRootRec[];
  projects: string[];
  /** Paths the user deleted. Kept so a tab switch or hotspot merge cannot resurrect them. */
  droppedPaths?: string[];
}

/** Lowercase file names that mark their folder as a project. */
export const PROJECT_MARKERS: ReadonlySet<string> = new Set([
  "package.json",
  "cargo.toml",
  "go.mod",
  "pyproject.toml",
  "composer.json",
  "gemfile",
  "mix.exs",
  "package.swift",
  ".terraform.lock.hcl",
]);

export function isProjectMarkerName(fileName: string): boolean {
  return PROJECT_MARKERS.has(fileName.toLowerCase());
}

export function createDevAcc(): {
  artifacts: Map<string, { kind: DevArtifactKind; size: number; files: number }>;
  projects: Set<string>;
} {
  return { artifacts: new Map(), projects: new Set() };
}

export type DevAcc = ReturnType<typeof createDevAcc>;

export function noteDevFile(acc: DevAcc, filePath: string, size: number, extraHardlink: boolean): void {
  const name = basenameOf(filePath);
  if (isProjectMarkerName(name)) {
    acc.projects.add(dirnameOf(filePath));
  }
  const match = classifyArtifactPath(filePath);
  if (!match) return;
  const occupancy = extraHardlink ? 0 : size;
  const existing = acc.artifacts.get(match.root);
  if (existing) {
    existing.size += occupancy;
    existing.files += 1;
  } else {
    acc.artifacts.set(match.root, { kind: match.kind, size: occupancy, files: 1 });
  }
}

function normalizeDir(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

function dirIsUnder(parent: string, child: string): boolean {
  const p = normalizeDir(parent);
  const c = normalizeDir(child);
  if (c.length <= p.length) return false;
  const pLower = p.toLowerCase();
  const cLower = c.toLowerCase();
  return cLower.startsWith(pLower + "\\") || cLower.startsWith(pLower + "/");
}

function dirsEqual(a: string, b: string): boolean {
  return normalizeDir(a).toLowerCase() === normalizeDir(b).toLowerCase();
}

/**
 * Fold one folder-tree directory rollup (path + recursive size + file
 * count) into `acc` when the directory is itself an artifact root. Rows
 * below a root (node_modules/preact) are skipped: the root's own row
 * already carries their bytes. A root seen twice keeps the larger row.
 */
export function noteDirectoryRoot(acc: DevAcc, path: string, size: number, files: number): void {
  if (size <= 0) return;
  const match = classifyArtifactPath(path, true);
  if (!match || !dirsEqual(match.root, path)) return;
  const existing = acc.artifacts.get(match.root);
  if (!existing || size > existing.size) {
    acc.artifacts.set(match.root, { kind: match.kind, size, files });
  }
}

/**
 * Whether a folder holding a project marker can own an artifact root.
 * One inside a root (a package.json under node_modules) never can: every
 * path at or below it classifies to that same outer root. Only the
 * nearest project at or above a root is kept by compaction.
 */
export function projectCanOwnArtifact(projectPath: string): boolean {
  const match = classifyArtifactPath(projectPath);
  return !match || !dirIsUnder(match.root, projectPath);
}

/**
 * Drop roots nested in another root (target/debug under target) so
 * occupancy is counted once. Each root checks its own ancestors against
 * the roots kept so far, shortest first. Returns the ancestor lookups.
 */
export function dropNestedRoots(acc: DevAcc): number {
  const kept = new Set<string>();
  let lookups = 0;
  for (const path of [...acc.artifacts.keys()].sort((a, b) => a.length - b.length)) {
    const key = normalizeDir(path).toLowerCase();
    let nested = false;
    for (let i = key.length - 1; i > 0 && !nested; i--) {
      const c = key.charCodeAt(i);
      if (c !== 0x2f && c !== 0x5c) continue;
      lookups += 1;
      nested = kept.has(key.slice(0, i));
    }
    if (nested) acc.artifacts.delete(path);
    else kept.add(key);
  }
  return lookups;
}

export function sidecarFromAcc(acc: DevAcc, rootPath: string): DevArtifactSidecar {
  const roots: DevArtifactRootRec[] = [];
  for (const [path, rec] of acc.artifacts) {
    if (rec.size <= 0) continue;
    roots.push({ path, kind: rec.kind, size: rec.size, files: rec.files });
  }
  roots.sort((a, b) => b.size - a.size);
  return {
    version: 1,
    rootPath,
    generatedAt: Date.now(),
    roots,
    projects: [...acc.projects],
  };
}

function projectLookup(projects: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const project of projects) {
    map.set(normalizeDir(project).toLowerCase(), project);
  }
  return map;
}

function nearestProject(artifactPath: string, projects: Map<string, string>): string | null {
  let cursor = normalizeDir(artifactPath);
  while (true) {
    const hit = projects.get(cursor.toLowerCase());
    if (hit) return hit;
    // Host Path.dirname treats "C:\real\app" as a single name on POSIX.
    const parent = dirnameOf(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function keepArtifact(root: string, projects: Map<string, string>): boolean {
  const last = basenameOf(root).toLowerCase();
  if (last === "dist" || last === "build" || last === "out") {
    return nearestProject(root, projects) !== null;
  }
  return true;
}

/** Keep the largest trees and only the projects that own them. */
export function compactDevArtifactSidecar(sidecar: DevArtifactSidecar): DevArtifactSidecar {
  const roots = sidecar.roots
    .filter((rec) => rec.size > 0)
    .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  const kept = roots.length > DEV_SIDECAR_ROOT_CAP
    ? roots.slice(0, DEV_SIDECAR_ROOT_CAP)
    : roots;
  const projects = projectLookup(sidecar.projects);
  const keptProjects: string[] = [];
  const seen = new Set<string>();
  for (const rec of kept) {
    const project = nearestProject(rec.path, projects);
    if (!project) continue;
    const key = normalizeDir(project).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keptProjects.push(project);
  }
  return {
    version: 1,
    rootPath: sidecar.rootPath,
    generatedAt: sidecar.generatedAt,
    roots: kept,
    projects: keptProjects,
    droppedPaths: sidecar.droppedPaths?.length ? sidecar.droppedPaths : undefined,
  };
}

function uniqueDroppedPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string") continue;
    const key = normalizeDir(path).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

/** Remove deleted trees from the sidecar. Records them so merge/hotspots cannot put them back. */
export function dropSidecarRoots(
  sidecar: DevArtifactSidecar,
  paths: readonly string[],
): DevArtifactSidecar {
  if (paths.length === 0) return sidecar;
  const drop = new Set(paths.map((path) => normalizeDir(path).toLowerCase()));
  return {
    ...sidecar,
    roots: sidecar.roots.filter((rec) => !drop.has(normalizeDir(rec.path).toLowerCase())),
    droppedPaths: uniqueDroppedPaths([...(sidecar.droppedPaths ?? []), ...paths]),
  };
}

export function sidecarFromReport(report: DevArtifactReport): DevArtifactSidecar {
  const projects: string[] = [];
  const seen = new Set<string>();
  for (const artifact of report.artifacts) {
    if (!artifact.projectPath) continue;
    const key = normalizeDir(artifact.projectPath).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    projects.push(artifact.projectPath);
  }
  return {
    version: 1,
    rootPath: report.rootPath,
    generatedAt: report.generatedAt || Date.now(),
    roots: report.artifacts.map((artifact) => ({
      path: artifact.path,
      kind: artifact.kind,
      size: artifact.size,
      files: artifact.fileCount,
      ...(artifact.clone ? { clone: artifact.clone } : {}),
    })),
    projects,
    droppedPaths: report.droppedPaths?.length ? report.droppedPaths : undefined,
  };
}

export function reportFromSidecar(
  sidecar: DevArtifactSidecar,
  previous?: DevArtifactSidecar | null,
): DevArtifactReport {
  const current = compactDevArtifactSidecar(sidecar);
  const prior = previous ? compactDevArtifactSidecar(previous) : null;
  const prevByPath = new Map((prior?.roots ?? []).map((r) => [r.path, r.size]));
  const projects = projectLookup(current.projects);
  const artifacts: DevArtifact[] = [];
  for (const rec of current.roots) {
    if (!keepArtifact(rec.path, projects)) continue;
    // A repo belongs to its checkout, marker file or not.
    const projectPath = rec.kind === "git-repo"
      ? dirnameOf(rec.path)
      : nearestProject(rec.path, projects);
    const previousSize = prevByPath.get(rec.path) ?? null;
    artifacts.push({
      path: rec.path,
      kind: rec.kind,
      projectPath,
      projectName: projectPath ? basenameOf(projectPath) : "Unscoped",
      size: rec.size,
      fileCount: rec.files,
      previousSize,
      deltaBytes: previousSize != null ? rec.size - previousSize : null,
      ...(rec.clone ? { clone: rec.clone } : {}),
    });
  }
  artifacts.sort((a, b) => b.size - a.size);
  const kindMap = new Map<DevArtifactKind, { size: number; count: number }>();
  for (const artifact of artifacts) {
    const entry = kindMap.get(artifact.kind) ?? { size: 0, count: 0 };
    entry.size += artifact.size;
    entry.count += 1;
    kindMap.set(artifact.kind, entry);
  }
  return {
    artifacts,
    totalBytes: artifacts.reduce((sum, a) => sum + a.size, 0),
    totalFiles: artifacts.reduce((sum, a) => sum + a.fileCount, 0),
    projectCount: new Set(artifacts.map((a) => a.projectPath).filter(Boolean)).size,
    kindTotals: [...kindMap.entries()]
      .map(([kind, stats]) => ({ kind, size: stats.size, count: stats.count }))
      .sort((a, b) => b.size - a.size),
    generatedAt: current.generatedAt,
    rootPath: current.rootPath,
    droppedPaths: current.droppedPaths,
  };
}

export async function readDevArtifactSidecar(filePath: string): Promise<DevArtifactSidecar | null> {
  try {
    const raw = await FSP.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as DevArtifactSidecar;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.roots)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Happy path: `{scanId}.dev-artifacts.json` already exists.
 * Salvage: native wrote the sidecar to a pending path after Done, and
 * the history rename missed it. Adopt a pending file whose `rootPath`
 * matches this scan.
 */
export async function resolveDevArtifactSidecar(
  destPath: string,
  scanRoot: string,
  /** A function is only called when `destPath` is missing, to skip listing the dir on the happy path. */
  pendingPaths: string[] | (() => string[]),
): Promise<DevArtifactSidecar | null> {
  const existing = await readDevArtifactSidecar(destPath);
  if (existing) return existing;

  const wanted = normPath(scanRoot);
  for (const pending of typeof pendingPaths === "function" ? pendingPaths() : pendingPaths) {
    const sidecar = await readDevArtifactSidecar(pending);
    if (!sidecar || normPath(sidecar.rootPath) !== wanted) continue;
    try {
      await FSP.rename(pending, destPath);
    } catch {
      const afterClash = await readDevArtifactSidecar(destPath);
      if (afterClash) return afterClash;
      continue;
    }
    return (await readDevArtifactSidecar(destPath)) ?? sidecar;
  }
  return null;
}

/**
 * Happy path for Dev open: read the compact sidecar (or adopt a
 * matching pending file) and build the report. A few hundred KB of
 * JSON — do this in-process. Do not spawn a worker, and do not
 * treat a file on disk as "no sidecar."
 */
export async function loadDevArtifactReport(
  destPath: string,
  scanRoot: string,
  pendingPaths: string[] | (() => string[]),
  previousSidecarPath?: string | null,
): Promise<DevArtifactReport | null> {
  const sidecar = await resolveDevArtifactSidecar(destPath, scanRoot, pendingPaths);
  if (!sidecar) {
    if (FS.existsSync(destPath)) {
      throw new Error(`Dev Artifacts sidecar exists but could not be read: ${Path.basename(destPath)}`);
    }
    return null;
  }
  const compact = compactDevArtifactSidecar(sidecar);
  if (
    compact.roots.length !== sidecar.roots.length
    || compact.projects.length !== sidecar.projects.length
  ) {
    await writeDevArtifactSidecar(destPath, compact);
  }
  const previous = previousSidecarPath
    ? await readDevArtifactSidecar(previousSidecarPath)
    : null;
  return reportFromSidecar(compact, previous);
}

export async function writeDevArtifactSidecar(filePath: string, sidecar: DevArtifactSidecar): Promise<void> {
  await FSP.mkdir(Path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await FSP.writeFile(tmp, JSON.stringify(compactDevArtifactSidecar(sidecar)));
  await FSP.rename(tmp, filePath);
}
