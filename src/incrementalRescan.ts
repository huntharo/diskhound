import { randomUUID } from "node:crypto";
import * as FS_SYNC from "node:fs";
import * as FS from "node:fs/promises";

import { indexUsesAllocatedSize, type ScanSnapshot } from "./shared/contracts";
import { getScanHistory, saveScanToHistory } from "./shared/scanHistory";
import type { SnapshotWriteOptions } from "./shared/scanStore";
import {
  devArtifactsSidecarPath,
  folderTreeSidecarPath,
  indexFilePath,
} from "./shared/scanIndex";
import { setCursor } from "./shared/usnCursorStore";
import { dropPrunedScans, type CommitLog } from "./scanCommit";
import { getCursorForRoot, runIncrementalScan, type IncrementalResult } from "./usnMonitor";

/**
 * A scheduled rescan from the NTFS change journal (Windows). main.ts's
 * monitoring loop runs this before it falls back to a full scan; this
 * module owns what the tick writes to userData, so the I/O budget
 * tests measure the same code the app runs.
 */

export interface IncrementalRescanDeps {
  /** The native scanner binary, or null when it is not bundled. */
  scannerPath: string | null;
  /** The scan store (last-scan.json) and the renderer. */
  publishSnapshot: (snapshot: ScanSnapshot, options?: SnapshotWriteOptions) => Promise<void>;
  /** Resets the scheduled-rescan clock (disk-baselines.json). */
  markFullScan: (options?: { deferWrite?: boolean }) => void;
  /** A history entry's snapshot, from main.ts's cache when it has it. */
  loadSnapshot: (id: string) => Promise<ScanSnapshot | null>;
  /** Starts the background full diff of the latest pair. */
  warmFullDiff: (rootPath: string) => void;
  /** In-memory side of a new history entry whose index is in place. */
  onCommitted: (rootPath: string, historyId: string) => void;
  /** In-memory side of a scan that fell out of retention. */
  onPruned: (id: string) => void;
  log: CommitLog;
}

export type IncrementalRescanOutcome = {
  rootPath: string;
  /** False when nothing under the root changed and nothing was saved. */
  changed: boolean;
  stats: IncrementalResult["stats"];
};

/**
 * Attempt an incremental (USN-journal) rescan. Returns the outcome if
 * it succeeded and a new snapshot was broadcast — caller skips the full
 * rescan. Returns null if we couldn't run incremental (no cursor, no
 * binary, parse error, wrap, etc), in which case caller does full.
 */
