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
  "go-module": "Go module & build caches",
  jvm: "Gradle / JVM (Java, Maven, Scala / sbt)",
  dotnet: "NuGet / .NET",
  "compiler-cache": "Compiler & native build caches",
  "cmake-build": "CMake build trees",
  terraform: "Terraform providers",
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
  jvm: "Gradle / JVM",
  dotnet: ".NET",
  "compiler-cache": "Compiler cache",
  "cmake-build": "CMake",
  terraform: "Terraform",
  "diag-logs": "RDP / diag",
};

export function devKindCssVar(kind: DevArtifactKind): string {
  return `var(--dev-k-${kind})`;
}

const SEGMENT_KIND: Record<string, DevArtifactKind> = {
  node_modules: "node-modules",
  ".pnpm-store": "package-cache",
  ".next": "js-build",
  ".nuxt": "js-build",
  ".turbo": "js-build",
  ".parcel-cache": "js-build",
  ".svelte-kit": "js-build",
  __pycache__: "python",
  ".mypy_cache": "python",
  ".pytest_cache": "python",
  ".ruff_cache": "python",
  cmakefiles: "cmake-build",
  ".zig-cache": "compiler-cache",
  ".worktrees": "worktree",
  diagoutputdir: "diag-logs",
  rdclientautotrace: "diag-logs",
};

/**
 * Every lowercase segment name that can start a `classifyArtifactPath`
 * match. A path with none of these segments never classifies, so a
 * streaming reader can skip it without building the path string.
 */
export const ARTIFACT_SEGMENT_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(SEGMENT_KIND),
  "target", "library", "appdata", ".npm", ".local",
  ".pub-cache", ".dart_tool", ".composer", ".gem", "vendor",
  ".hex", "_build", ".stack-work", "dist-newstyle",
  ".yarn", ".bun", ".output", ".vercel", ".netlify",
  ".venv", "venv", ".tox", ".gradle", ".m2", ".nuget",
  "ccache", "sccache", "mozilla.sccache", "obj",
  ".cargo",
  "pkg",
  "pnpm",
  ".cache",
  ".terraform",
  ".terraform.d",
]);

/** Longest supported root: pkg/mod/<host>/<owner>/<module>/v2@v2.0.0. */
export const ARTIFACT_ROOT_LOOKBACK = 6;

