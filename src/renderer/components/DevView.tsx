import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import type {
  DevArtifact,
  DevArtifactKind,
  DevArtifactReport,
  DevArtifactsRescanProgress,
  ScanSnapshot,
  StorageAccountingReport,
} from "../../shared/contracts";
import {
  DEV_KIND_LABEL,
  DEV_KIND_SHORT,
  devKindCssVar,
  dropArtifactsFromReport,
  emptyDevReport,
  mergeDiagLogHotspots,
} from "../../shared/devArtifacts";
import { inFlightDeleteBytes } from "../../shared/deleteProgress";
import { formatScanRoot, normPath } from "../../shared/pathUtils";
import {
  devArtifactSharing,
  isMeaningfullyShared,
  summarizeDevSharing,
  userDataSnapshots,
  type DevArtifactSharing,
} from "../../shared/storageSharing";
import { artifactHeadline, artifactTail } from "../lib/devArtifactDisplay";
import {
  artifactsAtPaths,
  effectiveDevSort,
  groupDevArtifacts,
  hasDevChangeData,
  isUsefulDevReport,
  reportKey,
  resolveDevPaint,
  seedDevViewState,
  type DevGroupBy,
  type DevSortBy,
} from "../lib/devArtifactViewState";
import { formatBytes, formatCount, relativeTime } from "../lib/format";
import { captureFreeBytes, checkFreedSpace, freedSpaceCheckEnabled } from "../lib/freedSpaceCheck";
import { dispatchDevArtifactsUpdated, STORAGE_ACCOUNTING_STALE_EVENT } from "../lib/uiEvents";
import { nativeApi } from "../nativeApi";
import { DEV_FOLDER_TREE_STAGES, DEV_RESCAN_STAGES, DEV_SIDECAR_STAGES, IndexLoadingPanel } from "./IndexLoadingPanel";
import { toast } from "./Toasts";

interface Props {
  snapshot: ScanSnapshot;
  onStartScan?: () => void;
  otherScannedRoots?: string[];
}


let sessionReport: { key: string; report: DevArtifactReport } | null = null;
let lastGood: { root: string; report: DevArtifactReport } | null = null;
let settledEmptyKey: string | null = null;
let sessionLoadStarted: { key: string; at: number } | null = null;

function rememberReport(root: string, key: string, next: DevArtifactReport | null, completedEmpty: boolean): void {
  if (isUsefulDevReport(next)) {
    sessionReport = { key, report: next };
    lastGood = { root, report: next };
    settledEmptyKey = null;
    return;
  }
  if (completedEmpty) {
    sessionReport = next ? { key, report: next } : null;
    if (lastGood?.root === root) lastGood = null;
    settledEmptyKey = key;
  }
}

const forgottenByScan = new Map<string, string[]>();