export async function runIncrementalRescan(
  rootPath: string,
  deps: IncrementalRescanDeps,
): Promise<IncrementalRescanOutcome | null> {
  // Explicit diagnostics at every fall-off path so users can run
  // `electron . --inspect` (or just tail the console) and see WHY
  // deltas aren't firing instead of silent-fallback to full scan.
  const binaryPath = deps.scannerPath;
  if (!binaryPath) {
    console.error(`[monitoring] delta skipped — native scanner binary not found for ${rootPath}`);
    return null;
  }

  const cursor = getCursorForRoot(rootPath);
  if (!cursor) {
    console.error(`[monitoring] delta skipped — no USN cursor captured yet for ${rootPath}. ` +
      `A cursor is recorded after the first full scan completes.`);
    return null;
  }

  // Find the most recent index for this root to serve as the delta base.
  const history = getScanHistory(rootPath);
  const mostRecent = history[0];
  if (!mostRecent) {
    console.error(`[monitoring] delta skipped — no scan history for ${rootPath}`);
    return null;
  }
  if (!indexUsesAllocatedSize(mostRecent)) {
    console.error(`[monitoring] delta skipped — previous index still uses logical file size; running a full allocated-size scan for ${rootPath}`);
    return null;
  }
  const previousIndexPath = indexFilePath(mostRecent.id);
  if (!FS_SYNC.existsSync(previousIndexPath)) {
    console.error(`[monitoring] delta skipped — previous index missing at ${previousIndexPath}`);
    return null;
  }

  const newIndexPath = indexFilePath(`pending-${randomUUID()}`);

  let result;
  try {
    result = await runIncrementalScan({
      rootPath,
      scannerPath: binaryPath,
      previousIndexPath,
      newIndexPath,
      cursor,
    });
  } catch (error) {
    console.error(`[monitoring] delta spawn/parse failed for ${rootPath}:`, error);
    try { await FS.unlink(newIndexPath); } catch { /* ignore */ }
    return null;
  }

  if (!result) {
    // Common causes: journal wrap past our cursor, journal ID mismatch
    // (volume reformatted), volume not NTFS. runIncrementalScan logs
    // specifics via its Rust-side error line.
    console.error(`[monitoring] delta returned null for ${rootPath} — likely journal wrap or ID mismatch. Full scan will run.`);
    try { await FS.unlink(newIndexPath); } catch { /* ignore */ }
    return null;
  }

  if (!result.changed) {
    // Nothing under the root changed, so the latest history entry, its
    // index and its sidecars still describe the tree. The tick only
    // restamps the latest scan and moves the cursor and the rescan
    // clock, and those three writes wait for the quit flush: at the
    // 1-minute interval they were ~4 GB/day of the same bytes.
    const latest = await deps.loadSnapshot(mostRecent.id);
    if (latest) {
      const finishedAt = Date.now();
      await deps.publishSnapshot({
        ...latest,
        status: "done",
        startedAt: finishedAt - result.stats.elapsedMs,
        finishedAt,
        elapsedMs: result.stats.elapsedMs,
        lastUpdatedAt: finishedAt,
        scanPhase: "complete",
      }, { deferWrite: true });
    }
    deps.markFullScan({ deferWrite: true });
    await setCursor(result.newCursor, { deferWrite: true });
    return { rootPath, changed: false, stats: result.stats };
  }

  // Save the incremental result to history and update cursor.
  const historyId = await saveScanToHistory(result.snapshot);
  if (!historyId) {
    try { await FS.unlink(newIndexPath); } catch { /* ignore */ }
    return null;
  }

  try {
    await FS.rename(newIndexPath, indexFilePath(historyId));

    // Carry the predecessor's folder-tree sidecar forward.
    //
    // USN rescans update the NDJSON index with deltas, but the
    // folder-tree sidecar is only written by the Rust scanner's
    // full-scan/walker path — NEVER by runIncrementalScan. Without
    // this copy, history[0] (the USN scan) lands in userData with
    // NO sidecar, and the next Folders-tab open falls through to
    // buildFolderTree which streams the 300+ MB gzipped NDJSON
    // into the worker (slow + OOM-prone on big drives; observed
    // as "folder tree worker out of memory" + truncated Folders
    // results).
    //
    // The predecessor's sidecar is accurate for 99%+ of a USN
    // rescan (deltas are a tiny fraction of total entries) and is
    // refreshed on the next full scan. A slightly stale sidecar
    // beats a 300 MB rebuild that might OOM.
    try {
      const prevSidecar = folderTreeSidecarPath(mostRecent.id);
      const nextSidecar = folderTreeSidecarPath(historyId);
      if (FS_SYNC.existsSync(prevSidecar) && !FS_SYNC.existsSync(nextSidecar)) {
        await FS.copyFile(prevSidecar, nextSidecar);
        deps.log(
          "folder-tree-sidecar-carry-forward",
          `usn scan ${historyId} carried forward sidecar from ${mostRecent.id}`,
        );
      }
      const prevDev = devArtifactsSidecarPath(mostRecent.id);
      const nextDev = devArtifactsSidecarPath(historyId);
      if (FS_SYNC.existsSync(prevDev) && !FS_SYNC.existsSync(nextDev)) {
        await FS.copyFile(prevDev, nextDev);
      }
      // Do not JSON.parse the Dev sidecar here. That blocked the
      // window on large C: sidecars. Dev open adopts a pending
      // file in the worker.
    } catch (err) {
      deps.log(
        "folder-tree-sidecar-carry-forward",
        `copy failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    deps.onCommitted(rootPath, historyId);
  } catch { /* ignore */ }

  dropPrunedScans({ onPruned: deps.onPruned });

  await deps.publishSnapshot(result.snapshot);
  deps.markFullScan();
  deps.warmFullDiff(rootPath);

  // Persist the new cursor so the NEXT tick picks up from here.
  await setCursor(result.newCursor);

  return { rootPath, changed: true, stats: result.stats };
}
