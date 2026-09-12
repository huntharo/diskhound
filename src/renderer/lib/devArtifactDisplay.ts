import type { DevArtifact } from "../../shared/contracts";
import { basenameOf, dirnameOf } from "../../shared/pathUtils";

function stripDrive(parts: string[]): string[] {
  if (parts.length > 0 && /^[A-Za-z]:$/.test(parts[0]!)) return parts.slice(1);
  return parts;
}

function splitPath(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
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
  if (artifact.projectName && artifact.projectName !== "Unscoped") {
    return artifact.projectName;
  }
  return basenameOf(artifact.path) || artifact.path;
}

export function artifactTail(artifact: DevArtifact): string {
  if (artifact.projectPath) {
    return relativeFrom(artifact.path, artifact.projectPath);
  }
  return shortenUnscopedParent(dirnameOf(artifact.path));
}
