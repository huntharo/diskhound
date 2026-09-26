import * as FS from "node:fs";
import * as Path from "node:path";
import { createGzip } from "node:zlib";

import { normalizeAppSettings, type AppSettings, type ScanSnapshot } from "../shared/contracts";
import { writeDevArtifactSidecar, type DevArtifactRootRec } from "../shared/devArtifactSidecar";
import { normPath } from "../shared/pathUtils";
import { initScanHistory, saveScanToHistory, setMaxHistoryPerRoot } from "../shared/scanHistory";
import {
  devArtifactsSidecarPath,
  folderTreeSidecarPath,
  indexFilePath,
  initScanIndex,
} from "../shared/scanIndex";
import { createScanSnapshotStore } from "../shared/scanStore";
import { completedScanSnapshot } from "./scanSnapshotFixture";

/**
 * A DiskHound profile as a previous session left it, for
 * `bootMainProcess({ seed })`: settings, scan history, and for each
 * scan the gzipped index plus the folder-tree and Dev sidecars the
 * native scanner writes.
 *
 * Every scan of a root has the same synthetic tree, so a later scan
 * of an unchanged drive looks like one. Snapshots are
 * `completedScanSnapshot`, the size a real drive scan persists.
 */

export interface SeedRoot {
  /** Absolute; resolved for the host so Windows gets a drive letter. */
  rootPath: string;
  /** Oldest first. The last one is the root's latest scan. */
  scans: number;
  /** Folders under the root, and files in each. */
  folders?: number;
  filesPerFolder?: number;
  /** "artifacts": one node_modules per 10 folders. "empty": a sidecar with no roots. "missing": no sidecar. */
  devSidecar?: "artifacts" | "empty" | "missing";
  /** false leaves out the folder-tree sidecar. */
  folderTree?: boolean;
}

export interface SeededRoot {
  rootPath: string;
  /** History IDs, newest first, like getScanHistory. */
  scanIds: string[];
  /** Folder paths under the root, as the index spells them. */
  folders: string[];
  fileCount: number;
}

export interface SeedOptions {
  roots: SeedRoot[];
  /** Merged over the defaults, one level deep. */
  settings?: { [K in keyof AppSettings]?: Partial<AppSettings[K]> };
  /** Root whose latest scan last-scan.json holds. Defaults to the first. */
  currentRoot?: string;
}

const FINISHED_AT = 1_758_800_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `/Volumes/Data` on POSIX, `C:\Volumes\Data` on Windows. */
export function hostRoot(posixPath: string): string {
  return Path.resolve(posixPath);
}

function gzipLines(filePath: string, lines: Iterable<string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const gzip = createGzip({ level: 6 });
    const out = FS.createWriteStream(filePath);
    out.on("close", () => resolve());
    out.on("error", reject);
    gzip.on("error", reject);
    gzip.pipe(out);
    for (const line of lines) gzip.write(`${line}\n`);
    gzip.end();
  });
}

interface Tree {
  folders: string[];
  files: Array<{ parent: string; name: string; size: number; mtime: number }>;
}

function buildTree(root: SeedRoot): Tree {
  const folderCount = root.folders ?? 200;
  const perFolder = root.filesPerFolder ?? 25;
  const folders: string[] = [];
  const files: Tree["files"] = [];
  for (let area = 0; folders.length < folderCount; area++) {
    const areaPath = Path.join(root.rootPath, `Projects-${area}`);
    folders.push(areaPath);
    for (let i = 0; i < 9 && folders.length < folderCount; i++) {
      folders.push(Path.join(areaPath, i === 0 ? "node_modules" : `module-${i}`));
    }
  }
  folders.forEach((parent, f) => {
    for (let i = 0; i < perFolder; i++) {
      const ext = [".js", ".png", ".log", ".bin", ".json"][i % 5]!;
      files.push({
        parent,
        name: `${i % 7 === 0 ? "report" : "asset"}-${f}-${i}${ext}`,
        size: 1_000 + ((f * 7919 + i * 104_729) % 50_000_000),
        mtime: FINISHED_AT - (f + i) * 60_000,
      });
    }
  });
  return { folders, files };
}

function indexLines(root: string, tree: Tree): string[] {
  const lines = [JSON.stringify({ p: root, t: "d", m: FINISHED_AT })];
  for (const folder of tree.folders) lines.push(JSON.stringify({ p: folder, t: "d", m: FINISHED_AT }));
  for (const file of tree.files) {
    lines.push(JSON.stringify({ p: Path.join(file.parent, file.name), s: file.size, m: file.mtime }));
  }
  return lines;
}

