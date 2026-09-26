import type { DevArtifact } from "../../shared/contracts";
import { basenameOf, dirnameOf } from "../../shared/pathUtils";

/** Folder names that do not identify a project on their own. */
const GENERIC_LEAVES = new Set([
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".parcel-cache",
  ".svelte-kit",
  ".vercel",
  ".netlify",
  "node_modules",
  "target",
  "diagoutputdir",
  "rdclientautotrace",
  ".gradle",
  ".m2",
  ".nuget",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "dist",
  "build",
  "out",
  "debug",
  "release",
  "incremental",
  "obj",
  "mod",
  "pkg",
  "registry",
  "ccache",
  "sccache",
  ".pnpm-store",
  ".yarn",
  ".bun",
  ".cargo",
  ".cache",
  "cmakefiles",
  "cmake-build-debug",
  "cmake-build-release",
  ".terraform",
  ".terraform.d",
  "providers",
  "plugins",
  "plugin-cache",
]);

function stripDrive(parts: string[]): string[] {
  if (parts.length > 0 && /^[A-Za-z]:$/.test(parts[0]!)) return parts.slice(1);
  return parts;
}

function splitPath(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

function pathSep(path: string, parts: string[]): string {
  if (path.includes("\\") || /^[A-Za-z]:$/.test(parts[0] ?? "")) return "\\";
  return "/";
}

function joinTail(parts: string[], sep: string): string {
  return parts.join(sep);
}

function relativeFrom(path: string, root: string): string {
  const pathParts = splitPath(path);
  const rootParts = splitPath(root);
  const pathKey = pathParts.map((p) => p.toLowerCase());
  const rootKey = rootParts.map((p) => p.toLowerCase());
  let i = 0;
  while (i < rootKey.length && i < pathKey.length && rootKey[i] === pathKey[i]) i += 1;
  if (i === 0) return basenameOf(path);
  const tail = pathParts.slice(i);
  return tail.length > 0 ? joinTail(tail, pathSep(path, pathParts)) : basenameOf(path);
}

export function isGenericArtifactLeaf(name: string): boolean {
  return GENERIC_LEAVES.has(name.toLowerCase());
}

export function hasDistinctProjectName(artifact: DevArtifact): boolean {
  return Boolean(
    artifact.projectName
    && artifact.projectName !== "Unscoped"
    && !isGenericArtifactLeaf(artifact.projectName),
  );
}

/** Parent that identifies the project: real projectPath, else walk past generic folders. */
export function identifyingParent(artifact: DevArtifact): string {
  if (artifact.projectPath && !isGenericArtifactLeaf(basenameOf(artifact.projectPath))) {
    return artifact.projectPath;
  }
  let parent = dirnameOf(artifact.path);
  while (isGenericArtifactLeaf(basenameOf(parent))) {
    const next = dirnameOf(parent);
    if (next === parent) break;
    parent = next;
  }
  return parent;
}

/**
 * Home, Temp, profile shells, and drive roots do not identify a project.
 * Named folders such as `pour-over-hub` stay informative.
 */
export function isUninformativeParent(parent: string): boolean {
  const parts = splitPath(parent);
  const rest = stripDrive(parts);
  const key = rest.map((p) => p.toLowerCase());
  if (rest.length === 0) return true;

  const last = key[key.length - 1]!;
  if (last === "temp" || last === "tmp" || last === "tmpdir") return true;

  if (rest.length === 1 && (last === "users" || last === "home")) return true;

  if (rest.length === 2 && (key[0] === "users" || key[0] === "home")) return true;

  if (key[0] === "users" && key[2] === "appdata") {
    if (rest.length === 3) return true;
    if (rest.length === 4 && (key[3] === "local" || key[3] === "roaming" || key[3] === "locallow")) {
      return true;
    }
  }

  return false;
}

function genericLeafLines(artifact: DevArtifact): { headline: string; tail: string } {
  const parent = identifyingParent(artifact);
  const leafRel = relativeFrom(artifact.path, parent);
  if (isUninformativeParent(parent)) {
    return { headline: leafRel, tail: shortenVisiblePath(parent) };
  }
  return { headline: shortenVisiblePath(parent), tail: leafRel };
}

/** Full path when it fits; otherwise `C:\Users\name\…\leaf` or `/Users/name/…/leaf`. */
export function shortenVisiblePath(path: string, max = 52): string {
  if (path.length <= max) return path;
  const parts = splitPath(path);
  if (parts.length <= 2) return path;
  const sep = pathSep(path, parts);
  // splitPath drops the leading `/` (or `\\` for UNC); put it back on the output.
  const root = path.match(/^[\\/]+/)?.[0] ?? "";
  const rest = stripDrive(parts);
  const usersIdx = rest.findIndex((p) => p.toLowerCase() === "users");
  const last = parts[parts.length - 1]!;
  if (usersIdx >= 0 && rest[usersIdx + 1]) {
    const user = rest[usersIdx + 1]!;
    if (last.toLowerCase() === user.toLowerCase()) return path;
    const userEnd = parts.length - rest.length + usersIdx + 2;
    return `${root}${parts.slice(0, userEnd).join(sep)}${sep}…${sep}${last}`;
  }
  return `${root}${parts[0]}${sep}…${sep}${last}`;
}

export function shortenUnscopedParent(parent: string): string {
  const parts = splitPath(parent);
  const sep = pathSep(parent, parts);
  const rest = stripDrive(parts);
  const usersIdx = rest.findIndex((p) => p.toLowerCase() === "users");
  if (usersIdx >= 0 && rest[usersIdx + 2]?.toLowerCase() === "appdata") {
    return joinTail(rest.slice(usersIdx + 2), sep);
  }
  if (rest.length <= 3) return joinTail(rest, sep);
  return joinTail(rest.slice(-3), sep);
}

export function artifactHeadline(artifact: DevArtifact): string {
  const parent = identifyingParent(artifact);
  if (hasDistinctProjectName(artifact) && !isUninformativeParent(parent)) {
    return artifact.projectName;
  }
  const leaf = basenameOf(artifact.path);
  if (isGenericArtifactLeaf(leaf) || isGenericArtifactLeaf(artifact.projectName)) {
    return genericLeafLines(artifact).headline;
  }
  return leaf || artifact.path;
}

export function artifactTail(artifact: DevArtifact): string {
  const parent = identifyingParent(artifact);
  if (hasDistinctProjectName(artifact) && artifact.projectPath && !isUninformativeParent(parent)) {
    return relativeFrom(artifact.path, artifact.projectPath);
  }
  const leaf = basenameOf(artifact.path);
  if (isGenericArtifactLeaf(leaf) || isGenericArtifactLeaf(artifact.projectName)) {
    return genericLeafLines(artifact).tail;
  }
  if (artifact.projectPath) {
    return relativeFrom(artifact.path, artifact.projectPath);
  }
  return shortenUnscopedParent(dirnameOf(artifact.path));
}
