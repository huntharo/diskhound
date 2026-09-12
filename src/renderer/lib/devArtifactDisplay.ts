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

function joinTail(parts: string[]): string {
  return parts.join("\\");
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
  return tail.length > 0 ? joinTail(tail) : basenameOf(path);
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

/** Full path when it fits; otherwise `C:\Users\name\…\leaf`. */
export function shortenVisiblePath(path: string, max = 52): string {
  if (path.length <= max) return path;
  const parts = splitPath(path);
  if (parts.length <= 2) return path;
  const sep = pathSep(path, parts);
  const rest = stripDrive(parts);
  const usersIdx = rest.findIndex((p) => p.toLowerCase() === "users");
  const last = parts[parts.length - 1]!;
  if (usersIdx >= 0 && rest[usersIdx + 1]) {
    const user = rest[usersIdx + 1]!;
    if (last.toLowerCase() === user.toLowerCase()) return path;
    const prefix = /^[A-Za-z]:$/.test(parts[0] ?? "")
      ? `${parts[0]}${sep}Users${sep}${user}`
      : `Users${sep}${user}`;
    return `${prefix}${sep}…${sep}${last}`;
  }
  return `${parts[0]}${sep}…${sep}${last}`;
}

export function shortenUnscopedParent(parent: string): string {
  const rest = stripDrive(splitPath(parent));
  const usersIdx = rest.findIndex((p) => p.toLowerCase() === "users");
  if (usersIdx >= 0 && rest[usersIdx + 2]?.toLowerCase() === "appdata") {
    return joinTail(rest.slice(usersIdx + 2));
  }
  if (rest.length <= 3) return joinTail(rest);
  return joinTail(rest.slice(-3));
}

export function artifactHeadline(artifact: DevArtifact): string {
  if (hasDistinctProjectName(artifact)) return artifact.projectName;
  const leaf = basenameOf(artifact.path);
  if (isGenericArtifactLeaf(leaf) || isGenericArtifactLeaf(artifact.projectName)) {
    return shortenVisiblePath(identifyingParent(artifact));
  }
  return leaf || artifact.path;
}

export function artifactTail(artifact: DevArtifact): string {
  if (hasDistinctProjectName(artifact) && artifact.projectPath) {
    return relativeFrom(artifact.path, artifact.projectPath);
  }
  const leaf = basenameOf(artifact.path);
  if (isGenericArtifactLeaf(leaf) || isGenericArtifactLeaf(artifact.projectName)) {
    return relativeFrom(artifact.path, identifyingParent(artifact));
  }
  if (artifact.projectPath) {
    return relativeFrom(artifact.path, artifact.projectPath);
  }
  return shortenUnscopedParent(dirnameOf(artifact.path));
}
