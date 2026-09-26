import * as FS from "node:fs/promises";
import * as Path from "node:path";

import type { AppSettings, ScanSnapshot } from "./shared/contracts";
import { deleteFullDiffCachesForScan } from "./shared/fullDiffCacheStore";
import { consumeLastPrunedIds, saveScanToHistory } from "./shared/scanHistory";
import {
  deleteIndex,
  devArtifactsSidecarPath,
  folderTreeSidecarPath,
  indexFilePath,
} from "./shared/scanIndex";

/**
 * The disk side of finishing a scan: the history entry, then the
 * scanner's pending files renamed to the history ID, then the files of
 * any scan that fell out of retention. main.ts keeps the in-memory
 * caches and the renderer; this module owns what lands in userData, so
 * the I/O budget tests measure the same code the app runs.
 */

export type CommitLog = (tag: string, message: string) => void;

export interface CommitHooks {
  log: CommitLog;
  /** Drop in-memory state for a pruned scan, before its files go. */
  onPruned?: (id: string) => void;
}

/** Files a scanner wrote under a `pending-<uuid>` name. */
export interface PendingScanFiles {
  indexPath?: string;
  folderTreePath?: string;
  devArtifactsPath?: string;
}

export interface CommittedScan {
  /** Null when the history entry could not be written. */
  historyId: string | null;
  /** The index now sits at `indexFilePath(historyId)`. */
  indexCommitted: boolean;
  /** Scans that fell out of retention; their files are being deleted. */
  prunedIds: string[];
}

/**
 * Saves `snapshot` to history and moves the scan's pending files to
 * its history ID. Pruned scans' files are deleted in the background.
 */
export async function commitCompletedScan(
  snapshot: ScanSnapshot,
  pending: PendingScanFiles,
  hooks: CommitHooks,
): Promise<CommittedScan> {
  // Persist history before notifying the renderer so immediate diff
  // lookups can see the just-finished scan.
  const historyId = await saveScanToHistory(snapshot);

  // Rename the temp folder-tree sidecar to match the history ID
  // so the Folders-tab loader can find it by scanId. Done first
  // because it's cheap and independent of the NDJSON rename —
  // if this fails the legacy streaming fallback still works.
  if (historyId && pending.folderTreePath) {
    try {
      await FS.rename(pending.folderTreePath, folderTreeSidecarPath(historyId));
    } catch {
      // Sidecar didn't land (scanner skipped it, write failed,
      // etc.). The legacy streaming worker path will handle the
      // Folders tab — slower but correct.
    }
  }
  if (historyId && pending.devArtifactsPath) {
    await adoptTempDevSidecar(pending.devArtifactsPath, devArtifactsSidecarPath(historyId), hooks.log);
  }

  // Rename the temp index file to match the history entry ID
  let indexCommitted = false;
  if (historyId && pending.indexPath) {
    try {
      await FS.rename(pending.indexPath, indexFilePath(historyId));
      indexCommitted = true;
    } catch {
      // Scanner may have skipped or failed to write the index — ignore
    }
  }

  return { historyId, indexCommitted, prunedIds: dropPrunedScans(hooks) };
}

/**
 * Takes the scans the last saveScanToHistory pushed out of retention
 * and deletes their files in the background.
 */
export function dropPrunedScans(hooks: Pick<CommitHooks, "onPruned">): string[] {
  const prunedIds = consumeLastPrunedIds();
  for (const prunedId of prunedIds) {
    hooks.onPruned?.(prunedId);
    void deletePrunedScanFiles(prunedId);
  }
  return prunedIds;
}

/**
 * Deletes the index, both sidecars and the cached full diffs of a scan
 * that fell out of retention. saveScanToHistory already removed its
 * snapshot JSON.
 */
export async function deletePrunedScanFiles(id: string): Promise<void> {
  await Promise.all([
    FS.unlink(folderTreeSidecarPath(id)).catch(() => {}),
    deleteIndex(id),
    deleteFullDiffCachesForScan(id),
  ]);
}

/** Native writes the Dev sidecar before Done. Rename pending → history
 *  id before the UI can open Dev. Brief retry covers a flush race. */
export async function adoptTempDevSidecar(
  tempPath: string,
  destPath: string,
  log: CommitLog,
): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try {
      await FS.access(tempPath);
      await FS.rename(tempPath, destPath);
      log(
        "dev-artifacts-sidecar",
        `renamed ${Path.basename(tempPath)} -> ${Path.basename(destPath)}`,
      );
      return;
    } catch {
      try {
        await FS.access(destPath);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  log(
    "dev-artifacts-sidecar",
    `rename missed ${Path.basename(tempPath)}; Dev open will adopt a matching pending sidecar`,
  );
}

const MAX_RECENT_SCANS = 10;

/**
 * Settings after a completed scan: the scan at the head of
 * `recentScans`, and `defaultRootPath` seeded by the first manual scan
 * so monitoring has a target to rescan without the user setting one.
 */
export function settingsWithRecentScan(
  settings: AppSettings,
  snapshot: ScanSnapshot,
  trigger: "manual" | "scheduled",
  scannedAt = Date.now(),
): AppSettings {
  const rootPath = snapshot.rootPath;
  if (!rootPath) return settings;
  const recent = settings.recentScans.filter((r) => r.path !== rootPath);
  recent.unshift({
    path: rootPath,
    scannedAt,
    filesFound: snapshot.filesVisited,
    bytesFound: snapshot.bytesSeen,
  });
  if (recent.length > MAX_RECENT_SCANS) recent.length = MAX_RECENT_SCANS;

  const shouldSeedDefaultPath = trigger === "manual" && !settings.scanning.defaultRootPath;
  const scanning = shouldSeedDefaultPath
    ? { ...settings.scanning, defaultRootPath: rootPath }
    : settings.scanning;
  return { ...settings, scanning, recentScans: recent };
}