// Reserved tool names are ASCII. Unicode case folding (e.g. K -> k)
// must not turn a different folder name into one of these markers.
function lowerArtifactName(value: string): string {
  return /^[\x00-\x7f]*$/.test(value) ? value.toLowerCase() : value;
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

// Only documented cache namespaces. A repository named pip/electron/uv is not evidence.
const CACHE_TOOL_KIND: Readonly<Record<string, DevArtifactKind>> = {
  pip: "python", uv: "python", "go-build": "go-module", coursier: "jvm",
  composer: "package-cache", zig: "compiler-cache",
  ccache: "compiler-cache", sccache: "compiler-cache", "mozilla.sccache": "compiler-cache",
  "vscode-cpptools": "compiler-cache",
  yarn: "package-cache", pnpm: "package-cache", electron: "package-cache",
  "electron-builder": "package-cache", "ms-playwright": "package-cache",
  cypress: "package-cache", homebrew: "package-cache", puppeteer: "package-cache",
  "node-gyp": "package-cache", "org.swift.swiftpm": "package-cache",
};

/**
 * Every root ends within ARTIFACT_ROOT_LOOKBACK segments of its match. The folder-tree
 * fallback (devArtifactFolderTree.ts) relies on that to skip rows whose
 * last ARTIFACT_ROOT_LOOKBACK segments aren't in ARTIFACT_SEGMENT_NAMES, so a rule that
 * reaches further needs that reader changed too.
 */
export function classifyArtifactPath(filePath: string): { root: string; kind: DevArtifactKind } | null {
  const parts = splitSegments(filePath);
  for (let i = 0; i < parts.length; i++) {
    const lower = lowerArtifactName(parts[i]!);
    // Also keeps Object.prototype names ("constructor", "toString")
    // out of the SEGMENT_KIND lookup below.
    if (!ARTIFACT_SEGMENT_NAMES.has(lower)) continue;

    const next = lowerArtifactName(parts[i + 1] ?? "");
    const after = lowerArtifactName(parts[i + 2] ?? "");

    // Language-specific generated/download layouts. Never classify a
    // generic vendor, deps, _build, .build or tool home as a whole.
    if (lower === "library" && next === "developer" && after === "xcode"
      && lowerArtifactName(parts[i + 3] ?? "") === "deriveddata") {
      return { root: joinSegments(filePath, i + 4), kind: "compiler-cache" };
    }
    if ((lower === ".pub-cache" && next === "hosted")
      || (lower === ".composer" && next === "cache")
      || (lower === ".gem" && next === "specs")
      || (lower === ".hex" && next === "packages")) {
      return { root: joinSegments(filePath, i + 2), kind: "package-cache" };
    }
    if (lower === ".pub-cache" && next === "git" && after === "cache") {
      return { root: joinSegments(filePath, i + 3), kind: "package-cache" };
    }
    if (lower === "appdata" && next === "local" && after === "pub"
      && lowerArtifactName(parts[i + 3] ?? "") === "cache"
      && lowerArtifactName(parts[i + 4] ?? "") === "hosted") {
      return { root: joinSegments(filePath, i + 5), kind: "package-cache" };
    }
    if (lower === "appdata" && next === "local" && after === "composer"
      && /^(?:files|repo|vcs)$/.test(lowerArtifactName(parts[i + 3] ?? ""))) {
      return { root: joinSegments(filePath, i + 4), kind: "package-cache" };
    }
    if (lower === ".cache" && next === "gem" && /^(?:specs|gems)$/.test(after)) {
      return { root: joinSegments(filePath, i + 3), kind: "package-cache" };
    }
    const ruby = lower === ".gem" && next === "ruby" ? i + 1
      : lower === "vendor" && next === "bundle" && after === "ruby" ? i + 2 : -1;
    if (ruby >= 0 && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(parts[ruby + 1] ?? "")
      && lowerArtifactName(parts[ruby + 2] ?? "") === "cache") {
      return { root: joinSegments(filePath, ruby + 3), kind: "package-cache" };
    }
    if ((lower === ".dart_tool" && next === "flutter_build")
      || (lower === ".stack-work" && next === "dist")
      || (lower === "dist-newstyle" && /^(?:build|cache)$/.test(next))) {
      return { root: joinSegments(filePath, i + 2), kind: "compiler-cache" };
    }
    if (lower === "_build" && /^(?:dev|test|prod|shared)$/.test(next) && after === "lib"
      && /^[a-z][a-z0-9_]*$/.test(lowerArtifactName(parts[i + 3] ?? ""))
      && lowerArtifactName(parts[i + 4] ?? "") === "ebin") {
      return { root: joinSegments(filePath, i + 5), kind: "compiler-cache" };
    }

    const cacheTool = lower === ".cache" ? i + 1
      : lower === "library" && next === "caches" ? i + 2 : -1;
    if (cacheTool >= 0) {
      const tool = lowerArtifactName(parts[cacheTool] ?? "");
      const kind = Object.hasOwn(CACHE_TOOL_KIND, tool) ? CACHE_TOOL_KIND[tool] : undefined;
      if (kind) return { root: joinSegments(filePath, cacheTool + 1), kind };
    }
    // NuGet's HTTP cache is separate from restored packages, on all platforms.
    const nuget = lower === ".local" && next === "share" && after === "nuget" ? i + 2
      : lower === "appdata" && next === "local" && after === "nuget" ? i + 2 : -1;
    if (nuget >= 0 && /^(?:http-cache|v3-cache|plugins-cache)$/.test(lowerArtifactName(parts[nuget + 1] ?? ""))) {
      return { root: joinSegments(filePath, nuget + 2), kind: "dotnet" };
    }
    if (lower === ".npm") {
      if (next === "_cacache") return { root: joinSegments(filePath, i + 2), kind: "package-cache" };
      continue;
    }

    // Tool homes also contain configuration, patches and executables.
    // Classify only the documented cache/output children, never the home.
    if (lower === ".yarn") {
      if (next === "berry" && after === "cache") return { root: joinSegments(filePath, i + 3), kind: "package-cache" };
      return /^(?:cache|unplugged)$/.test(next)
        ? { root: joinSegments(filePath, i + 2), kind: "package-cache" } : null;
    }
    if (lower === ".bun") {
      return next === "install" && after === "cache"
        ? { root: joinSegments(filePath, i + 3), kind: "package-cache" } : null;
    }
    if (lower === ".gradle") {
      if (next === "caches" || /^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(next)) {
        return { root: joinSegments(filePath, i + 2), kind: "jvm" };
      }
      return next === "wrapper" && after === "dists"
        ? { root: joinSegments(filePath, i + 3), kind: "jvm" } : null;
    }
    if (lower === ".m2" || lower === ".nuget") {
      return next === (lower === ".m2" ? "repository" : "packages")
        ? { root: joinSegments(filePath, i + 2), kind: lower === ".m2" ? "jvm" : "dotnet" } : null;
    }
    if (lower === ".vercel" || lower === ".netlify" || lower === ".output") {
      const output = lower === ".vercel" ? /^(?:cache|output)$/.test(next)
        : lower === ".netlify" ? next === "cache" : /^(?:public|server)$/.test(next);
      return output ? { root: joinSegments(filePath, i + 2), kind: "js-build" } : null;
    }
    if (lower === ".venv" || lower === "venv" || lower === ".tox") {
      const lib = i + (lower === ".tox" ? 2 : 1);
      if (lowerArtifactName(parts[lib] ?? "") === "lib") {
        const version = lowerArtifactName(parts[lib + 1] ?? "");
        const packages = version === "site-packages" ? lib + 1
          : /^python[0-9]+\.[0-9]+t?$/.test(version) ? lib + 2 : -1;
        if (packages >= 0 && lowerArtifactName(parts[packages] ?? "") === "site-packages") {
          return { root: joinSegments(filePath, packages + 1), kind: "python" };
        }
      }
      continue;
    }
    if (lower === "obj" && /^(?:debug|release)$/.test(next)
      && /^net(?:[0-9]+(?:\.[0-9]+)?|(?:standard|coreapp)[0-9]+\.[0-9]+)(?:-(?:windows|android|ios|macos|maccatalyst|tvos|browser)(?:[0-9]+(?:\.[0-9]+)*)?)?$/.test(after)) {
      return { root: joinSegments(filePath, i + 3), kind: "dotnet" };
    }
    if (lower === "ccache" || lower === "sccache" || lower === "mozilla.sccache") {
      const parent = lowerArtifactName(parts[i - 1] ?? "");
      const grandparent = lowerArtifactName(parts[i - 2] ?? "");
      if ((parent === "caches" && grandparent === "library")
        || (parent === "local" && grandparent === "appdata")
        || (lower === "sccache" && parent === "mozilla" && grandparent === "local"
          && lowerArtifactName(parts[i - 3] ?? "") === "appdata")) {
        return { root: joinSegments(filePath, i + 1), kind: "compiler-cache" };
      }
      continue;
    }

    if (lower === "target") {
      // Shared by Cargo, sbt, Maven and arbitrary user folders. Never
      // infer a language from target, a profile name, or an ancestor's
      // project marker. Keep only the subtree carrying the evidence.
      const next = lowerArtifactName(parts[i + 1] ?? "");
      if (/^scala-(?:2\.[0-9]+|3)(?:\.[0-9]+)*$/.test(next)
        || next === "maven-status" || next === "maven-archiver") {
        return { root: joinSegments(filePath, i + 2), kind: "jvm" };
      }
      // Cargo's normal and cross-compilation layouts. A target triple
      // must have at least arch/vendor/os; arbitrary intermediate dirs
      // do not strengthen the evidence.
      const profile = /^(?:debug|release)$/.test(next) ? i + 1
        : /^[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_][a-z0-9_-]*$/.test(next) ? i + 2 : -1;
      if (profile >= 0 && /^(?:debug|release)$/.test(lowerArtifactName(parts[profile] ?? "") ?? "")
        && /^(?:deps|incremental|\.fingerprint)$/.test(lowerArtifactName(parts[profile + 1] ?? "") ?? "")) {
        return { root: joinSegments(filePath, profile + 2), kind: "rust-target" };
      }
      // Build scripts have crate-name + 16-hex unit hashes. Keep that unit,
      // never promote the ambiguous profile or a generic build directory.
      if (profile >= 0 && /^(?:debug|release)$/.test(lowerArtifactName(parts[profile] ?? ""))
        && lowerArtifactName(parts[profile + 1] ?? "") === "build"
        && /^[a-z0-9_][a-z0-9_-]*-[0-9a-f]{16}$/.test(lowerArtifactName(parts[profile + 2] ?? ""))) {
        return { root: joinSegments(filePath, profile + 3), kind: "rust-target" };
      }
      continue;
    }

    if (lower === ".cargo" && i + 1 < parts.length && lowerArtifactName(parts[i + 1]!) === "registry") {
      return { root: joinSegments(filePath, i + 2), kind: "cargo-registry" };
    }

    if (lower === "pkg" && next === "mod") {
      if (after === "cache" && lowerArtifactName(parts[i + 3] ?? "") === "download") {
        return { root: joinSegments(filePath, i + 4), kind: "go-module" };
      }
      // pkg/mod can be a source package. Downloaded modules carry a
      // version in the directory name. Bound the search so repeated
      // ambiguous segments cannot turn this into a quadratic walk.
      if (after.includes(".")) {
        for (let end = i + 2; end < Math.min(parts.length, i + ARTIFACT_ROOT_LOOKBACK); end++) {
          if (/^[a-z0-9.!_-]+@v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-z0-9.+-]+)?$/.test(lowerArtifactName(parts[end]!))) {
            return { root: joinSegments(filePath, end + 1), kind: "go-module" };
          }
        }
      }
      continue;
    }

    // pnpm's global content-addressable store outside a `.pnpm-store`
    // folder: `$PNPM_HOME/store`, by default ~/Library/pnpm/store (macOS),
    // ~/.local/share/pnpm/store (Linux) or %LOCALAPPDATA%\pnpm\store
    // (Windows). Projects' node_modules are clones / hard links of it —
    // see storageSharing.ts. Same rule as `classify` in the native
    // scanner's dev_artifacts.rs.
    if (lower === "pnpm" && i + 1 < parts.length && lowerArtifactName(parts[i + 1]!) === "store") {
      return { root: joinSegments(filePath, i + 2), kind: "package-cache" };
    }

    if (lower === ".cache" && i + 1 < parts.length) {
      const next = lowerArtifactName(parts[i + 1]!);
      if (next === "ccache" || next === "sccache" || next === "yarn" || next === "pnpm") {
        const kind: DevArtifactKind = next === "yarn" || next === "pnpm" ? "package-cache" : "compiler-cache";
        return { root: joinSegments(filePath, i + 2), kind };
      }
    }

    // Only the provider downloads, which `terraform init` puts back from
    // the lock file. The rest of .terraform records the selected
    // workspace and the last backend config, so it stays.
    if (lower === ".terraform" && i + 1 < parts.length) {
      const next = lowerArtifactName(parts[i + 1]!);
      if (next === "providers" || next === "plugins") {
        return { root: joinSegments(filePath, i + 2), kind: "terraform" };
      }
    }

    // The documented plugin_cache_dir. `.terraform.d/plugins` holds
    // providers installed by hand, so it stays.
    if (lower === ".terraform.d" && i + 1 < parts.length && lowerArtifactName(parts[i + 1]!) === "plugin-cache") {
      return { root: joinSegments(filePath, i + 2), kind: "terraform" };
    }

    const mapped = SEGMENT_KIND[lower];
    if (mapped) {
      const depth = mapped === "worktree" && i + 1 < parts.length ? i + 2 : i + 1;
      return { root: joinSegments(filePath, depth), kind: mapped };
    }
  }
  return null;
}

