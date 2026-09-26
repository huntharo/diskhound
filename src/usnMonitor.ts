import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { createInterface } from "node:readline";
import { createGunzip, createGzip } from "node:zlib";

import type { ScanSnapshot } from "./shared/contracts";
import { occupancyBytes } from "./shared/allocatedSize";
import { buildSnapshotFromIndex, indexFilePath } from "./shared/scanIndex";
import {
  getCursor,
  setCursor,
  volumeForPath,
  type VolumeCursor,
} from "./shared/usnCursorStore";
import { normPath } from "./shared/pathUtils";

/**
 * End-to-end USN-journal based incremental monitoring.
 *
 * Primary contract:
 * - `queryCurrentCursor()` — ask the volume for its current USN+journalId so
 *   we can anchor the cursor right after a full scan completes.
 * - `runIncrementalScan()` — read the journal since the saved cursor, apply
 *   deltas to a copy of the previous index, build a fresh snapshot, return
 *   it. On any failure (journal wrapped, ID mismatch, spawn error) this
 *   returns null so the caller falls back to a full scan.
 *
 * This module is Windows-only in practice (the Rust binary's USN support is
 * gated on `cfg(windows)`). On other platforms the caller should simply not
 * wire up cursor capture, and `runIncrementalScan` will return null anyway
 * since there's no cursor.
 */

// ── JSON message shapes emitted by the Rust USN reader ─────────────────────

interface JournalRecord {
  type: "journal-record";
  op: "create" | "modify" | "delete" | "rename" | "close" | "other";
  path: string;
  fileRef: number;
  parentRef: number;
  usn: number;
  reasonMask: number;
  timestamp: number;
  /** Allocated size on disk when the native journal reader could open the file. */
  size?: number;
  /** File last-write time in unix ms, when resolved from the handle. */
  mtime?: number;
  isDirectory?: boolean;
  /** FILE_STANDARD_INFO.NumberOfLinks when the handle could be queried. */
  linkCount?: number;
}

interface JournalCursorEnd {
  type: "journal-cursor";
  cursor: number;
  journalId: number;
  /** Files printed. The scanner folds a file's records into one line. */
  recordsEmitted: number;
  recordsDropped: number;
  /** Journal records read before folding; absent from older scanners. */
  journalRecords?: number;
}

interface JournalErrorLine {
  type: "journal-error";
  message: string;
}

interface CursorQueryLine {
  type: "cursor-query";
  journalId: number;
  nextUsn: number;
  firstUsn: number;
  volume: string;
}

type AnyLine =
  | JournalRecord
  | JournalCursorEnd
  | JournalErrorLine
  | CursorQueryLine;

export interface IncrementalStats {
  recordsRead: number;
  recordsDropped: number;
  additions: number;
  modifications: number;
  deletions: number;
  elapsedMs: number;
}

/**
 * `changed: false` means no file under the root changed since the
 * cursor: no new index was written, and the previous scan still
 * describes the tree.
 */
export type IncrementalResult = {
  newCursor: VolumeCursor;
  stats: IncrementalStats;
} & (
  | { changed: true; snapshot: ScanSnapshot; newIndexPath: string }
  | { changed: false }
);

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Query the volume's current USN cursor + journal ID. Called right after a
 * full scan completes so the next monitoring tick knows where to start
 * reading from. Returns null if the query fails (e.g. non-NTFS, no
 * permission, journal disabled).
 */
