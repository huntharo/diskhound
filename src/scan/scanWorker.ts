import type { Dirent, Stats } from "node:fs";
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { createInterface } from "node:readline";
import { createGunzip, createGzip } from "node:zlib";
import { parentPort } from "node:worker_threads";

import {
  createIdleScanSnapshot,
  type DirectoryHotspot,
  type ExtensionBucket,
  type MainToWorkerMessage,
  type ScanFileRecord,
  type ScanSnapshot,
  type WorkerToMainMessage,
} from "../shared/contracts";
import { occupancyBytes } from "../shared/allocatedSize";
import { compareEntryNames, HardlinkTracker, type LinkStat } from "../shared/hardlinkTracker";
import {
  createDevAcc,
  noteDevFile,
  sidecarFromAcc,
  writeDevArtifactSidecar,
} from "../shared/devArtifactSidecar";
import { mountPathsToSkip } from "../shared/linuxMounts";

/**
 * Parsed baseline state used by the Phase-1 smart-rescan optimization. For
 * each directory we remember its mtime + all file records whose parent is
 * that directory. If the directory's mtime on disk still matches the
 * baseline's, we inherit all those file records without re-walking the
 * subtree.
 */
export interface BaselineFileRecord extends ScanFileRecord {
  extraHardlink?: boolean;
  /** `dev:ino` of a file with several names (`i`), carried through inheritance. */
  linkId?: string;
}

export interface Baseline {
  dirMtimes: Map<string, number>;
  filesByParent: Map<string, BaselineFileRecord[]>;
  /** The baseline's directories (`dirMtimes`' keys), for subtree lookups. */
  dirs: PathIndex;
  /** `filesByParent`'s keys, for subtree lookups. */
  parents: PathIndex;
  /** `h:1` records: the tree had hardlinks when the baseline was written. */
  extraLinks: number;
}

// Generous internal caps — large enough that no user reasonably hits them,
// small enough that a multi-million-file scan stays memory-safe. The full
// per-file index on disk (NDJSON) is the source of truth for the treemap.
const DEFAULT_TOP_FILE_LIMIT = 5_000;
const DEFAULT_TOP_DIRECTORY_LIMIT = 10_000;
const TOP_EXTENSION_LIMIT = 12;
const STAT_BATCH_SIZE = 32;
const SNAPSHOT_INTERVAL_MS = 200;
// Count a hardlinked file's bytes once (see shared/hardlinkTracker.ts).
// macOS and Linux only; the Windows JS worker still counts every name.
const DEDUPE_HARDLINKS = process.platform !== "win32";
// Scan everything — no exclusion lists. A disk analyzer must be comprehensive.

// Guard: this module may get loaded outside a worker context
// (e.g. shared-chunk resolution during bundling). Only wire up
// the message handler when running as an actual Worker thread.
let cancelled = false;