function noteForgotten(scanKey: string, paths: string[]): void {
  const prev = forgottenByScan.get(scanKey) ?? [];
  const seen = new Set(prev.map((path) => path.replace(/[\\/]+$/, "").toLowerCase()));
  const next = [...prev];
  for (const path of paths) {
    const key = path.replace(/[\\/]+$/, "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(path);
  }
  forgottenByScan.set(scanKey, next);
}

function overlayForgotten(report: DevArtifactReport, scanKey: string): DevArtifactReport {
  return dropArtifactsFromReport(report, forgottenByScan.get(scanKey) ?? []);
}

type DeleteProgress = {
  index: number;
  total: number;
  treePath: string;
  path: string;
  size: number;
  deletedBytes: number;
  totalBytes: number;
  filesWalked: number;
  startedAt: number;
};

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function permanentDeleteConfirm(label: string, trees: number, bytes: number, freesBytes: number | null): string {
  // APFS clone accounting: say up front when most of the selection is
  // clone copies, instead of promising the full size. Conservative when
  // the selection holds both sides of a clone (see summarizeDevSharing),
  // so the wording doesn't claim the other copy stays.
  const frees = freesBytes !== null && freesBytes < bytes * 0.9
    ? `\nFrees ≈ ${formatBytes(freesBytes)} — the rest is APFS clone copies; their blocks come back only when every copy is gone.\n`
    : "";
  return (
    `${label}\n\n` +
    `${formatCount(trees)} trees · ${formatBytes(bytes)}\n${frees}\n` +
    `This permanently deletes the trees from disk. It cannot be undone and does not go to the Recycle Bin. Protected folders are skipped.`
  );
}

/** Tooltip for a row's "Shared" badge / "frees ≈" line. */
function sharingTitle(sharing: DevArtifactSharing, size: number): string {
  if (!sharing.measured) {
    return `${sharing.hint?.detail ?? ""} Rescan the drive on macOS to measure it.`.trim();
  }
  const lines: string[] = [];
  if (sharing.sharedBytes > 0) {
    const others = sharing.sharedRoots > 0
      ? `${formatCount(sharing.sharedRoots)} other tree${sharing.sharedRoots === 1 ? "" : "s"}`
      : "files outside the Dev list";
    lines.push(
      `${formatBytes(sharing.sharedBytes)} of this ${formatBytes(size)} tree is APFS-cloned with ${others}; only deleting every copy frees those blocks.`,
    );
  }
  // Clones of each other inside the tree (Cargo's deps/ vs. final
  // binaries, for example): counted per copy in `size`, freed once.
  const internalDup = Math.max(0, size - (sharing.freesBytes ?? size) - sharing.sharedBytes);
  if (internalDup >= 1024 * 1024) {
    lines.push(
      `${formatBytes(internalDup)} is counted more than once because files inside this tree are APFS clones of each other.`,
    );
  }
  lines.push(`Deleting this tree frees ≈ ${formatBytes(sharing.freesBytes ?? 0)} once no local snapshot holds it.`);
  if (sharing.sharedWith.length > 0) {
    lines.push(`\nShares blocks with:\n${sharing.sharedWith.map((p) => `  ${p}`).join("\n")}`);
  }
  return lines.join(" ");
}

function seedViewState(
  root: string | null,
  finishedAt: number | null,
  status: ScanSnapshot["status"],
) {
  return seedDevViewState(root, finishedAt, status, sessionReport, lastGood, settledEmptyKey);
}

function truncatePath(path: string, max = 56): string {
  if (path.length <= max) return path;
  return `…${path.slice(-(max - 1))}`;
}

export function DevView({ snapshot, onStartScan, otherScannedRoots = [] }: Props) {
  const root = snapshot.rootPath;
  const key = reportKey(root, snapshot.finishedAt);
  const [boot] = useState(() => seedViewState(root, snapshot.finishedAt, snapshot.status));
  const [heldKey, setHeldKey] = useState(key);
  const [report, setReport] = useState<DevArtifactReport | null>(boot.report);
  const [loading, setLoading] = useState(boot.loading);
  const [settled, setSettled] = useState(boot.settled);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingStartedAt, setLoadingStartedAt] = useState<number | null>(boot.startedAt);
  const [loadingElapsedSec, setLoadingElapsedSec] = useState(() => (
    boot.startedAt ? Math.floor((Date.now() - boot.startedAt) / 1000) : 0
  ));
  const [groupBy, setGroupBy] = useState<DevGroupBy>("all");
  const [sortBy, setSortBy] = useState<DevSortBy>("size");
  const [kindFilter, setKindFilter] = useState<DevArtifactKind | "all">("all");
  const [busyPaths, setBusyPaths] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<DeleteProgress | null>(null);
  const [deleteElapsedSec, setDeleteElapsedSec] = useState(0);
  const [rescanning, setRescanning] = useState(false);
  const [rescanProgress, setRescanProgress] = useState<DevArtifactsRescanProgress | null>(null);
  const [loadPath, setLoadPath] = useState<"sidecar" | "folder-tree">("sidecar");
  const [storageReport, setStorageReport] = useState<StorageAccountingReport | null>(null);
  const rescanningRef = useRef(false);
  const rescanGenRef = useRef(0);
  const loadGenRef = useRef(0);

  if (heldKey !== key) {
    setHeldKey(key);
    const next = seedViewState(root, snapshot.finishedAt, snapshot.status);
    setReport(next.report ? overlayForgotten(next.report, key) : next.report);
    setLoading(next.loading);
    setSettled(next.settled);
    setLoadError(null);
    setLoadingStartedAt(next.startedAt);
    setLoadingElapsedSec(next.startedAt ? Math.floor((Date.now() - next.startedAt) / 1000) : 0);
  }

  const load = useCallback(async () => {
    if (!root) {
      setReport(null);
      setSettled(true);
      return;
    }
    const loadKey = reportKey(root, snapshot.finishedAt);
    const gen = ++loadGenRef.current;
    if (sessionReport?.key === loadKey && isUsefulDevReport(sessionReport.report)) {
      setReport(overlayForgotten(sessionReport.report, loadKey));
      setLoadError(null);
      setLoading(false);
      setSettled(true);
      // Cheap sidecar reread — keep last-good on screen unless the
      // reread returns a useful replacement. Empty/null must not wipe it.
      void nativeApi.getDevArtifacts(root, { sidecarOnly: true }).then((fast) => {
        if (gen !== loadGenRef.current) return;
        if (!isUsefulDevReport(fast)) return;
        const adopted = overlayForgotten(fast, loadKey);
        setReport(adopted);
        rememberReport(root, loadKey, adopted, adopted.artifacts.length === 0);
      }).catch(() => {
        /* keep the session report */
      });
      return;
    }
    if (lastGood?.root === root && isUsefulDevReport(lastGood.report)) {
      setReport(overlayForgotten(lastGood.report, loadKey));
    }
    setLoading(true);
    setSettled(false);
    setLoadError(null);
    if (sessionLoadStarted?.key !== loadKey) sessionLoadStarted = { key: loadKey, at: Date.now() };
    setLoadingStartedAt(sessionLoadStarted.at);
    setLoadingElapsedSec(Math.floor((Date.now() - sessionLoadStarted.at) / 1000));
    setLoadPath("sidecar");
    try {
      const fast = await nativeApi.getDevArtifacts(root, { sidecarOnly: true });
      if (gen !== loadGenRef.current) return;
      if (isUsefulDevReport(fast)) {
        const adopted = overlayForgotten(fast, loadKey);
        setReport(adopted);
        rememberReport(root, loadKey, adopted, adopted.artifacts.length === 0);
        sessionLoadStarted = null;
        setSettled(true);
        return;
      }
      setLoadPath("folder-tree");
      const next = await nativeApi.getDevArtifacts(root);
      if (gen !== loadGenRef.current) return;
      if (isUsefulDevReport(next)) {
        const adopted = overlayForgotten(next, loadKey);
        setReport(adopted);
        rememberReport(root, loadKey, adopted, adopted.artifacts.length === 0);
        sessionLoadStarted = null;
        setSettled(true);
        return;
      }
      const adopted = next ? overlayForgotten(next, loadKey) : next;
      rememberReport(root, loadKey, adopted, true);
      setReport(adopted);
      setSettled(true);
      if (!next) {
        setLoadError(
          `No Dev Artifacts sidecar for ${formatScanRoot(root)}. Run a full scan of this drive, or open Folders first on an older scan so DiskHound can classify from the folder tree.`,
        );
      }
    } catch (err) {
      if (gen !== loadGenRef.current) return;
      if (!(lastGood?.root === root && isUsefulDevReport(lastGood.report))) {
        setReport(null);
      }
      setLoadError(err instanceof Error ? err.message : String(err));
      setSettled(true);
    } finally {
      if (gen !== loadGenRef.current) return;
      setLoading(false);
      setLoadingStartedAt(null);
    }
  }, [root, snapshot.finishedAt]);

  useEffect(() => {
    if (snapshot.status !== "done") return;
    if (rescanningRef.current) {
      if (!root) return;
      const scanRoot = root;
      void (async () => {
        const next = await nativeApi.getDevArtifacts(scanRoot, { sidecarOnly: true });
        if (!next || next.artifacts.length === 0 || !rescanningRef.current) return;
        rescanGenRef.current += 1;
        await nativeApi.cancelDevArtifactsRescan(scanRoot);
        const scanKey = reportKey(scanRoot, snapshot.finishedAt);
        const adopted = overlayForgotten(next, scanKey);
        setReport(adopted);
        rememberReport(scanRoot, scanKey, adopted, adopted.artifacts.length === 0);
        sessionLoadStarted = null;
        rescanningRef.current = false;
        setRescanning(false);
        setRescanProgress(null);
        setLoading(false);
        setSettled(true);
        setLoadingStartedAt(null);
        toast("info", "Scan finished", "Using the new sidecar for this drive.");
      })();
      return;
    }
    void load();
  }, [load, snapshot.status, root, snapshot.finishedAt]);

  useEffect(() => {
    if (!loadingStartedAt) return;
    const id = window.setInterval(() => {
      setLoadingElapsedSec(Math.floor((Date.now() - loadingStartedAt) / 1000));
    }, 500);
    return () => window.clearInterval(id);
  }, [loadingStartedAt]);

  useEffect(() => {
    return nativeApi.onDevArtifactsProgress((progress) => {
      if (progress.rootPath !== root) return;
      setRescanProgress(progress);
    });
  }, [root]);

  useEffect(() => {
    return nativeApi.onPermanentDeleteProgress((progress) => {
      setDeleteProgress((prev) => {
        if (!prev) return prev;
        if (normPath(progress.rootPath) !== normPath(prev.treePath)) return prev;
        return {
          ...prev,
          path: progress.path,
          filesWalked: progress.filesWalked,
        };
      });
    });
  }, []);

  const deleteStartedAt = deleteProgress?.startedAt ?? null;
  useEffect(() => {
    if (deleteStartedAt == null) {
      setDeleteElapsedSec(0);
      return;
    }
    setDeleteElapsedSec(Math.floor((Date.now() - deleteStartedAt) / 1000));
    const id = window.setInterval(() => {
      setDeleteElapsedSec(Math.floor((Date.now() - deleteStartedAt) / 1000));
    }, 250);
    return () => window.clearInterval(id);
  }, [deleteStartedAt]);

  const displayReport = useMemo(() => {
    if (report) return mergeDiagLogHotspots(report, snapshot.hottestDirectories ?? []);
    if (settled && root) {
      return mergeDiagLogHotspots(emptyDevReport(root), snapshot.hottestDirectories ?? []);
    }
    return null;
  }, [report, settled, root, snapshot.hottestDirectories]);

  const remaining = useMemo(() => displayReport?.artifacts ?? [], [displayReport]);

  const paint = resolveDevPaint({
    report: remaining.length > 0 ? (displayReport ?? report) : report,
    remainingCount: remaining.length,
    loading,
    settled,
    loadError,
  });

  const rows = useMemo(() => {
    return kindFilter === "all"
      ? remaining
      : remaining.filter((a) => a.kind === kindFilter);
  }, [remaining, kindFilter]);

  const summary = useMemo(() => ({
    totalBytes: remaining.reduce((sum, a) => sum + a.size, 0),
    trees: remaining.length,
    totalFiles: remaining.reduce((sum, a) => sum + a.fileCount, 0),
    projectCount: new Set(remaining.map((a) => a.projectPath).filter(Boolean)).size,
  }), [remaining]);
  const sharingSummary = useMemo(() => summarizeDevSharing(remaining), [remaining]);

  // Local snapshots (macOS) for the note above the list: deleting any of
  // these trees frees nothing until the snapshot holding them expires.
  useEffect(() => {
    if (nativeApi.platform !== "darwin" || !root) {
      setStorageReport(null);
      return;
    }
    let cancelled = false;
    const load = (fresh = false) => {
      void nativeApi.getStorageAccounting(root, { fresh }).then((next) => {
        if (!cancelled) setStorageReport(next);
      }).catch(() => { /* keep last */ });
    };
    load();
    const onStale = () => load(true);
    window.addEventListener(STORAGE_ACCOUNTING_STALE_EVENT, onStale);
    return () => {
      cancelled = true;
      window.removeEventListener(STORAGE_ACCOUNTING_STALE_EVENT, onStale);
    };
  }, [root]);
  const devSnapshots = userDataSnapshots(storageReport);
  const newestSnapshotAt = devSnapshots.find((s) => s.createdAt !== null)?.createdAt ?? null;
  const showSharedNote = sharingSummary.measuredTrees > 0
    && sharingSummary.sharedBytes >= Math.max(64 * 1024 * 1024, summary.totalBytes * 0.02);

  const kindTotals = useMemo(() => {
    const map = new Map<DevArtifactKind, { size: number; count: number }>();
    for (const artifact of remaining) {
      const entry = map.get(artifact.kind) ?? { size: 0, count: 0 };
      entry.size += artifact.size;
      entry.count += 1;
      map.set(artifact.kind, entry);
    }
    return [...map.entries()]
      .map(([kind, stats]) => ({ kind, size: stats.size, count: stats.count }))
      .sort((a, b) => b.size - a.size);
  }, [remaining]);

  const reportHasChangeData = useMemo(() => hasDevChangeData(remaining), [remaining]);
  const filterHasIncrease = useMemo(() => hasDevChangeData(rows), [rows]);
  const listSort = effectiveDevSort(sortBy, filterHasIncrease);
  const groups = useMemo(() => groupDevArtifacts(rows, groupBy, listSort), [rows, groupBy, listSort]);

  const selectedVisible = useMemo(
    () => rows.filter((a) => selected.has(a.path)),
    [rows, selected],
  );
  const selectedBytes = selectedVisible.reduce((sum, a) => sum + a.size, 0);
  const allVisibleSelected = rows.length > 0 && rows.every((a) => selected.has(a.path));

  const toggleOne = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const row of rows) next.delete(row.path);
      } else {
        for (const row of rows) next.add(row.path);
      }
      return next;
    });
  };

  const toggleGroup = (artifacts: DevArtifact[]) => {
    const allOn = artifacts.every((a) => selected.has(a.path));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const a of artifacts) {
        if (allOn) next.delete(a.path);
        else next.add(a.path);
      }
      return next;
    });
  };

  const clearSelection = () => {
    setSelected(new Set());
  };

  const deleteMany = async (paths: string[], label: string) => {
    if (paths.length === 0 || !root) return;
    const targets = artifactsAtPaths(remaining, paths);
    if (targets.length === 0) return;
    const totalBytes = targets.reduce((sum, artifact) => sum + artifact.size, 0);
    const targetSharing = summarizeDevSharing(targets);
    const ok = window.confirm(permanentDeleteConfirm(
      label,
      targets.length,
      totalBytes,
      targetSharing.measuredTrees > 0 ? targetSharing.freesBytes : null,
    ));
    if (!ok) return;
    // Did free space actually move? (macOS; see freedSpaceCheck.ts)
    const freeBefore = freedSpaceCheckEnabled(totalBytes) ? await captureFreeBytes(root) : null;
    let deletedSharedBytes = 0;
    let deletedMeasured = false;
    setBulkBusy(true);
    let succeeded = 0;
    let failed = 0;
    let deletedBytes = 0;
    let askedElevate = false;
    let elevateRemaining = false;
    const scanKey = reportKey(root, snapshot.finishedAt);
    let live = report;
    const startedAt = Date.now();
    try {
      for (let i = 0; i < targets.length; i++) {
        const artifact = targets[i]!;
        setDeleteProgress({
          index: i + 1,
          total: targets.length,
          treePath: artifact.path,
          path: artifact.path,
          size: artifact.size,
          deletedBytes,
          totalBytes,
          filesWalked: 0,
          startedAt,
        });
        setBusyPaths((prev) => new Set(prev).add(artifact.path));
        await yieldToUi();
        try {
          let result = await nativeApi.permanentlyDeletePath(artifact.path);
          if (result?.requiresElevation) {
            if (!askedElevate) {
              askedElevate = true;
              elevateRemaining = window.confirm(
                `${artifact.path}\n\n` +
                `Admin rights needed to delete this tree. Windows will show a UAC prompt for this tree and any later trees that need admin.\n\n` +
                `The files are permanently deleted — they do not go to the Recycle Bin.\n\nContinue?`,
              );
            }
            if (!elevateRemaining) {
              failed += 1;
              toast("error", "Could not delete", "Needs admin — not deleted.");
              continue;
            }
            result = await nativeApi.permanentlyDeletePathElevated(artifact.path);
          }
          if (!result?.ok) {
            failed += 1;
            toast("error", "Could not delete", result?.message ?? artifact.path);
            continue;
          }
          succeeded += 1;
          deletedBytes += artifact.size;
          // Everything the row said would not come back: clone blocks
          // shared outside the tree plus extra copies inside it.
          const deletedSharing = devArtifactSharing(artifact);
          if (deletedSharing.freesBytes !== null) {
            deletedSharedBytes += Math.max(0, artifact.size - deletedSharing.freesBytes);
          }
          deletedMeasured ||= deletedSharing.measured;
          noteForgotten(scanKey, [artifact.path]);
          live = overlayForgotten(dropArtifactsFromReport(live ?? emptyDevReport(root), [artifact.path]), scanKey);
          setReport(live);
          rememberReport(root, scanKey, live, live.artifacts.length === 0);
          setSelected((prev) => {
            const next = new Set(prev);
            next.delete(artifact.path);
            return next;
          });
          const persisted = await nativeApi.forgetDevArtifactPaths(root, [artifact.path]);
          if (persisted) {
            live = overlayForgotten(persisted, scanKey);
            setReport(live);
            rememberReport(root, scanKey, live, live.artifacts.length === 0);
          }
          dispatchDevArtifactsUpdated(root);
        } finally {
          setBusyPaths((prev) => {
            const next = new Set(prev);
            next.delete(artifact.path);
            return next;
          });
        }
      }
      if (succeeded > 0) {
        toast(
          "success",
          `Permanently deleted ${formatCount(succeeded)} tree${succeeded === 1 ? "" : "s"}`,
          "This cannot be undone.",
        );
        if (freeBefore !== null) {
          void checkFreedSpace({
            path: root,
            expectedBytes: deletedBytes,
            freeBefore,
            sharedBytes: deletedMeasured ? deletedSharedBytes : undefined,
          });
        }
      }
      if (failed > 0 && succeeded === 0) {
        toast("error", "Nothing was deleted", `${failed} failed`);
      }
    } finally {
      setBulkBusy(false);
      setDeleteProgress(null);
    }
  };

  const deleteOne = async (path: string) => {
    await deleteMany([path], "Delete this tree permanently?");
  };

  const rescan = async () => {
    if (!root) return;
    const hadReport = Boolean(report);
    const gen = ++rescanGenRef.current;
    rescanningRef.current = true;
    setRescanning(true);
    setRescanProgress(null);
    if (!hadReport) setLoading(true);
    setLoadError(null);
    setLoadingStartedAt(Date.now());
    setLoadingElapsedSec(0);
    try {
      const next = await nativeApi.rescanDevArtifacts(root);
      if (gen !== rescanGenRef.current) return;
      if (isUsefulDevReport(next)) {
        const adopted = overlayForgotten(next, reportKey(root, snapshot.finishedAt));
        setReport(adopted);
        rememberReport(root, reportKey(root, snapshot.finishedAt), adopted, adopted.artifacts.length === 0);
        setSelected(new Set());
        setSettled(true);
        toast("success", "Dev artifacts refreshed from disk");
      } else if (next) {
        const adopted = overlayForgotten(next, reportKey(root, snapshot.finishedAt));
        rememberReport(root, reportKey(root, snapshot.finishedAt), adopted, true);
        setReport(adopted);
        setSelected(new Set());
        setSettled(true);
        toast("success", "Dev artifacts refreshed from disk");
      } else if (!hadReport) {
        setLoadError("Rescan failed. Try a full drive scan.");
      } else {
        toast("error", "Rescan failed", "Try a full drive scan.");
      }
    } catch (err) {
      if (gen !== rescanGenRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("aborted")) return;
      if (!hadReport) setLoadError(message);
      else toast("error", "Rescan failed", message);
    } finally {
      if (gen !== rescanGenRef.current) return;
      rescanningRef.current = false;
      setRescanning(false);
      setRescanProgress(null);
      setLoading(false);
      setLoadingStartedAt(null);
    }
  };

  const rootLabel = root ? formatScanRoot(root) : null;
  const otherDriveNote = otherScannedRoots.length > 0
    ? "A finished scan is on another drive. Switch with the header drive pills."
    : null;
  const scanButton = rootLabel && onStartScan && snapshot.status !== "running" ? (
    <button className="action-btn primary" onClick={onStartScan}>
      Scan {rootLabel}
    </button>
  ) : null;

  if (!root) {
    return (
      <div className="dev-view">
        <div className="empty-view">
          <span>Scan a drive to find worktrees, node_modules, Rust targets, and RDP/diag traces.</span>
          <span className="empty-view-sub">
            {otherDriveNote ?? "Pick a drive in the header. Dev Artifacts follows that drive, not the whole PC."}
          </span>
        </div>
      </div>
    );
  }

  if (snapshot.status === "idle") {
    return (
      <div className="dev-view">
        <div className="empty-view">
          <span className="scan-root-chip">{rootLabel}</span>
          <span>Dev Artifacts needs a full scan of {rootLabel} — not the whole PC.</span>
          <span className="empty-view-sub">
            {otherDriveNote ?? "This tab only binds the selected drive. History on another drive stays on that pill."}
          </span>
          {scanButton}
        </div>
      </div>
    );
  }

  if (snapshot.status === "running" && !report) {
    return (
      <div className="dev-view">
        <div className="empty-view">
          <span className="scan-root-chip">{rootLabel}</span>
          <span>Scanning this drive…</span>
          <span className="empty-view-sub">Dev Artifacts for this drive will be ready when the scan finishes.</span>
        </div>
      </div>
    );
  }

  if (paint === "loading") {
    return (
      <div className="dev-view">
        <IndexLoadingPanel
          eyebrow={rootLabel ?? undefined}
          title={rescanning ? "Refreshing artifact trees on this scan" : "Reading developer artifacts on this scan"}
          stages={rescanning
            ? (rescanProgress
              ? [{ afterSec: 0, label: `Walking ${formatCount(rescanProgress.treesWalked)} of ${formatCount(rescanProgress.treesTotal)} trees… ${truncatePath(rescanProgress.currentPath)}` }]
              : DEV_RESCAN_STAGES)
            : loadPath === "folder-tree" ? DEV_FOLDER_TREE_STAGES : DEV_SIDECAR_STAGES}
          elapsedSec={loadingElapsedSec}
        />
      </div>
    );
  }

  if (paint === "error") {
    return (
      <div className="dev-view">
        <div className="empty-view">
          <span className="scan-root-chip">{rootLabel}</span>
          <span>{loadError}</span>
          <span className="empty-view-sub">
            {otherDriveNote ?? "This tab follows the selected drive. Scan this drive, or switch with the header pills."}
          </span>
          {scanButton}
          <button className="action-btn" onClick={() => void load()}>Retry</button>
        </div>
      </div>
    );
  }

  if (paint === "empty") {
    return (
      <div className="dev-view">
        <div className="empty-view">
          <span className="scan-root-chip">{rootLabel}</span>
          <span>No developer artifacts left on this scan.</span>
          <span className="empty-view-sub">Looks for worktrees, package trees, Rust targets, venvs, compiler caches, and DiagOutputDir RDP traces on this scan. Switch drives in the header to see another root.</span>
          {report ? (
            <button
              className="action-btn"
              disabled={rescanning}
              onClick={() => void rescan()}
              title="Re-walk known artifact trees on disk. Does not scan the whole drive."
            >
              Rescan trees
            </button>
          ) : (
            <button className="action-btn" onClick={() => void load()}>Retry</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="dev-view">
      <div className="dev-summary">
        <div className="dev-summary-net">
          <span className="scan-root-chip" title={root}>{rootLabel}</span>
          <span className="changes-delta-big">{formatBytes(summary.totalBytes)}</span>
          <span className="changes-delta-label">reclaimable on this scan</span>
        </div>
        <div className="changes-summary-stats">
          <div className="summary-item">
            <div className="summary-item-label">Projects</div>
            <div className="summary-item-value">{formatCount(summary.projectCount)}</div>
          </div>
          <div className="summary-item">
            <div className="summary-item-label">Trees</div>
            <div className="summary-item-value">{formatCount(summary.trees)}</div>
          </div>
          <div className="summary-item">
            <div className="summary-item-label">Files</div>
            <div className="summary-item-value">{formatCount(summary.totalFiles)}</div>
          </div>
        </div>
        <div className="dev-summary-actions">
          <button
            className="action-btn"
            disabled={bulkBusy || rescanning}
            onClick={() => void rescan()}
            title="Re-walk known artifact trees on disk. Does not scan the whole drive."
          >
            Rescan trees
          </button>
        </div>
      </div>

      {(showSharedNote || devSnapshots.length > 0) && (
        <div className="dev-sharing-note" role="note">
          {showSharedNote && (
            <div>
              <strong>{formatBytes(sharingSummary.sharedBytes)}</strong> of these trees is APFS-cloned with
              files elsewhere, so deleting a tree frees only its own blocks — about{" "}
              <strong>{formatBytes(sharingSummary.freesBytes)}</strong> if you deleted everything listed.
              Rows marked <span className="dev-share-badge">Shared</span> say with what.
            </div>
          )}
          {devSnapshots.length > 0 && (
            <div>
              {devSnapshots.length === 1 ? "A local snapshot" : `${formatCount(devSnapshots.length)} local snapshots`}
              {newestSnapshotAt ? ` (newest ${relativeTime(newestSnapshotAt)})` : ""}
              {devSnapshots.length === 1 ? " still references" : " still reference"} files that existed when
              {devSnapshots.length === 1 ? " it was" : " they were"} taken. Space from deleting them comes back when
              the snapshot expires — usually within 24 hours. See Overview for how to thin snapshots now.
            </div>
          )}
        </div>
      )}

      {kindTotals.length > 0 && (
        <KindTape
          totals={kindTotals}
          totalBytes={summary.totalBytes}
          kindFilter={kindFilter}
          onFilter={setKindFilter}
        />
      )}

      {deleteProgress && (
        <div className="dev-rescan-banner" role="status" aria-live="polite">
          <div>
            Deleting {formatBytes(inFlightDeleteBytes(deleteProgress.deletedBytes, deleteProgress.size))}…
            {` · ${formatCount(deleteProgress.index)} of ${formatCount(deleteProgress.total)}`}
          </div>
          <div className="dev-rescan-banner-detail">
            {truncatePath(deleteProgress.path)}
            {deleteProgress.filesWalked > 0
              ? ` · ${formatCount(deleteProgress.filesWalked)} files`
              : ` · ${formatBytes(deleteProgress.size)}`}
            {` · ${deleteElapsedSec}s`}
          </div>
        </div>
      )}
      {rescanning && (
        <div className="dev-rescan-banner" role="status" aria-live="polite">
          {rescanProgress
            ? (
              <>
                <div>
                  Walking {formatCount(rescanProgress.treesWalked)} of {formatCount(rescanProgress.treesTotal)} trees on this scan
                </div>
                <div className="dev-rescan-banner-detail">
                  {truncatePath(rescanProgress.currentPath)}
                  {` · ${formatCount(rescanProgress.filesSoFar)} files · ${formatBytes(rescanProgress.bytesSoFar)} · ${loadingElapsedSec}s`}
                </div>
              </>
            )
            : (
              <>
                Walking {formatCount(summary.trees)} trees on this scan…
                {` ${loadingElapsedSec}s`}
              </>
            )}
        </div>
      )}
      <div className="dev-toolbar">
        <div className="dev-toolbar-cluster">
          <span className="dev-toolbar-label" id="dev-group-by-label">Group</span>
          <div className="chip-group" role="radiogroup" aria-labelledby="dev-group-by-label">
            <button
              type="button"
              role="radio"
              aria-checked={groupBy === "all"}
              className={`chip ${groupBy === "all" ? "active" : ""}`}
              onClick={() => setGroupBy("all")}
            >
              All
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={groupBy === "kind"}
              className={`chip ${groupBy === "kind" ? "active" : ""}`}
              onClick={() => setGroupBy("kind")}
            >
              By kind
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={groupBy === "project"}
              className={`chip ${groupBy === "project" ? "active" : ""}`}
              onClick={() => setGroupBy("project")}
            >
              By project
            </button>
          </div>
        </div>
        {reportHasChangeData && (
          <div className="dev-toolbar-cluster">
            <span className="dev-toolbar-label" id="dev-sort-by-label">Sort</span>
            <div className="chip-group" role="radiogroup" aria-labelledby="dev-sort-by-label">
              <button
                type="button"
                role="radio"
                aria-checked={listSort === "size"}
                className={`chip ${listSort === "size" ? "active" : ""}`}
                onClick={() => setSortBy("size")}
              >
                Largest
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={sortBy === "increase" && filterHasIncrease}
                aria-label={filterHasIncrease
                  ? "Largest increase"
                  : "Largest increase, unavailable. No since-last-scan change for this kind"}
                className={`chip ${sortBy === "increase" && filterHasIncrease ? "active" : ""}`}
                disabled={!filterHasIncrease}
                title={filterHasIncrease ? undefined : "No since-last-scan change for this kind"}
                onClick={() => setSortBy("increase")}
              >
                Largest increase
              </button>
            </div>
          </div>
        )}
      </div>

      <div
        className={`dev-select-bar ${selectedVisible.length > 0 ? "is-active" : ""}`}
        role="toolbar"
        aria-label={selectedVisible.length > 0 ? "Selected trees" : "Tree selection"}
      >
        {selectedVisible.length > 0 ? (
          <>
            <span className="dev-select-bar-tally">
              {formatCount(selectedVisible.length)} · {formatBytes(selectedBytes)}
            </span>
            <button
              type="button"
              className="dev-select-bar-delete"
              disabled={bulkBusy}
              title="Permanently delete selected trees. Cannot be undone. Not Recycle Bin."
              onClick={() => void deleteMany(selectedVisible.map((a) => a.path), "Delete selected trees permanently?")}
            >
              Delete selected
            </button>
            <button
              type="button"
              className="dev-select-bar-ghost"
              disabled={bulkBusy}
              onClick={clearSelection}
            >
              Clear
            </button>
            <span className="dev-select-bar-spacer" />
            <button
              type="button"
              className="dev-select-bar-ghost"
              disabled={rows.length === 0 || bulkBusy}
              onClick={toggleVisible}
            >
              {allVisibleSelected ? "Clear visible" : "Select visible"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="dev-select-bar-ghost"
              disabled={rows.length === 0 || bulkBusy}
              onClick={toggleVisible}
            >
              Select visible
            </button>
            <span className="dev-select-bar-spacer" />
            <button
              type="button"
              className="dev-select-bar-quiet"
              disabled={remaining.length === 0 || bulkBusy}
              title="Permanently delete every listed tree. Cannot be undone. Not Recycle Bin."
              onClick={() => void deleteMany(remaining.map((a) => a.path), "Delete all listed developer trees permanently?")}
            >
              Delete all
            </button>
          </>
        )}
      </div>

      <div className="dev-list">
        {groups.map((group) => {
          const groupAll = group.artifacts.every((a) => selected.has(a.path));
          const groupKind = groupBy === "kind" ? group.artifacts[0]?.kind : undefined;
          const flat = groupBy === "all";
          return (
            <section key={group.key} className="dev-group">
              {!flat && (
              <header className="dev-group-header">
                <label className="dev-group-select">
                  <input
                    type="checkbox"
                    className="dev-check"
                    checked={groupAll}
                    onChange={() => toggleGroup(group.artifacts)}
                  />
                  {groupKind ? (
                    <span className="dev-row-pip" style={{ background: devKindCssVar(groupKind) }} aria-hidden="true" />
                  ) : null}
                  <span className="dev-group-title">{group.label}</span>
                </label>
                <span className="dev-group-size">{formatBytes(group.size)}</span>
              </header>
              )}
              {group.artifacts.map((artifact) => {
                const sharing = devArtifactSharing(artifact);
                const shared = isMeaningfullyShared(sharing, artifact.size);
                const freesLess = sharing.freesBytes !== null && sharing.freesBytes < artifact.size * 0.9;
                return (
                <div
                  key={artifact.path}
                  className={`dev-row ${selected.has(artifact.path) ? "selected" : ""} ${busyPaths.has(artifact.path) ? "is-busy" : ""}`}
                >
                  <label className="dev-row-check">
                    <input
                      type="checkbox"
                      className="dev-check"
                      checked={selected.has(artifact.path)}
                      disabled={busyPaths.has(artifact.path)}
                      onChange={() => toggleOne(artifact.path)}
                    />
                  </label>
                  <span className="dev-row-pip" style={{ background: devKindCssVar(artifact.kind) }} aria-hidden="true" />
                  <div className="dev-row-main">
                    <div className="dev-row-name" title={artifact.path}>{artifactHeadline(artifact)}</div>
                    <div className="dev-row-meta">
                      <span className="dev-row-tail" title={artifact.path}>{artifactTail(artifact)}</span>
                      {groupBy !== "kind" ? ` · ${DEV_KIND_SHORT[artifact.kind]}` : ""}
                      {` · ${formatCount(artifact.fileCount)} files`}
                      {artifact.deltaBytes != null && artifact.deltaBytes !== 0 ? (
                        <span className={artifact.deltaBytes > 0 ? "dev-delta-up" : "dev-delta-down"}>
                          {` · ${artifact.deltaBytes > 0 ? "+" : ""}${formatBytes(artifact.deltaBytes)} since last scan`}
                        </span>
                      ) : null}
                      {shared && (
                        <>
                          {" · "}
                          <span
                            className={`dev-share-badge ${sharing.measured ? "" : "likely"}`}
                            title={sharingTitle(sharing, artifact.size)}
                          >
                            {!sharing.measured
                              ? "Likely shared"
                              : sharing.sharedRoots > 0
                                ? `Shared with ${formatCount(sharing.sharedRoots)} other tree${sharing.sharedRoots === 1 ? "" : "s"}`
                                : "Shared"}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="dev-row-size">
                    {formatBytes(artifact.size)}
                    {freesLess && (
                      <span className="dev-row-frees" title={sharingTitle(sharing, artifact.size)}>
                        frees ≈ {formatBytes(sharing.freesBytes!)}
                      </span>
                    )}
                  </div>
                  <div className="dev-row-actions">
                    <button className="action-btn" onClick={() => void nativeApi.revealPath(artifact.path)}>Reveal</button>
                    <button
                      className="action-btn warn"
                      disabled={bulkBusy || busyPaths.has(artifact.path)}
                      title="Permanently delete this tree. Cannot be undone. Not Recycle Bin."
                      onClick={() => void deleteOne(artifact.path)}
                    >
                      {busyPaths.has(artifact.path) ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </div>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function KindTape({
  totals,
  totalBytes,
  kindFilter,
  onFilter,
}: {
  totals: Array<{ kind: DevArtifactKind; size: number; count: number }>;
  totalBytes: number;
  kindFilter: DevArtifactKind | "all";
  onFilter: (kind: DevArtifactKind | "all") => void;
}) {
  const toggle = (kind: DevArtifactKind) => {
    onFilter(kindFilter === kind ? "all" : kind);
  };
  const filtered = kindFilter !== "all";
  return (
    <div className="dev-tape">
      <div
        className={`dev-spectrum ${filtered ? "is-filtered" : ""}`}
        role="list"
        aria-label="Reclaimable bytes by kind"
      >
        {totals.map((entry) => (
          <button
            key={entry.kind}
            type="button"
            role="listitem"
            className={`dev-spectrum-seg ${kindFilter === entry.kind ? "active" : ""}`}
            style={{
              flexGrow: Math.max(entry.size, 1),
              background: devKindCssVar(entry.kind),
            }}
            title={`${DEV_KIND_LABEL[entry.kind]} · ${formatBytes(entry.size)}`}
            onClick={() => toggle(entry.kind)}
          />
        ))}
      </div>
      <div
        className={`dev-kind-rail ${filtered ? "is-filtered" : ""}`}
        role="toolbar"
        aria-label="Filter by kind"
      >
        <button
          type="button"
          className={`dev-kind-cell dev-kind-cell-all ${kindFilter === "all" ? "active" : ""}`}
          aria-pressed={kindFilter === "all"}
          title="Show every kind"
          onClick={() => onFilter("all")}
        >
          <span className="dev-kind-cell-label">All kinds</span>
          <span className="dev-kind-cell-size">{formatBytes(totalBytes)}</span>
        </button>
        {totals.map((entry) => {
          const share = totalBytes > 0 ? entry.size / totalBytes : 0;
          const selected = kindFilter === entry.kind;
          return (
            <button
              key={entry.kind}
              type="button"
              className={`dev-kind-cell ${selected ? "active" : ""}`}
              aria-pressed={selected}
              onClick={() => toggle(entry.kind)}
              title={DEV_KIND_LABEL[entry.kind]}
              style={{ "--cell-kind": devKindCssVar(entry.kind) }}
            >
              <span className="dev-kind-cell-top">
                <span className="dev-kind-swatch" aria-hidden="true" />
                <span className="dev-kind-cell-label">{DEV_KIND_SHORT[entry.kind]}</span>
                <span className="dev-kind-cell-size">{formatBytes(entry.size)}</span>
              </span>
              <span className="dev-kind-cell-bar" aria-hidden="true">
                <span className="dev-kind-cell-fill" style={{ width: `${Math.max(share * 100, 3)}%` }} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
