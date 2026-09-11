import { createReadStream, existsSync } from "node:fs";
import * as Path from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

import type { DevArtifact, DevArtifactKind, DevArtifactReport } from "./contracts";
import { attachPipeErrorHandlers } from "./streamSafety";
import { normPath } from "./pathUtils";

export type { DevArtifact, DevArtifactKind, DevArtifactReport };

export const DEV_KIND_LABEL: Record<DevArtifactKind, string> = {
  worktree: "Git worktrees",
  "node-modules": "node_modules",
  "package-cache": "Package manager caches",
  "rust-target": "Rust target/",
  "cargo-registry": "Cargo registry",
  "js-build": "JS / frontend build output",
  python: "Python venv & caches",
  "go-module": "Go module cache",
  jvm: "Gradle / Maven",
  dotnet: "NuGet / .NET",
  "compiler-cache": "Compiler caches",
  "cmake-build": "CMake build trees",
};

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

const SEGMENT_KIND: Record<string, DevArtifactKind> = {
  node_modules: "node-modules",
  ".pnpm-store": "package-cache",
  ".yarn": "package-cache",
  ".bun": "package-cache",
  ".next": "js-build",
  ".nuxt": "js-build",
  ".output": "js-build",
  ".turbo": "js-build",
  ".parcel-cache": "js-build",
  ".svelte-kit": "js-build",
  ".vercel": "js-build",
  ".netlify": "js-build",
  __pycache__: "python",
  ".venv": "python",
  venv: "python",
  ".tox": "python",
  ".mypy_cache": "python",
  ".pytest_cache": "python",
  ".ruff_cache": "python",
  ".gradle": "jvm",
  ".m2": "jvm",
  ".nuget": "dotnet",
  cmakefiles: "cmake-build",
  "cmake-build-debug": "cmake-build",
  "cmake-build-release": "cmake-build",
  ccache: "compiler-cache",
  sccache: "compiler-cache",
  ".worktrees": "worktree",
};

interface Acc {
  kind: DevArtifactKind;
  size: number;
  files: number;
}

function splitSegments(filePath: string): string[] {
  return filePath.split(/[\\/]+/).filter(Boolean);
}

function joinSegments(original: string, count: number): string {
  const parts = splitSegments(original).slice(0, count);
  if (original.startsWith("\\\\") || original.startsWith("//")) {
    return "\\\\" + parts.join("\\");
  }
  const sep = original.includes("\\") ? "\\" : "/";
  const isAbsWin = /^[A-Za-z]:/.test(original);
  const isAbsPosix = original.startsWith("/");
  if (isAbsWin) return parts.join(sep);
  if (isAbsPosix) return sep + parts.join(sep);
  return parts.join(sep);
}

export function classifyArtifactPath(filePath: string): { root: string; kind: DevArtifactKind } | null {
  const parts = splitSegments(filePath);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!;
    const lower = seg.toLowerCase();

    if (lower === "target" && i + 1 < parts.length) {
      const next = parts[i + 1]!.toLowerCase();
      if (next === "debug" || next === "release" || next === "doc" || next === "incremental") {
        return { root: joinSegments(filePath, i + 2), kind: "rust-target" };
      }
      return { root: joinSegments(filePath, i + 1), kind: "rust-target" };
    }

    if (lower === ".cargo" && i + 1 < parts.length && parts[i + 1]!.toLowerCase() === "registry") {
      return { root: joinSegments(filePath, i + 2), kind: "cargo-registry" };
    }

    if (lower === "pkg" && i + 1 < parts.length && parts[i + 1]!.toLowerCase() === "mod") {
      return { root: joinSegments(filePath, i + 2), kind: "go-module" };
    }

    if (lower === ".cache" && i + 1 < parts.length) {
      const next = parts[i + 1]!.toLowerCase();
      if (next === "ccache" || next === "sccache" || next === "yarn" || next === "pnpm") {
        const kind: DevArtifactKind = next === "yarn" || next === "pnpm" ? "package-cache" : "compiler-cache";
        return { root: joinSegments(filePath, i + 2), kind };
      }
    }

    const mapped = SEGMENT_KIND[lower] ?? SEGMENT_KIND[seg];
    if (mapped) {
      const depth = mapped === "worktree" && i + 1 < parts.length ? i + 2 : i + 1;
      return { root: joinSegments(filePath, depth), kind: mapped };
    }

    if (lower === "dist" || lower === "build" || lower === "out") {
      return { root: joinSegments(filePath, i + 1), kind: "js-build" };
    }
  }
  return null;
}

