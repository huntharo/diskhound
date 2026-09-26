import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

import type { DevArtifact, DevArtifactKind, DevArtifactReport } from "./contracts";
import { classifyArtifactPath } from "./devArtifacts";
import { occupancyBytes } from "./allocatedSize";
import { attachPipeErrorHandlers } from "./streamSafety";
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

const PROJECT_MARKERS = new Set([
  "package.json",
  "cargo.toml",
  "go.mod",
  "pyproject.toml",
  "composer.json",
  "gemfile",
  "mix.exs",
  "package.swift",
]);

/** Names the full scanner looks for under a project. Rescan does not
 *  expand these — 4k projects × 17 hints used to enqueue tens of
 *  thousands of walks. New trees show up on the next full scan. */
export const PROJECT_CHILD_HINTS = [
  "node_modules",
  "target",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".parcel-cache",
  ".svelte-kit",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "obj",
];

export interface DevArtifactsRescanProgress {
  treesWalked: number;
  treesTotal: number;
  currentPath: string;
  filesSoFar: number;
  bytesSoFar: number;
  elapsedMs: number;
}

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
 * Build a sidecar from folder-tree directory rollups (path + recursive
 * size + file count). Used when a scan predates the Dev sidecar so we
 * never stream the 7M-file index. Nested classified dirs (target/debug
 * under target) are dropped so occupancy is counted once.
 */
export function sidecarFromDirectoryRoots(
  rootPath: string,
  dirs: Array<{ path: string; size: number; files: number }>,
  projectPaths: Iterable<string> = [],
): DevArtifactSidecar {
  const acc = createDevAcc();
  for (const project of projectPaths) acc.projects.add(project);
  for (const dir of dirs) {
    if (dir.size <= 0) continue;
    const match = classifyArtifactPath(dir.path);
    if (!match || !dirsEqual(match.root, dir.path)) continue;
    const existing = acc.artifacts.get(match.root);
    if (!existing || dir.size > existing.size) {
      acc.artifacts.set(match.root, { kind: match.kind, size: dir.size, files: dir.files });
    }
  }
  const kept = [...acc.artifacts.keys()].sort((a, b) => a.length - b.length);
  const survivors = new Set<string>();
  for (const path of kept) {
    if ([...survivors].some((parent) => dirIsUnder(parent, path))) continue;
    survivors.add(path);
  }
  for (const path of [...acc.artifacts.keys()]) {
    if (!survivors.has(path)) acc.artifacts.delete(path);
  }
  return sidecarFromAcc(acc, rootPath);
}

/**
 * Classify from a folder-tree sidecar (NDJSON.gz). Used for scans that
 * predate `.dev-artifacts.json`. Never opens the 7M-file index.
 * Returns null when the file is missing, unreadable, or has no parents.
 */
export async function sidecarFromFolderTreeFile(
  filePath: string,
  treeRoot: string,
): Promise<DevArtifactSidecar | null> {
  if (!FS.existsSync(filePath)) return null;

  const dirs: Array<{ path: string; size: number; files: number }> = [];
  const projects: string[] = [];
  let parents = 0;

  const gunzip = createGunzip();
  const source = FS.createReadStream(filePath);
  attachPipeErrorHandlers([source, gunzip]);
  source.pipe(gunzip);
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line) continue;
      let rec: {
        k?: string;
        d?: [string, number, number][];
        f?: [string, number, number][];
      };
      try { rec = JSON.parse(line); } catch { continue; }
      if (typeof rec.k !== "string") continue;
      parents += 1;
      if (Array.isArray(rec.f)) {
        for (const row of rec.f) {
          if (Array.isArray(row) && typeof row[0] === "string" && isProjectMarkerName(row[0])) {
            projects.push(rec.k);
          }
        }
      }
      if (!Array.isArray(rec.d)) continue;
      for (const row of rec.d) {
        if (!Array.isArray(row) || row.length < 3) continue;
        const [path, size, files] = row;
        if (typeof path !== "string" || typeof size !== "number" || typeof files !== "number") continue;
        if (size <= 0) continue;
        dirs.push({ path, size, files });
      }
    }
  } catch {
    return null;
  } finally {
    try { gunzip.destroy(); } catch { /* ok */ }
    try { source.destroy(); } catch { /* ok */ }
  }

  if (parents === 0) return null;
  return sidecarFromDirectoryRoots(treeRoot, dirs, projects);
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
    const projectPath = nearestProject(rec.path, projects);
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

async function walkTreeOccupancy(
  root: string,
  onTick?: (delta: { files: number; size: number }) => void,
): Promise<{ size: number; files: number } | null> {
  try {
    const st = await FSP.lstat(root);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
  } catch {
    return null;
  }
  let size = 0;
  let files = 0;
  let tickFiles = 0;
  let tickSize = 0;
  let lastTick = Date.now();
  const flush = (force = false) => {
    if (!onTick || (tickFiles === 0 && tickSize === 0)) return;
    const now = Date.now();
    if (!force && now - lastTick < 250 && tickFiles < 2_000) return;
    onTick({ files: tickFiles, size: tickSize });
    tickFiles = 0;
    tickSize = 0;
    lastTick = now;
  };
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: FS.Dirent[];
    try {
      entries = await FSP.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = Path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const st = await FSP.stat(full);
        const occ = occupancyBytes(st);
        size += occ;
        files += 1;
        tickFiles += 1;
        tickSize += occ;
        flush();
      } catch {
        /* vanished */
      }
    }
    if (files > 0 && (files & 8191) === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  flush(true);
  return { size, files };
}

