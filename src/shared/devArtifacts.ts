import type { DevArtifact, DevArtifactKind, DevArtifactReport } from "./contracts";

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
  "diag-logs": "RDP / diag traces",
};

/** Short rail labels. Full names stay on group headers and tooltips. */
export const DEV_KIND_SHORT: Record<DevArtifactKind, string> = {
  worktree: "Worktrees",
  "node-modules": "node_modules",
  "package-cache": "Pkg cache",
  "rust-target": "Rust target",
  "cargo-registry": "Cargo",
  "js-build": "JS build",
  python: "Python",
  "go-module": "Go cache",
  jvm: "Gradle",
  dotnet: ".NET",
  "compiler-cache": "ccache",
  "cmake-build": "CMake",
  "diag-logs": "RDP / diag",
};

export function devKindCssVar(kind: DevArtifactKind): string {
  return `var(--dev-k-${kind})`;
}

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
  diagoutputdir: "diag-logs",
  rdclientautotrace: "diag-logs",
};

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

    if (lower === "target") {
      if (i + 1 < parts.length) {
        const next = parts[i + 1]!.toLowerCase();
        if (next === "debug" || next === "release" || next === "doc" || next === "incremental") {
          return { root: joinSegments(filePath, i + 2), kind: "rust-target" };
        }
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

function pathKey(p: string): string {
  return p.replace(/[\\/]+$/, "").toLowerCase();
}

export function emptyDevReport(rootPath: string): DevArtifactReport {
  return {
    artifacts: [],
    totalBytes: 0,
    totalFiles: 0,
    projectCount: 0,
    kindTotals: [],
    generatedAt: 0,
    rootPath,
  };
}

/**
 * Add DiagOutputDir / RdClientAutoTrace trees from scan directory
 * rollups when an older sidecar never classified them. Same
 * `classifyArtifactPath` roots as a new native write. Does not
 * stream the file index.
 */
export function mergeDiagLogHotspots(
  report: DevArtifactReport,
  dirs: ReadonlyArray<{ path: string; size: number; fileCount?: number; files?: number }>,
): DevArtifactReport {
  const existing = new Set(report.artifacts.map((a) => pathKey(a.path)));
  const found = new Map<string, DevArtifact>();

  for (const dir of dirs) {
    const match = classifyArtifactPath(dir.path);
    if (!match || match.kind !== "diag-logs") continue;
    const key = pathKey(match.root);
    if (existing.has(key)) continue;
    const files = dir.fileCount ?? dir.files ?? 0;
    const exact = pathKey(dir.path) === key;
    const prev = found.get(key);
    if (!prev) {
      found.set(key, {
        path: match.root,
        kind: match.kind,
        projectPath: null,
        projectName: "Unscoped",
        size: dir.size,
        fileCount: files,
        previousSize: null,
        deltaBytes: null,
      });
      continue;
    }
    if (exact || dir.size > prev.size) {
      prev.size = exact ? dir.size : Math.max(prev.size, dir.size);
      prev.fileCount = Math.max(prev.fileCount, files);
    }
  }

  if (found.size === 0) return report;

  const artifacts = [...report.artifacts, ...found.values()].sort((a, b) => b.size - a.size);
  const kindMap = new Map<DevArtifactKind, { size: number; count: number }>();
  for (const artifact of artifacts) {
    const entry = kindMap.get(artifact.kind) ?? { size: 0, count: 0 };
    entry.size += artifact.size;
    entry.count += 1;
    kindMap.set(artifact.kind, entry);
  }
  return {
    ...report,
    artifacts,
    totalBytes: artifacts.reduce((sum, a) => sum + a.size, 0),
    totalFiles: artifacts.reduce((sum, a) => sum + a.fileCount, 0),
    projectCount: new Set(artifacts.map((a) => a.projectPath).filter(Boolean)).size,
    kindTotals: [...kindMap.entries()]
      .map(([kind, stats]) => ({ kind, size: stats.size, count: stats.count }))
      .sort((a, b) => b.size - a.size),
  };
}