export async function queryCurrentCursor(
  scannerPath: string,
  volume: string,
): Promise<{ cursor: number; journalId: number } | null> {
  const driveLetter = volume.replace(/[:\\/]+$/, "").charAt(0).toUpperCase();
  if (!driveLetter) return null;

  try {
    const result = await spawnJson(scannerPath, [
      "--mode", "query-cursor",
      "--volume", driveLetter,
    ], 5_000);

    for (const line of result.lines) {
      if (line.type === "cursor-query") {
        return { cursor: line.nextUsn, journalId: line.journalId };
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Run an incremental scan using the USN journal. Returns null on any
 * condition that requires a full rescan (cursor predates journal, journal
 * ID mismatch, spawn failure, etc).
 */
export async function runIncrementalScan(params: {
  rootPath: string;
  scannerPath: string;
  previousIndexPath: string;
  newIndexPath: string;
  cursor: VolumeCursor;
}): Promise<IncrementalResult | null> {
  const startedAt = Date.now();
  const driveLetter = params.cursor.volume
    .replace(/[:\\/]+$/, "")
    .charAt(0)
    .toUpperCase();
  if (!driveLetter) return null;
  if (!existsSync(params.previousIndexPath)) return null;

  const spawnResult = await spawnJournal(params.scannerPath, driveLetter, params.cursor.cursor);
  if (!spawnResult) return null;
  const { records, cursorEnd } = spawnResult;

  // Journal ID mismatch: the volume's journal has been recreated (volume
  // reformatted, disabled+re-enabled, etc). Any cursor we have is stale.
  if (cursorEnd.journalId !== params.cursor.journalId) return null;

  // Filter records to those under the scan root.
  const rootNorm = normPath(params.rootPath);
  const rootPrefix = rootNorm.endsWith(Path.sep) ? rootNorm : rootNorm + Path.sep;
  const relevant = records.filter((r) => {
    const p = normPath(r.path);
    return p === rootNorm || p.startsWith(rootPrefix);
  });

  // Dedupe per path, keeping the most recent operation. We also prune "close"
  // events which don't represent content changes on their own.
  const byPath = new Map<string, JournalRecord>();
  for (const r of relevant) {
    if (r.op === "close" || r.op === "other") continue;
    byPath.set(normPath(r.path), r);
  }

  const deletes = new Set<string>();
  const createOrModify = new Set<string>();
  for (const [path, rec] of byPath) {
    if (rec.op === "delete") {
      deletes.add(path);
    } else if (!rec.isDirectory) {
      createOrModify.add(path);
    }
  }

  // Prefer allocated size from the journal reader (open-by-id handle).
  // Stat anything the native side couldn't size — Node's Windows stat
  // is logical-only, so this is a last resort.
  const freshEntries = new Map<string, { size: number; mtime: number; extraHardlink?: boolean }>();
  const needStat: string[] = [];
  for (const path of createOrModify) {
    const rec = byPath.get(path);
    if (rec && typeof rec.size === "number" && Number.isFinite(rec.size)) {
      freshEntries.set(path, {
        size: Math.max(0, rec.size),
        mtime: typeof rec.mtime === "number" && rec.mtime > 0 ? rec.mtime : rec.timestamp,
        extraHardlink: typeof rec.linkCount === "number" && rec.linkCount > 1,
      });
    } else {
      needStat.push(path);
    }
  }
  if (needStat.length > 0) {
    const statted = await statInBatches(needStat, 32);
    for (const [path, entry] of statted) {
      freshEntries.set(path, entry);
    }
  }

  const newCursor: VolumeCursor = {
    volume: params.cursor.volume,
    cursor: cursorEnd.cursor,
    journalId: cursorEnd.journalId,
    capturedAt: Date.now(),
    rootPath: params.rootPath,
  };
  const statsFor = (counts: { additions: number; modifications: number; deletions: number }): IncrementalStats => ({
    recordsRead: cursorEnd.journalRecords ?? records.length,
    recordsDropped: cursorEnd.recordsDropped,
    ...counts,
    elapsedMs: Date.now() - startedAt,
  });
  const unchanged = { additions: 0, modifications: 0, deletions: 0 };

  // Nothing under the root to apply: the previous index still holds.
  // Rewriting it would cost the whole index (~330 MB at 7M files).
  if (deletes.size === 0 && freshEntries.size === 0) {
    return { changed: false, newCursor, stats: statsFor(unchanged) };
  }

  // Stream the previous index → new index, applying the deltas.
  const counts = await applyDeltasToIndex(
    params.previousIndexPath,
    params.newIndexPath,
    {
      deletes,
      updates: freshEntries,
    },
  );

  // Records that matched nothing in the index (a delete of a file it
  // never listed, a write that left size and mtime as they were): the
  // new index is the old one again, so keep the old one.
  if (counts.additions + counts.modifications + counts.deletions === 0) {
    await FSP.unlink(params.newIndexPath).catch(() => undefined);
    return { changed: false, newCursor, stats: statsFor(unchanged) };
  }

  // Build the snapshot from the new index. This is a full re-read of the
  // new index, but since the index is gzipped NDJSON it's fast — single-
  // digit seconds for millions of entries.
  const snapshot = await buildSnapshotFromIndex({
    indexPath: params.newIndexPath,
    rootPath: params.rootPath,
    engine: "usn-journal",
    startedAt,
    elapsedMs: Date.now() - startedAt,
  });

  return {
    changed: true,
    snapshot,
    newIndexPath: params.newIndexPath,
    newCursor,
    stats: statsFor(counts),
  };
}

/**
 * Convenience: returns the cursor currently persisted for the root's
 * volume. Thin wrapper that delegates to `usnCursorStore.getCursor`.
 */
export function getCursorForRoot(rootPath: string): VolumeCursor | null {
  return getCursor(volumeForPath(rootPath));
}

/**
 * Quick "are there any changes since last scan" probe used by the
 * rescan fast-path. Spawns the Rust scanner in `journal` mode against
 * the volume's saved cursor; if zero records have been emitted since
 * then, the volume is unchanged and the caller can skip the full scan
 * entirely.
 *
 * Returns:
 *   - { changed: false, newCursor } — safe to reuse last snapshot
 *   - { changed: true, ... }        — rescan required
 *   - null                          — no baseline cursor / non-NTFS /
 *                                     spawn failure; caller falls back
 *                                     to full scan
 */
export interface UsnChangeProbe {
  changed: boolean;
  recordCount: number;
  newCursor?: number;
  newJournalId?: number;
  reason?: string;
}

export async function checkUsnForAnyChanges(
  scannerPath: string,
  rootPath: string,
): Promise<UsnChangeProbe | null> {
  const cursor = getCursorForRoot(rootPath);
  if (!cursor) return null;

  const volume = volumeForPath(rootPath);
  if (!volume) return null;
  const driveLetter = volume[0];
  if (!driveLetter) return null;

  const journal = await spawnJournal(scannerPath, driveLetter, cursor.cursor);
  if (!journal) {
    return { changed: true, recordCount: 0, reason: "journal-spawn-failed" };
  }

  // Journal ID mismatch = journal was disabled+re-enabled or reformatted
  // between scans; our saved cursor is meaningless against the new
  // journal. Force a full rescan.
  if (journal.cursorEnd.journalId !== cursor.journalId) {
    return {
      changed: true,
      recordCount: journal.records.length,
      reason: "journal-id-mismatch",
      newCursor: journal.cursorEnd.cursor,
      newJournalId: journal.cursorEnd.journalId,
    };
  }

  return {
    changed: journal.cursorEnd.recordsEmitted > 0,
    recordCount: journal.cursorEnd.recordsEmitted,
    newCursor: journal.cursorEnd.cursor,
    newJournalId: journal.cursorEnd.journalId,
  };
}

/** Convenience for the main-process post-scan capture path. */
export async function captureCursorAfterScan(
  scannerPath: string,
  rootPath: string,
): Promise<void> {
  const volume = volumeForPath(rootPath);
  if (!volume) {
    console.error(`[monitoring] cursor-capture skipped — couldn't derive volume from ${rootPath}`);
    return;
  }

  const current = await queryCurrentCursor(scannerPath, volume);
  if (!current) {
    // Non-NTFS volumes, journal disabled, or scanner binary failed.
    // Without a cursor, subsequent monitoring ticks will fall back
    // to full scans — so it's worth logging.
    console.error(`[monitoring] cursor-capture failed for ${volume} (root ${rootPath}). ` +
      `Volume may be non-NTFS or USN journal may be disabled. Future scans will be full scans.`);
    return;
  }

  await setCursor({
    volume,
    cursor: current.cursor,
    journalId: current.journalId,
    capturedAt: Date.now(),
    rootPath,
  });
  console.error(`[monitoring] captured USN cursor ${current.cursor} on ${volume} (journalId=${current.journalId})`);
}

// ── Internals ──────────────────────────────────────────────────────────────

/**
 * Spawn the Rust binary in journal mode, collect NDJSON output until it
 * exits, return structured arrays. Returns null on spawn/parse errors.
 */
async function spawnJournal(
  scannerPath: string,
  driveLetter: string,
  cursor: number,
): Promise<{ records: JournalRecord[]; cursorEnd: JournalCursorEnd } | null> {
  const result = await spawnJson(scannerPath, [
    "--mode", "journal",
    "--volume", driveLetter,
    "--cursor", String(cursor),
  ], 60_000);

  const records: JournalRecord[] = [];
  let cursorEnd: JournalCursorEnd | null = null;
  let errored = false;

  for (const line of result.lines) {
    if (line.type === "journal-record") records.push(line);
    else if (line.type === "journal-cursor") cursorEnd = line;
    else if (line.type === "journal-error") errored = true;
  }

  if (errored || !cursorEnd) return null;
  return { records, cursorEnd };
}

async function spawnJson(
  binaryPath: string,
  args: string[],
  timeoutMs: number,
): Promise<{ lines: AnyLine[]; exitCode: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const lines: AnyLine[] = [];
    let stderrBuf = "";
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line) as AnyLine;
        lines.push(parsed);
      } catch { /* skip */ }
    });

    child.stderr?.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
      if (stderrBuf.length > 16_384) stderrBuf = stderrBuf.slice(-16_384);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs).unref();

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // "close", not "exit": stdout can still hold the last lines when
    // the process exits, and the last line is the journal cursor.
    child.once("close", (code) => {
      clearTimeout(timer);
      rl.close();
      resolve({ lines, exitCode: code });
    });
  });
}