/** One sidecar line per parent: `{k, d: [[path, size, files]], f: [[name, size, mtime]]}`. */
function folderTreeLines(root: string, tree: Tree): string[] {
  const filesBy = new Map<string, Tree["files"]>();
  for (const file of tree.files) filesBy.set(file.parent, [...(filesBy.get(file.parent) ?? []), file]);
  const childDirs = new Map<string, string[]>();
  for (const folder of tree.folders) {
    const parent = Path.dirname(folder);
    childDirs.set(parent, [...(childDirs.get(parent) ?? []), folder]);
  }
  const totals = new Map<string, { size: number; files: number }>();
  const total = (dir: string): { size: number; files: number } => {
    const cached = totals.get(dir);
    if (cached) return cached;
    const own = filesBy.get(dir) ?? [];
    const sum = { size: own.reduce((n, f) => n + f.size, 0), files: own.length };
    for (const child of childDirs.get(dir) ?? []) {
      const sub = total(child);
      sum.size += sub.size;
      sum.files += sub.files;
    }
    totals.set(dir, sum);
    return sum;
  };
  return [root, ...tree.folders].map((dir) => JSON.stringify({
    k: normPath(dir),
    d: (childDirs.get(dir) ?? []).map((child) => [child, total(child).size, total(child).files]),
    f: (filesBy.get(dir) ?? []).map((f) => [f.name, f.size, f.mtime]),
  }));
}

export async function seedProfile(userData: string, options: SeedOptions): Promise<SeededRoot[]> {
  const settings = normalizeAppSettings({
    general: { autoUpdate: false, ...options.settings?.general },
    notifications: { scanComplete: false, deltaAlerts: false, ...options.settings?.notifications },
    scanning: { defaultRootPath: options.roots[0]?.rootPath ?? "", ...options.settings?.scanning },
    monitoring: { ...options.settings?.monitoring },
    storage: {
      maxHistoryPerRoot: Math.max(7, ...options.roots.map((r) => r.scans)),
      ...options.settings?.storage,
    },
    cleanup: { ...options.settings?.cleanup },
  } as Partial<AppSettings>);
  FS.writeFileSync(Path.join(userData, "settings.json"), JSON.stringify(settings, null, 2));

  initScanHistory(userData);
  initScanIndex(userData);
  setMaxHistoryPerRoot(settings.storage.maxHistoryPerRoot);

  const seeded: SeededRoot[] = [];
  const latest = new Map<string, ScanSnapshot>();
  for (const root of options.roots) {
    const tree = buildTree(root);
    const scanIds: string[] = [];
    for (let scan = 0; scan < root.scans; scan++) {
      const finishedAt = FINISHED_AT - (root.scans - 1 - scan) * DAY_MS;
      const snapshot: ScanSnapshot = {
        ...completedScanSnapshot(root.rootPath, finishedAt),
        filesVisited: tree.files.length,
        directoriesVisited: tree.folders.length + 1,
      };
      const id = await saveScanToHistory(snapshot);
      if (!id) throw new Error(`saveScanToHistory refused the seed scan for ${root.rootPath}`);
      scanIds.unshift(id);
      latest.set(root.rootPath, snapshot);

      await gzipLines(indexFilePath(id), indexLines(root.rootPath, tree));
      if (root.folderTree !== false) {
        await gzipLines(folderTreeSidecarPath(id), folderTreeLines(root.rootPath, tree));
      }
      const dev = root.devSidecar ?? "artifacts";
      if (dev !== "missing") {
        const roots: DevArtifactRootRec[] = dev === "empty"
          ? []
          : tree.folders
            .filter((folder) => Path.basename(folder) === "node_modules")
            .map((folder, i) => ({ path: folder, kind: "node-modules", size: 40_000_000 + i * 1_000, files: 900 + i }));
        await writeDevArtifactSidecar(devArtifactsSidecarPath(id), {
          version: 1,
          rootPath: root.rootPath,
          generatedAt: finishedAt,
          roots,
          projects: roots.map((rec) => Path.dirname(rec.path)),
        });
      }
    }
    seeded.push({ rootPath: root.rootPath, scanIds, folders: tree.folders, fileCount: tree.files.length });
  }

  const current = latest.get(options.currentRoot ?? options.roots[0]!.rootPath);
  if (current) {
    const store = await createScanSnapshotStore(userData);
    await store.set(current);
  }
  return seeded;
}
