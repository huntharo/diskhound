/**
 * The Dev Artifacts folder-tree classifier as it was before it streamed:
 * every child-dir row and project marker went into arrays, then the
 * nesting pass compared each root with every survivor. Kept verbatim so
 * tests can check the streaming version returns the same thing.
 */
import * as FS from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

import { classifyArtifactPath } from "../devArtifacts";
import {
  createDevAcc,
  isProjectMarkerName,
  sidecarFromAcc,
  type DevArtifactSidecar,
} from "../devArtifactSidecar";
import { attachPipeErrorHandlers } from "../streamSafety";

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

export function legacySidecarFromDirectoryRoots(
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

export async function legacySidecarFromFolderTreeFile(
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
  return legacySidecarFromDirectoryRoots(treeRoot, dirs, projects);
}