/** Stat files in batches, return path → {size, mtime} for files that still exist. */
async function statInBatches(
  paths: string[],
  concurrency: number,
): Promise<Map<string, { size: number; mtime: number }>> {
  const result = new Map<string, { size: number; mtime: number }>();
  for (let i = 0; i < paths.length; i += concurrency) {
    const batch = paths.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (p) => {
        try {
          const st = await FSP.stat(p);
          if (st.isFile()) {
            result.set(normPath(p), { size: occupancyBytes(st), mtime: st.mtimeMs });
          }
        } catch {
          // File vanished between journal and stat, or no permission. The
          // next full scan will reconcile.
        }
      }),
    );
  }
  return result;
}

/**
 * Stream the previous gzipped NDJSON index, applying deletes + updates,
 * writing to a new gzipped NDJSON. Returns counts of each kind of mutation.
 */
async function applyDeltasToIndex(
  previousPath: string,
  newPath: string,
  deltas: {
    deletes: Set<string>;
    updates: Map<string, { size: number; mtime: number; extraHardlink?: boolean }>;
  },
): Promise<{ additions: number; modifications: number; deletions: number }> {
  // Work with a copy of `updates` so we can remove entries as we see them —
  // anything left over at the end is a pure addition.
  const pendingAdds = new Map(deltas.updates);
  let modifications = 0;
  let deletions = 0;

  await FSP.mkdir(Path.dirname(newPath), { recursive: true });

  // Match the native IndexWriter: Compression::fast() is level 1.
  const gzOut = createGzip({ level: 1 });
  const writeStream = createWriteStream(newPath);
  // Attach error listeners BEFORE pipe() — pipe() doesn't propagate
  // errors, so an EPERM/ENOSPC on writeStream or a gzip error becomes
  // an uncaught main-process exception otherwise. The first one is
  // rethrown once the file closes, so a truncated index never becomes
  // a history entry.
  let writeError: unknown = null;
  const closed = new Promise<void>((resolve) => writeStream.once("close", () => resolve()));
  gzOut.on("error", (error) => {
    writeError ??= error;
    writeStream.destroy();
  });
  writeStream.on("error", (error) => { writeError ??= error; });
  gzOut.pipe(writeStream);

  const writeLine = (obj: unknown) => {
    gzOut.write(JSON.stringify(obj) + "\n");
  };

  const gunzip = createGunzip();
  const source = createReadStream(previousPath);
  source.on("error", () => { /* swallowed */ });
  gunzip.on("error", () => { /* swallowed */ });
  source.pipe(gunzip);

  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let rec: { p?: string; s?: number; m?: number; t?: string; h?: number };
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec.p !== "string") continue;

    const norm = normPath(rec.p);

    // Directory entries pass through unchanged. A full incremental would
    // update dir mtimes too, but for now we accept minor staleness — the
    // next full scan (or Phase-1 walk) refreshes them.
    if (rec.t === "d") {
      writeLine({ p: rec.p, t: "d", m: rec.m ?? 0 });
      continue;
    }

    if (deltas.deletes.has(norm)) {
      deletions += 1;
      continue;
    }

    const update = pendingAdds.get(norm);
    if (update) {
      writeLine({ p: rec.p, s: update.size, m: update.mtime, ...(rec.h === 1 ? { h: 1 } : {}) });
      pendingAdds.delete(norm);
      if (update.size !== (rec.s ?? 0) || update.mtime !== (rec.m ?? 0)) modifications += 1;
      continue;
    }

    // Unchanged: pass through, including extra-hardlink occupancy flag.
    writeLine({ p: rec.p, s: rec.s ?? 0, m: rec.m ?? 0, ...(rec.h === 1 ? { h: 1 } : {}) });
  }

  // Anything still in pendingAdds is a new file not previously in the index.
  let additions = 0;
  for (const [path, fresh] of pendingAdds) {
    writeLine({ p: path, s: fresh.size, m: fresh.mtime, ...(fresh.extraHardlink ? { h: 1 } : {}) });
    additions += 1;
  }

  // Wait for the file, not just gzip: the caller reads the new index
  // back as soon as this returns.
  gzOut.end();
  await closed;
  if (writeError) throw writeError;

  return { additions, modifications, deletions };
}

/** Re-export for main.ts to construct index paths by ID. */
export { indexFilePath };