function pathKey(p: string): string {
  return p.replace(/[\\/]+$/, "").toLowerCase();
}

function uniqueDroppedPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const key = pathKey(path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

function summarizeArtifacts(artifacts: DevArtifact[]): Pick<
  DevArtifactReport,
  "totalBytes" | "totalFiles" | "projectCount" | "kindTotals"
> {
  const kindMap = new Map<DevArtifactKind, { size: number; count: number }>();
  let totalBytes = 0;
  let totalFiles = 0;
  const projects = new Set<string>();
  for (const artifact of artifacts) {
    totalBytes += artifact.size;
    totalFiles += artifact.fileCount;
    if (artifact.projectPath) projects.add(artifact.projectPath);
    const entry = kindMap.get(artifact.kind) ?? { size: 0, count: 0 };
    entry.size += artifact.size;
    entry.count += 1;
    kindMap.set(artifact.kind, entry);
  }
  return {
    totalBytes,
    totalFiles,
    projectCount: projects.size,
    kindTotals: [...kindMap.entries()]
      .map(([kind, stats]) => ({ kind, size: stats.size, count: stats.count }))
      .sort((a, b) => b.size - a.size),
  };
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

/** Drop deleted trees from the in-memory report and record them so hotspots cannot restore them. */
export function dropArtifactsFromReport(
  report: DevArtifactReport,
  paths: readonly string[],
): DevArtifactReport {
  if (paths.length === 0) return report;
  const drop = new Set(paths.map(pathKey));
  const artifacts = report.artifacts.filter((artifact) => !drop.has(pathKey(artifact.path)));
  const droppedPaths = uniqueDroppedPaths([...(report.droppedPaths ?? []), ...paths]);
  if (
    artifacts.length === report.artifacts.length
    && droppedPaths.length === (report.droppedPaths ?? []).length
  ) {
    return report;
  }
  return {
    ...report,
    artifacts,
    droppedPaths,
    ...summarizeArtifacts(artifacts),
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
  const existing = new Set([
    ...report.artifacts.map((a) => pathKey(a.path)),
    ...(report.droppedPaths ?? []).map(pathKey),
  ]);
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
  return {
    ...report,
    artifacts,
    ...summarizeArtifacts(artifacts),
  };
}