function isProjectMarker(fileName: string): boolean {
  return PROJECT_MARKERS.has(fileName.toLowerCase());
}

function nearestProject(artifactPath: string, projects: string[]): string | null {
  const normalized = normPath(artifactPath);
  let best: string | null = null;
  for (const project of projects) {
    const prefix = normPath(project);
    if (normalized === prefix || normalized.startsWith(prefix + Path.sep) || normalized.startsWith(prefix + "/")) {
      if (!best || prefix.length > best.length) best = project;
    }
  }
  return best;
}

async function accumulateIndex(
  indexPath: string,
): Promise<{ artifacts: Map<string, Acc>; projects: string[] }> {
  const artifacts = new Map<string, Acc>();
  const projectSet = new Set<string>();
  if (!existsSync(indexPath)) return { artifacts, projects: [] };

  const gunzip = createGunzip();
  const source = createReadStream(indexPath);
  attachPipeErrorHandlers([source, gunzip]);
  source.pipe(gunzip);
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line) continue;
      let rec: { p?: string; s?: number; t?: string; h?: number };
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || typeof rec.p !== "string" || rec.t === "d") continue;
      const name = Path.basename(rec.p);
      if (isProjectMarker(name)) {
        projectSet.add(Path.dirname(rec.p));
      }
      if (typeof rec.s !== "number") continue;
      const match = classifyArtifactPath(rec.p);
      if (!match) continue;
      const occupancy = rec.h === 1 ? 0 : rec.s;
      const existing = artifacts.get(match.root);
      if (existing) {
        existing.size += occupancy;
        existing.files += 1;
      } else {
        artifacts.set(match.root, { kind: match.kind, size: occupancy, files: 1 });
      }
    }
  } catch { /* partial */ }
  finally {
    try { gunzip.destroy(); } catch { /* ok */ }
    try { source.destroy(); } catch { /* ok */ }
  }

  return { artifacts, projects: [...projectSet] };
}

function keepArtifact(root: string, _kind: DevArtifactKind, projects: string[]): boolean {
  const last = Path.basename(root).toLowerCase();
  if (last === "dist" || last === "build" || last === "out") {
    return nearestProject(root, projects) !== null;
  }
  return true;
}

export async function analyzeDevArtifacts(
  rootPath: string,
  currentIndexPath: string,
  previousIndexPath?: string | null,
): Promise<DevArtifactReport> {
  const current = await accumulateIndex(currentIndexPath);
  const previous = previousIndexPath ? await accumulateIndex(previousIndexPath) : null;
  const previousByPath = previous?.artifacts ?? new Map<string, Acc>();

  const artifacts: DevArtifact[] = [];
  for (const [path, acc] of current.artifacts) {
    if (acc.size <= 0) continue;
    if (!keepArtifact(path, acc.kind, current.projects)) continue;
    const projectPath = nearestProject(path, current.projects);
    const prev = previousByPath.get(path);
    artifacts.push({
      path,
      kind: acc.kind,
      projectPath,
      projectName: projectPath ? Path.basename(projectPath) : "Unscoped",
      size: acc.size,
      fileCount: acc.files,
      previousSize: prev ? prev.size : null,
      deltaBytes: prev ? acc.size - prev.size : null,
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
    generatedAt: Date.now(),
    rootPath,
  };
}