function pathKey(p: string): string {
  return normalizeDir(p).toLowerCase();
}

const SKIP_USER_PROFILES = new Set([
  "public",
  "default",
  "default user",
  "all users",
]);

/**
 * Bounded probe for the Windows Disk Cleanup "DiagOutputDir RDP
 * trace logs" folder. Used on rescan so a sidecar written before
 * this kind existed can pick the tree up without a 7M-file stream.
 */
export function discoverDiagLogRoots(scanRoot: string): string[] {
  const sep = scanRoot.includes("/") && !scanRoot.includes("\\") ? "/" : "\\";
  const base = scanRoot.replace(/[\\/]+$/, "");
  const found: string[] = [];
  const seen = new Set<string>();

  const pushIfDir = (candidate: string) => {
    const key = pathKey(candidate);
    if (seen.has(key)) return;
    try {
      if (FS.existsSync(candidate) && FS.statSync(candidate).isDirectory()) {
        seen.add(key);
        found.push(candidate);
      }
    } catch {
      /* missing or unreadable */
    }
  };

  pushIfDir(`${base}${sep}Windows${sep}Temp${sep}DiagOutputDir`);
  pushIfDir(`${base}${sep}Windows${sep}Temp${sep}RdClientAutoTrace`);
  pushIfDir(`${base}${sep}AppData${sep}Local${sep}Temp${sep}DiagOutputDir`);
  pushIfDir(`${base}${sep}Temp${sep}DiagOutputDir`);

  const usersDir = `${base}${sep}Users`;
  let profiles: string[] = [];
  try {
    profiles = FS.readdirSync(usersDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !SKIP_USER_PROFILES.has(name.toLowerCase()))
      .slice(0, 32);
  } catch {
    /* not a drive root with Users */
  }
  for (const name of profiles) {
    const temp = `${usersDir}${sep}${name}${sep}AppData${sep}Local${sep}Temp`;
    pushIfDir(`${temp}${sep}DiagOutputDir`);
    pushIfDir(`${temp}${sep}RdClientAutoTrace`);
  }
  return found;
}

/** Known sidecar roots, plus optional seeded trees. Nested seeds drop. */
export function planRescanTargets(
  sidecar: DevArtifactSidecar,
  extraRoots: readonly string[] = [],
): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const rec of sidecar.roots) {
    const key = pathKey(rec.path);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(rec.path);
  }
  const extras = [...extraRoots].sort((a, b) => a.length - b.length);
  for (const path of extras) {
    const key = pathKey(path);
    if (seen.has(key)) continue;
    if (targets.some((parent) => dirIsUnder(parent, path) || dirsEqual(parent, path))) continue;
    if (targets.some((child) => dirIsUnder(path, child))) continue;
    seen.add(key);
    targets.push(path);
  }
  return targets;
}

export async function rescanDevArtifactSidecar(
  sidecar: DevArtifactSidecar,
  onProgress?: (progress: DevArtifactsRescanProgress) => void,
): Promise<DevArtifactSidecar> {
  const acc = createDevAcc();
  for (const project of sidecar.projects) {
    acc.projects.add(project);
  }
  const targets = planRescanTargets(sidecar, discoverDiagLogRoots(sidecar.rootPath));
  const kindByPath = new Map(sidecar.roots.map((r) => [pathKey(r.path), r.kind]));
  const started = Date.now();
  let filesSoFar = 0;
  let bytesSoFar = 0;
  let lastEmit = 0;

  const emit = (walked: number, currentPath: string, force = false) => {
    const now = Date.now();
    if (!force && walked > 0 && walked < targets.length && now - lastEmit < 200) return;
    lastEmit = now;
    onProgress?.({
      treesWalked: walked,
      treesTotal: targets.length,
      currentPath,
      filesSoFar,
      bytesSoFar,
      elapsedMs: now - started,
    });
  };

  emit(0, targets[0] ?? sidecar.rootPath, true);

  for (let i = 0; i < targets.length; i++) {
    const path = targets[i]!;
    emit(i, path, i === 0);
    const walked = await walkTreeOccupancy(path, (delta) => {
      filesSoFar += delta.files;
      bytesSoFar += delta.size;
      emit(i, path);
    });
    if (!walked || walked.size <= 0) continue;
    const kind = kindByPath.get(pathKey(path)) ?? classifyArtifactPath(path)?.kind;
    if (!kind) continue;
    const existing = acc.artifacts.get(path);
    if (existing) {
      existing.size += walked.size;
      existing.files += walked.files;
    } else {
      acc.artifacts.set(path, { kind, size: walked.size, files: walked.files });
    }
  }

  emit(targets.length, targets[targets.length - 1] ?? sidecar.rootPath, true);
  const next = sidecarFromAcc(acc, sidecar.rootPath);
  if (!sidecar.droppedPaths?.length) return next;
  return { ...next, droppedPaths: sidecar.droppedPaths };
}
