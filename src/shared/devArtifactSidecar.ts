import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";

import type { DevArtifact, DevArtifactKind, DevArtifactReport } from "./contracts";
import { classifyArtifactPath } from "./devArtifacts";
import { occupancyBytes } from "./allocatedSize";

export const DEV_ARTIFACTS_SIDECAR_SUFFIX = ".dev-artifacts.json";

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

const PROJECT_CHILD_HINTS = [
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
  const name = Path.basename(filePath);
  if (isProjectMarkerName(name)) {
    acc.projects.add(Path.dirname(filePath));
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

function nearestProject(artifactPath: string, projects: string[]): string | null {
  const normalized = artifactPath.replace(/[\\/]+$/, "");
  let best: string | null = null;
  for (const project of projects) {
    const prefix = project.replace(/[\\/]+$/, "");
    const sep = artifactPath.includes("\\") ? "\\" : "/";
    if (normalized === prefix || normalized.startsWith(prefix + sep) || normalized.startsWith(prefix + "/")) {
      if (!best || prefix.length > best.length) best = project;
    }
  }
  return best;
}

function keepArtifact(root: string, projects: string[]): boolean {
  const last = Path.basename(root).toLowerCase();
  if (last === "dist" || last === "build" || last === "out") {
    return nearestProject(root, projects) !== null;
  }
  return true;
}

export function reportFromSidecar(
  sidecar: DevArtifactSidecar,
  previous?: DevArtifactSidecar | null,
): DevArtifactReport {
  const prevByPath = new Map((previous?.roots ?? []).map((r) => [r.path, r.size]));
  const artifacts: DevArtifact[] = [];
  for (const rec of sidecar.roots) {
    if (rec.size <= 0) continue;
    if (!keepArtifact(rec.path, sidecar.projects)) continue;
    const projectPath = nearestProject(rec.path, sidecar.projects);
    const previousSize = prevByPath.get(rec.path) ?? null;
    artifacts.push({
      path: rec.path,
      kind: rec.kind,
      projectPath,
      projectName: projectPath ? Path.basename(projectPath) : "Unscoped",
      size: rec.size,
      fileCount: rec.files,
      previousSize,
      deltaBytes: previousSize != null ? rec.size - previousSize : null,
    });
  }
  artifacts.sort((a, b) => b.size - a.size);
  const LIST_CAP = 2_500;
  const listed = artifacts.length > LIST_CAP ? artifacts.slice(0, LIST_CAP) : artifacts;
  const kindMap = new Map<DevArtifactKind, { size: number; count: number }>();
  for (const artifact of artifacts) {
    const entry = kindMap.get(artifact.kind) ?? { size: 0, count: 0 };
    entry.size += artifact.size;
    entry.count += 1;
    kindMap.set(artifact.kind, entry);
  }
  return {
    artifacts: listed,
    totalBytes: artifacts.reduce((sum, a) => sum + a.size, 0),
    totalFiles: artifacts.reduce((sum, a) => sum + a.fileCount, 0),
    projectCount: new Set(artifacts.map((a) => a.projectPath).filter(Boolean)).size,
    kindTotals: [...kindMap.entries()]
      .map(([kind, stats]) => ({ kind, size: stats.size, count: stats.count }))
      .sort((a, b) => b.size - a.size),
    generatedAt: sidecar.generatedAt,
    rootPath: sidecar.rootPath,
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

export async function writeDevArtifactSidecar(filePath: string, sidecar: DevArtifactSidecar): Promise<void> {
  await FSP.mkdir(Path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await FSP.writeFile(tmp, JSON.stringify(sidecar));
  await FSP.rename(tmp, filePath);
}

async function walkTreeOccupancy(root: string): Promise<{ size: number; files: number } | null> {
  try {
    const st = await FSP.lstat(root);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
  } catch {
    return null;
  }
  let size = 0;
  let files = 0;
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
        size += occupancyBytes(st);
        files += 1;
      } catch {
        /* vanished */
      }
    }
  }
  return { size, files };
}

export async function rescanDevArtifactSidecar(sidecar: DevArtifactSidecar): Promise<DevArtifactSidecar> {
  const acc = createDevAcc();
  for (const project of sidecar.projects) {
    acc.projects.add(project);
  }
  const seen = new Set<string>();
  const queue: string[] = sidecar.roots.map((r) => r.path);
  for (const project of sidecar.projects) {
    for (const hint of PROJECT_CHILD_HINTS) {
      queue.push(Path.join(project, hint));
    }
  }
  for (const path of queue) {
    if (seen.has(path)) continue;
    seen.add(path);
    const walked = await walkTreeOccupancy(path);
    if (!walked || walked.size <= 0) continue;
    const kind = sidecar.roots.find((r) => r.path === path)?.kind
      ?? classifyArtifactPath(path)?.kind;
    if (!kind) continue;
    const existing = acc.artifacts.get(path);
    if (existing) {
      existing.size += walked.size;
      existing.files += walked.files;
    } else {
      acc.artifacts.set(path, { kind, size: walked.size, files: walked.files });
    }
  }
  return sidecarFromAcc(acc, sidecar.rootPath);
}