if (parentPort) {
  parentPort.on("message", (message: MainToWorkerMessage | { type: "cancel" }) => {
    if (message.type === "cancel") {
      cancelled = true;
      return;
    }
    if (message.type !== "start") {
      return;
    }

    cancelled = false;
    void runScan(message.input).catch((error) => {
      parentPort?.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

export async function runScan(
  input: MainToWorkerMessage["input"],
  post: (message: WorkerToMainMessage) => void = (message) => parentPort?.postMessage(message),
): Promise<void> {
  const rootPath = Path.resolve(input.rootPath);
  // Mounts on a different filesystem than rootPath, and second paths to
  // files another mount of this one already shows (bind mounts). Same-pool
  // btrfs subvolumes are walked. Checked before we descend so a scan of
  // `/` does not walk `/mnt/windows`, tmpfs, or a bind's source twice.
  const skippedMounts = mountPathsToSkip(rootPath);
  const scanOptions = input.options;
  const TOP_FILE_LIMIT = input.limits?.topFileLimit ?? DEFAULT_TOP_FILE_LIMIT;
  const TOP_DIRECTORY_LIMIT = input.limits?.topDirectoryLimit ?? DEFAULT_TOP_DIRECTORY_LIMIT;
  const startedAt = Date.now();
  const directoryTotals = new Map<string, DirectoryHotspot>();
  const extensionTotals = new Map<string, ExtensionBucket>();
  const largestFiles = new TopN<ScanFileRecord>(TOP_FILE_LIMIT, biggestFirst);
  const hottestDirectories = new HottestDirectories(directoryTotals, TOP_DIRECTORY_LIMIT);
  const directoryStack = [rootPath];

  let filesVisited = 0;
  let directoriesVisited = 0;
  let skippedEntries = 0;
  let bytesSeen = 0;
  let lastEmitAt = 0;

  // Optional full-file index writer (gzipped NDJSON) for real diff tracking
  let indexGzip: ReturnType<typeof createGzip> | null = null;
  let indexFile: ReturnType<typeof createWriteStream> | null = null;
  if (input.indexOutput) {
    try {
      mkdirSync(Path.dirname(input.indexOutput), { recursive: true });
      indexGzip = createGzip({ level: 6 });
      const outStream = createWriteStream(input.indexOutput);
      indexFile = outStream;
      // Error listeners BEFORE pipe() — pipe doesn't propagate, and
      // a worker thread crash from an unhandled stream error makes
      // the whole scan look like it disappeared into the void.
      indexGzip.on("error", () => { indexGzip = null; });
      outStream.on("error", () => { indexGzip = null; });
      indexGzip.pipe(outStream);
    } catch {
      indexGzip = null;
    }
  }
  const devAcc = createDevAcc();
  const writeIndexEntry = (
    path: string,
    size: number,
    mtime: number,
    extraHardlink = false,
    linkId?: string,
  ) => {
    noteDevFile(devAcc, path, size, extraHardlink);
    if (!indexGzip) return;
    try {
      // Key order matches the native writer (h, then i) so the fast-path
      // parsers in indexLineParse.ts / the Rust reader take it.
      const rec: { p: string; s: number; m: number; h?: 1; i?: string } = { p: path, s: size, m: mtime };
      if (extraHardlink) rec.h = 1;
      if (linkId) rec.i = linkId;
      indexGzip.write(JSON.stringify(rec) + "\n");
    } catch {
      indexGzip = null;
    }
  };
  const writeDirEntry = (path: string, mtime: number) => {
    if (!indexGzip) return;
    try {
      indexGzip.write(JSON.stringify({ p: path, t: "d", m: mtime }) + "\n");
    } catch {
      indexGzip = null;
    }
  };
  const finalizeIndex = async () => {
    if (indexGzip) {
      // Wait for the file, not just gzip: "done" lets main read or rename it.
      const file = indexFile;
      await new Promise<void>((resolve) => {
        if (!file || file.closed) {
          indexGzip!.end(() => resolve());
          return;
        }
        file.once("close", () => resolve());
        file.once("error", () => resolve());
        indexGzip!.end();
      });
      indexGzip = null;
    }
    if (input.devArtifactsOutput) {
      try {
        await writeDevArtifactSidecar(input.devArtifactsOutput, sidecarFromAcc(devAcc, rootPath));
      } catch {
        /* best-effort */
      }
    }
  };

  // Load baseline (Phase 1 smart-rescan). On any parse failure we silently
  // fall back to a full walk.
  let baseline: Baseline | null = null;
  let inheritedFiles = 0;
  let inheritedDirs = 0;
  if (input.baselineIndex && existsSync(input.baselineIndex)) {
    try {
      baseline = await loadBaseline(input.baselineIndex);
    } catch {
      baseline = null;
    }
  }

  const hardlinks = DEDUPE_HARDLINKS ? new HardlinkTracker() : null;
  let hardlinkBytesDeduped = 0;
  // Phase-1 inheritance skips stat, so it never sees inode numbers. If one
  // inode's links were split between an inherited subtree and a walked
  // directory, both would claim the bytes. Inheritance therefore only runs
  // on hardlink-free trees: a baseline that already flags extra links is
  // not used, and the first walked file with nlink > 1 turns it off.
  if (hardlinks && baseline && baseline.extraLinks > 0) {
    console.error(
      `[scanWorker] baseline has ${baseline.extraLinks} extra hardlinks — walking every directory`,
    );
    baseline = null;
  }
  // Files inherited so far, in walk order. When inheritance turns off, their
  // inodes are read so an inherited name keeps ownership of its bytes.
  const inheritedPaths: string[] = [];
  const stopInheriting = async () => {
    console.error(
      `[scanWorker] hardlink found after ${inheritedDirs} inherited dirs — walking the rest`,
    );
    baseline = null;
    for (let index = 0; index < inheritedPaths.length; index += STAT_BATCH_SIZE) {
      const links = await Promise.all(
        inheritedPaths.slice(index, index + STAT_BATCH_SIZE).map(async (path) => {
          try {
            return await linkStat(path, await FS.stat(path));
          } catch {
            return null;
          }
        }),
      );
      for (const link of links) {
        if (link) hardlinks?.isExtraLink(link);
      }
    }
    inheritedPaths.length = 0;
  };

  directoryTotals.set(rootPath, {
    path: rootPath,
    size: 0,
    fileCount: 0,
    depth: 0,
  });

  const emitSnapshot = (status: ScanSnapshot["status"], errorMessage: string | null = null) => {
    const now = Date.now();
    const snapshot: ScanSnapshot = {
      ...createIdleScanSnapshot(),
      status,
      engine: "js-worker",
      rootPath,
      scanOptions,
      startedAt,
      finishedAt: status === "done" || status === "error" || status === "cancelled" ? now : null,
      elapsedMs: now - startedAt,
      filesVisited,
      directoriesVisited,
      skippedEntries,
      bytesSeen,
      largestFiles: largestFiles.sorted(),
      hottestDirectories: hottestDirectories.current(filesVisited, status !== "running"),
      topExtensions: Array.from(extensionTotals.values())
        .sort((left, right) => right.size - left.size)
        .slice(0, TOP_EXTENSION_LIMIT),
      errorMessage,
      lastUpdatedAt: now,
    };

    post({
      type: status === "done" || status === "cancelled" ? "done" : "progress",
      snapshot,
    });
  };

  while (directoryStack.length > 0) {
    if (cancelled) {
      await finalizeIndex();
      emitSnapshot("cancelled");
      return;
    }

    const directoryPath = directoryStack.pop();
    if (!directoryPath) {
      continue;
    }

    directoriesVisited += 1;

    // Phase-1 mtime skip: if we have a baseline and this directory's mtime
    // hasn't changed, inherit the entire subtree from the baseline instead
    // of re-walking it. This also records the dir entry in the new index
    // so the *next* scan can do the same trick.
    let currentDirMtime: number | null = null;
    try {
      const st = await FS.stat(directoryPath);
      currentDirMtime = st.mtimeMs;
    } catch {
      skippedEntries += 1;
      maybeEmitProgress();
      continue;
    }

    if (baseline) {
      const baselineMtime = baseline.dirMtimes.get(Path.resolve(directoryPath));
      if (baselineMtime !== undefined && Math.abs(baselineMtime - currentDirMtime) < 2) {
        // mtime unchanged (within 2ms tolerance for FS quirks) — inherit
        const inherited = inheritSubtree(directoryPath, baseline);
        for (const fileRecord of inherited) {
          filesVisited += 1;
          const occupancy = fileRecord.extraHardlink ? 0 : fileRecord.size;
          bytesSeen += occupancy;
          if (!fileRecord.extraHardlink) {
            largestFiles.offer(fileRecord);
            rollupExtension(extensionTotals, fileRecord.extension, occupancy);
          }
          rollupDirectorySize(rootPath, fileRecord.parentPath, occupancy, directoryTotals);
          // Re-emit `i` too: inheritance skips the stat, and a name whose
          // other links sit outside the root has `i` but no `h:1`.
          writeIndexEntry(
            fileRecord.path,
            fileRecord.size,
            fileRecord.modifiedAt,
            fileRecord.extraHardlink,
            fileRecord.linkId,
          );
          if (hardlinks) inheritedPaths.push(fileRecord.path);
        }
        // Also re-emit the directory entries under the subtree so the new
        // index remains self-contained for the next scan's baseline.
        for (const subdir of subtreeDirs(directoryPath, baseline)) {
          const subMtime = baseline.dirMtimes.get(subdir);
          if (subMtime !== undefined) writeDirEntry(subdir, subMtime);
        }
        writeDirEntry(Path.resolve(directoryPath), currentDirMtime);
        inheritedFiles += inherited.length;
        inheritedDirs += 1;
        maybeEmitProgress();
        continue;
      }
    }

    // Record this directory's mtime so the next scan can skip it too.
    writeDirEntry(Path.resolve(directoryPath), currentDirMtime);

    let entries: Dirent[];
    try {
      entries = await FS.readdir(directoryPath, { withFileTypes: true });
    } catch {
      skippedEntries += 1;
      maybeEmitProgress();
      continue;
    }

    const fileEntries: Dirent[] = [];
    const subdirectories: string[] = [];
    // Files before subdirectories, each by name: the Rust walker's order,
    // so both engines pick the same owner for a hardlinked file.
    entries.sort((left, right) => compareEntryNames(left.name, right.name));

    for (const entry of entries) {
      const fullPath = Path.join(directoryPath, entry.name);

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        if (skippedMounts.has(fullPath)) {
          continue;
        }
        if (!directoryTotals.has(fullPath)) {
          directoryTotals.set(fullPath, {
            path: fullPath,
            size: 0,
            fileCount: 0,
            depth: getDepth(rootPath, fullPath),
          });
        }
        subdirectories.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      fileEntries.push(entry);
    }
    // The stack pops last-in first, so push in reverse to walk by name.
    for (let index = subdirectories.length - 1; index >= 0; index -= 1) {
      directoryStack.push(subdirectories[index]!);
    }

    for (let index = 0; index < fileEntries.length; index += STAT_BATCH_SIZE) {
      const batch = fileEntries.slice(index, index + STAT_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (entry) => {
          const fullPath = Path.join(directoryPath, entry.name);
          let stat: Stats;
          try {
            stat = await FS.stat(fullPath);
          } catch {
            return null;
          }

          const link = hardlinks ? await linkStat(fullPath, stat) : null;

          const fileRecord: ScanFileRecord = {
            path: fullPath,
            name: entry.name,
            parentPath: directoryPath,
            extension: getExtension(entry.name),
            size: occupancyBytes(stat),
            modifiedAt: stat.mtimeMs,
          };
          return { fileRecord, link };
        }),
      );

      for (const result of batchResults) {
        if (!result) {
          skippedEntries += 1;
          continue;
        }

        const { fileRecord, link } = result;
        // Decide in walk order: batch results keep the sorted order.
        if (link && link.nlink > 1 && baseline) await stopInheriting();
        const extraHardlink = link ? hardlinks!.isExtraLink(link) : false;
        const occupancy = extraHardlink ? 0 : fileRecord.size;

        filesVisited += 1;
        bytesSeen += occupancy;

        if (extraHardlink) {
          hardlinkBytesDeduped += fileRecord.size;
        } else {
          largestFiles.offer(fileRecord);
          rollupExtension(extensionTotals, fileRecord.extension, occupancy);
        }
        rollupDirectorySize(rootPath, directoryPath, occupancy, directoryTotals);
        // Every name of a multi-link file gets the same id, owner included,
        // so Duplicates can fold names of one file without a stat.
        const linkId = link && link.nlink > 1 ? `${link.dev}:${link.ino}` : undefined;
        writeIndexEntry(fileRecord.path, fileRecord.size, fileRecord.modifiedAt, extraHardlink, linkId);
        maybeEmitProgress();
      }
    }
  }

  await finalizeIndex();
  if (hardlinks && hardlinks.extraLinks > 0) {
    console.error(
      `[scanWorker] hardlinks: ${hardlinks.extraLinks} extra links counted once ` +
      `(${hardlinkBytesDeduped} bytes), ${hardlinks.inodesWithUnseenLinks} inodes with links outside the scan`,
    );
  }
  if (inheritedDirs > 0) {
    // Diagnostic: surfaces whether Phase-1 fast-path actually fired, and
    // how much of the tree we inherited vs. walked. Shows up in the
    // worker thread's stderr (captured by Electron's console).
    console.error(
      `[scanWorker] Phase-1 inheritance: ${inheritedDirs} dirs skipped, ` +
      `${inheritedFiles} files inherited from baseline`,
    );
  }
  emitSnapshot("done");

  function maybeEmitProgress() {
    const now = Date.now();
    if (now - lastEmitAt < SNAPSHOT_INTERVAL_MS) {
      return;
    }

    lastEmitAt = now;
    emitSnapshot("running");
  }
}

/**
 * `dev` / `ino` for the hardlink tracker. Inode numbers past 2^53 lose
 * precision as JS numbers, so those take a second, bigint stat.
 */
async function linkStat(path: string, stat: Stats): Promise<LinkStat> {
  if (stat.nlink <= 1 || (Number.isSafeInteger(stat.ino) && Number.isSafeInteger(stat.dev))) {
    return stat;
  }
  try {
    const exact = await FS.stat(path, { bigint: true });
    return { dev: exact.dev, ino: exact.ino, nlink: stat.nlink };
  } catch {
    return stat;
  }
}

function getExtension(fileName: string): string {
  const extension = Path.extname(fileName).trim().toLowerCase();
  return extension.length > 0 ? extension : "(no ext)";
}

function getDepth(rootPath: string, directoryPath: string): number {
  const relativePath = Path.relative(rootPath, directoryPath);
  if (!relativePath) {
    return 0;
  }

  return relativePath.split(Path.sep).length;
}

/**
 * The top `limit` items in `compare` order (negative when `a` ranks first).
 * A binary heap with the lowest-ranked kept item at the root, so an item
 * that doesn't make the list costs one compare and one that does costs
 * O(log limit). A sorted array searched and re-sorted on every insert made
 * a scan O(files × limit).
 */
export class TopN<T> {
  private readonly heap: T[] = [];

  constructor(
    readonly limit: number,
    private readonly compare: (a: T, b: T) => number,
  ) {}

  get size(): number {
    return this.heap.length;
  }

  offer(item: T): void {
    const heap = this.heap;
    if (heap.length < this.limit) {
      heap.push(item);
      this.siftUp(heap.length - 1);
    } else if (heap.length > 0 && this.compare(item, heap[0]!) < 0) {
      heap[0] = item;
      this.siftDown(0);
    }
  }

  /** Every kept item, first-ranked first. */
  sorted(): T[] {
    return [...this.heap].sort(this.compare);
  }

  /** Whether `heap[a]` ranks below `heap[b]`, i.e. belongs nearer the root. */
  private below(a: number, b: number): boolean {
    return this.compare(this.heap[a]!, this.heap[b]!) > 0;
  }

  private swap(a: number, b: number): void {
    const heap = this.heap;
    [heap[a], heap[b]] = [heap[b]!, heap[a]!];
  }

  private siftUp(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.below(index, parent)) return;
      this.swap(index, parent);
      index = parent;
    }
  }

  private siftDown(index: number): void {
    const length = this.heap.length;
    while (true) {
      const left = index * 2 + 1;
      if (left >= length) return;
      const right = left + 1;
      const child = right < length && this.below(right, left) ? right : left;
      if (!this.below(child, index)) return;
      this.swap(index, child);
      index = child;
    }
  }
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Bigger first; of two the same size, the smaller path first. */
export function biggestFirst(a: { size: number; path: string }, b: { size: number; path: string }): number {
  return b.size - a.size || comparePaths(a.path, b.path);
}

/** The `limit` biggest folders holding at least one file, biggest first. */
export function rankDirectories(
  directoryTotals: Map<string, DirectoryHotspot>,
  limit: number,
): DirectoryHotspot[] {
  const top = new TopN<DirectoryHotspot>(limit, biggestFirst);
  for (const directory of directoryTotals.values()) {
    if (directory.fileCount > 0) top.offer(directory);
  }
  // Copies: the totals keep changing after the snapshot is taken.
  return top.sorted().map((directory) => ({ ...directory }));
}

/**
 * `hottestDirectories` for snapshots. Ranking costs O(folders), so a
 * running snapshot re-ranks only once as many files as there are folders
 * have been added since the last ranking. The total stays linear in files
 * however often snapshots fire.
 */
export class HottestDirectories {
  private ranked: DirectoryHotspot[] = [];
  private dueAt = 0;

  constructor(
    private readonly directoryTotals: Map<string, DirectoryHotspot>,
    private readonly limit: number,
  ) {}

  current(filesVisited: number, final: boolean): DirectoryHotspot[] {
    if (final || filesVisited >= this.dueAt) {
      this.ranked = rankDirectories(this.directoryTotals, this.limit);
      this.dueAt = filesVisited + this.directoryTotals.size;
    }
    return this.ranked;
  }
}

/** Add a file's size to its folder and each ancestor up to the root. */
export function rollupDirectorySize(
  rootPath: string,
  directoryPath: string,
  fileSize: number,
  directoryTotals: Map<string, DirectoryHotspot>,
): void {
  let currentPath = directoryPath;

  while (true) {
    let existing = directoryTotals.get(currentPath);
    if (!existing) {
      existing = {
        path: currentPath,
        size: 0,
        fileCount: 0,
        depth: getDepth(rootPath, currentPath),
      };
      directoryTotals.set(currentPath, existing);
    }

    existing.size += fileSize;
    existing.fileCount += 1;

    if (currentPath === rootPath) {
      return;
    }

    const parentPath = Path.dirname(currentPath);
    if (parentPath === currentPath) {
      return;
    }

    currentPath = parentPath;
  }
}

function rollupExtension(
  extensionTotals: Map<string, ExtensionBucket>,
  extension: string,
  fileSize: number,
): void {
  const existing = extensionTotals.get(extension) ?? {
    extension,
    size: 0,
    count: 0,
  };

  existing.size += fileSize;
  existing.count += 1;
  extensionTotals.set(extension, existing);
}

// ── Baseline loading (Phase-1 smart-rescan) ────────────────────────────────

/**
 * Parse a gzipped NDJSON index into a Baseline suitable for mtime-skip lookup.
 * Pre-v0.2.5 indexes have no "t:d" directory entries — in that case the
 * returned Baseline has an empty dirMtimes map and effectively disables the
 * skip optimization (it's not available until a v0.2.5+ scan writes the
 * new format, which happens automatically on the next scan).
 */
async function loadBaseline(filePath: string): Promise<Baseline> {
  const dirMtimes = new Map<string, number>();
  const filesByParent = new Map<string, BaselineFileRecord[]>();
  let extraLinks = 0;

  const gunzip = createGunzip();
  const source = createReadStream(filePath);
  // Don't let an EPERM/ENOENT race on the baseline file (e.g. file
  // rotated while we read it) crash the worker.
  source.on("error", () => { /* swallowed */ });
  gunzip.on("error", () => { /* swallowed */ });
  source.pipe(gunzip);

  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let rec: { p?: string; s?: number; m?: number; t?: string; h?: number; i?: string };
    try {
      rec = JSON.parse(line);
    } catch { continue; }
    if (!rec || typeof rec.p !== "string") continue;

    const normalized = Path.resolve(rec.p);
    if (rec.t === "d") {
      if (typeof rec.m === "number") {
        dirMtimes.set(normalized, rec.m);
      }
      continue;
    }

    if (typeof rec.s !== "number" || typeof rec.m !== "number") continue;
    if (rec.h === 1) extraLinks += 1;

    const name = Path.basename(rec.p);
    const parentPath = Path.resolve(Path.dirname(rec.p));
    const fileRecord: BaselineFileRecord = {
      path: normalized,
      name,
      parentPath,
      extension: getExtension(name),
      size: rec.s,
      modifiedAt: rec.m,
      extraHardlink: rec.h === 1,
      ...(typeof rec.i === "string" && rec.i ? { linkId: rec.i } : {}),
    };

    let list = filesByParent.get(parentPath);
    if (!list) {
      list = [];
      filesByParent.set(parentPath, list);
    }
    list.push(fileRecord);
  }

  return createBaseline(dirMtimes, filesByParent, extraLinks);
}

export function createBaseline(
  dirMtimes: Map<string, number>,
  filesByParent: Map<string, BaselineFileRecord[]>,
  extraLinks: number,
): Baseline {
  return {
    dirMtimes,
    filesByParent,
    dirs: new PathIndex(dirMtimes.keys()),
    parents: new PathIndex(filesByParent.keys()),
    extraLinks,
  };
}

/**
 * Paths sorted so the ones under a folder are one contiguous run, found by
 * binary search: O(log paths + matches) per lookup. `under` returns them in
 * the order they were added, which for a baseline is the order the scan
 * that wrote it walked them. Scanning every path per inherited folder was
 * O(folders²).
 */
export class PathIndex {
  private readonly byPath: Array<{ path: string; order: number }>;

  constructor(paths: Iterable<string>) {
    let order = 0;
    this.byPath = Array.from(paths, (path) => ({ path, order: order++ }));
    this.byPath.sort((a, b) => comparePaths(a.path, b.path));
  }

  /** Paths under `dir`, not `dir` itself. */
  under(dir: string): string[] {
    const prefix = dir.endsWith(Path.sep) ? dir : dir + Path.sep;
    const byPath = this.byPath;
    let low = 0;
    let high = byPath.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (byPath[middle]!.path < prefix) low = middle + 1;
      else high = middle;
    }
    const matches: Array<{ path: string; order: number }> = [];
    for (let index = low; index < byPath.length; index += 1) {
      const entry = byPath[index]!;
      if (!entry.path.startsWith(prefix)) break;
      if (entry.path !== dir) matches.push(entry);
    }
    return matches.sort((a, b) => a.order - b.order).map((entry) => entry.path);
  }
}

/**
 * Return all file records under the given directory (direct + descendants)
 * from the baseline. Used when we skip walking an unchanged subtree.
 */
export function inheritSubtree(dirPath: string, baseline: Baseline): BaselineFileRecord[] {
  const norm = Path.resolve(dirPath);
  const out: BaselineFileRecord[] = [];
  // A loop, not out.push(...list): spreading a folder of ~120k+ files
  // overflows the call stack.
  const add = (list: BaselineFileRecord[] | undefined) => {
    if (!list) return;
    for (const record of list) out.push(record);
  };

  // Direct children first, then descendants in baseline order.
  add(baseline.filesByParent.get(norm));
  for (const parent of baseline.parents.under(norm)) {
    add(baseline.filesByParent.get(parent));
  }

  return out;
}

/**
 * Return all directory paths under the given directory that were present in
 * the baseline. Used to re-emit their dir entries in the new index so the
 * next scan's baseline retains mtime info even for subtrees we skipped.
 */
export function subtreeDirs(dirPath: string, baseline: Baseline): string[] {
  return baseline.dirs.under(Path.resolve(dirPath));
}
