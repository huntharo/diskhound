import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { DevArtifact, DevArtifactKind, DevArtifactReport, DevArtifactsRescanProgress, ScanSnapshot } from "../../shared/contracts";
import { DEV_KIND_LABEL } from "../../shared/devArtifacts";
import { formatScanRoot } from "../../shared/pathUtils";
import { formatBytes, formatCount } from "../lib/format";
import { nativeApi } from "../nativeApi";
import { DEV_FOLDER_TREE_STAGES, DEV_RESCAN_STAGES, DEV_SIDECAR_STAGES, IndexLoadingPanel } from "./IndexLoadingPanel";
import { toast } from "./Toasts";

interface Props {
  snapshot: ScanSnapshot;
  onStartScan?: () => void;
  otherScannedRoots?: string[];
}

type GroupBy = "kind" | "project";

let sessionReport: { key: string; report: DevArtifactReport } | null = null;
let sessionLoadStarted: { key: string; at: number } | null = null;

function reportKey(root: string | null, finishedAt: number | null): string {
  return `${root ?? ""}|${finishedAt ?? 0}`;
}

/** First paint must not look like an empty sidecar. Show a cached
 *  report for this root+scan, or start on the loading panel. */
function seedViewState(
  root: string | null,
  finishedAt: number | null,
  status: ScanSnapshot["status"],
): { report: DevArtifactReport | null; loading: boolean; startedAt: number | null } {
  const key = reportKey(root, finishedAt);
  if (sessionReport?.key === key) {
    return { report: sessionReport.report, loading: false, startedAt: null };
  }
  if (status === "done" && root) {
    if (sessionLoadStarted?.key !== key) sessionLoadStarted = { key, at: Date.now() };
    return { report: null, loading: true, startedAt: sessionLoadStarted.at };
  }
  return { report: null, loading: false, startedAt: null };
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingStartedAt, setLoadingStartedAt] = useState<number | null>(boot.startedAt);
  const [loadingElapsedSec, setLoadingElapsedSec] = useState(() => (
    boot.startedAt ? Math.floor((Date.now() - boot.startedAt) / 1000) : 0
  ));
  const [groupBy, setGroupBy] = useState<GroupBy>("kind");
  const [kindFilter, setKindFilter] = useState<DevArtifactKind | "all">("all");
  const [busyPaths, setBusyPaths] = useState<Set<string>>(() => new Set());
  const [trashed, setTrashed] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [rescanProgress, setRescanProgress] = useState<DevArtifactsRescanProgress | null>(null);
  const [loadPath, setLoadPath] = useState<"sidecar" | "folder-tree">("sidecar");
  const rescanningRef = useRef(false);
  const rescanGenRef = useRef(0);
  const loadGenRef = useRef(0);

  if (heldKey !== key) {
    setHeldKey(key);
    const next = seedViewState(root, snapshot.finishedAt, snapshot.status);
    setReport(next.report);
    setLoading(next.loading);
    setLoadError(null);
    setLoadingStartedAt(next.startedAt);
    setLoadingElapsedSec(next.startedAt ? Math.floor((Date.now() - next.startedAt) / 1000) : 0);
  }

  const load = useCallback(async () => {
    if (!root) {
      setReport(null);
      return;
    }
    const loadKey = reportKey(root, snapshot.finishedAt);
    const gen = ++loadGenRef.current;
    if (sessionReport?.key === loadKey) {
      setReport(sessionReport.report);
      setLoadError(null);
      setLoading(false);
      // Cheap sidecar reread — keep the cached report on screen.
      void nativeApi.getDevArtifacts(root, { sidecarOnly: true }).then((fast) => {
        if (gen !== loadGenRef.current) return;
        if (!fast) return;
        setReport(fast);
        sessionReport = { key: loadKey, report: fast };
      }).catch(() => {
        /* keep the session report */
      });
      return;
    }
    setLoading(true);
    setLoadError(null);
    if (sessionLoadStarted?.key !== loadKey) sessionLoadStarted = { key: loadKey, at: Date.now() };
    setLoadingStartedAt(sessionLoadStarted.at);
    setLoadingElapsedSec(Math.floor((Date.now() - sessionLoadStarted.at) / 1000));
    setLoadPath("sidecar");
    try {
      const fast = await nativeApi.getDevArtifacts(root, { sidecarOnly: true });
      if (gen !== loadGenRef.current) return;
      if (fast) {
        setReport(fast);
        sessionReport = { key: loadKey, report: fast };
        sessionLoadStarted = null;
        return;
      }
      setLoadPath("folder-tree");
      const next = await nativeApi.getDevArtifacts(root);
      if (gen !== loadGenRef.current) return;
      setReport(next);
      if (next) {
        sessionReport = { key: loadKey, report: next };
        sessionLoadStarted = null;
      }
      if (!next) {
        setLoadError(
          `No Dev Artifacts sidecar for ${formatScanRoot(root)}. Run a full scan of this drive, or open Folders first on an older scan so DiskHound can classify from the folder tree.`,
        );
      }
    } catch (err) {
      if (gen !== loadGenRef.current) return;
      setReport(null);
      setLoadError(err instanceof Error ? err.message : String(err));
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
        setReport(next);
        sessionReport = { key: reportKey(scanRoot, snapshot.finishedAt), report: next };
        sessionLoadStarted = null;
        rescanningRef.current = false;
        setRescanning(false);
        setRescanProgress(null);
        setLoading(false);
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

  const remaining = useMemo(() => {
    if (!report) return [];
    return report.artifacts.filter((a) => !trashed.has(a.path));
  }, [report, trashed]);

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

  const groups = useMemo(() => {
    const map = new Map<string, DevArtifact[]>();
    for (const artifact of rows) {
      const key = groupBy === "kind" ? artifact.kind : (artifact.projectPath ?? "unscoped");
      const list = map.get(key) ?? [];
      list.push(artifact);
      map.set(key, list);
    }
    return [...map.entries()].map(([key, artifacts]) => ({
      key,
      label: groupBy === "kind"
        ? DEV_KIND_LABEL[key as DevArtifactKind]
        : (artifacts[0]?.projectName ?? "Unscoped"),
      size: artifacts.reduce((sum, a) => sum + a.size, 0),
      artifacts,
    })).sort((a, b) => b.size - a.size);
  }, [rows, groupBy]);

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

  const trashMany = async (paths: string[], label: string) => {
    if (paths.length === 0) return;
    const bytes = remaining.filter((a) => paths.includes(a.path)).reduce((sum, a) => sum + a.size, 0);
    const ok = window.confirm(
      `${label}\n\n${formatCount(paths.length)} trees · ${formatBytes(bytes)}\n\nMoved to the Recycle Bin. Protected folders are skipped.`,
    );
    if (!ok) return;
    setBulkBusy(true);
    let succeeded = 0;
    let failed = 0;
    const nextTrashed = new Set(trashed);
    try {
      for (const path of paths) {
        setBusyPaths((prev) => new Set(prev).add(path));
        try {
          const result = await nativeApi.trashPath(path);
          if (result?.ok) {
            nextTrashed.add(path);
            succeeded += 1;
          } else {
            failed += 1;
            toast("error", "Could not trash", result?.message ?? path);
          }
        } finally {
          setBusyPaths((prev) => {
            const n = new Set(prev);
            n.delete(path);
            return n;
          });
        }
      }
      setTrashed(nextTrashed);
      setSelected((prev) => {
        const n = new Set(prev);
        for (const path of nextTrashed) n.delete(path);
        return n;
      });
      if (succeeded > 0) {
        toast("success", `Moved ${formatCount(succeeded)} tree${succeeded === 1 ? "" : "s"} to trash`);
      }
      if (failed > 0 && succeeded === 0) {
        toast("error", "Nothing was trashed", `${failed} failed`);
      }
    } finally {
      setBulkBusy(false);
    }
  };

  const trashOne = async (path: string) => {
    await trashMany([path], "Move this tree to the trash?");
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
      if (next) {
        setReport(next);
        sessionReport = { key: reportKey(root, snapshot.finishedAt), report: next };
        setTrashed(new Set());
        setSelected(new Set());
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
          <span>Scan a drive to find worktrees, node_modules, Rust targets, and other developer bloat.</span>
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

  // First paint and Retry stay on this panel until a sidecar (or
  // folder-tree) read has finished. `!loadError` covers the gap before
  // useEffect starts the load so we never flash Scan C: / Retry.
  if (!report && snapshot.status === "done" && (loading || !loadError)) {
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

  if (loadError && !report) {
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

  if (!report || remaining.length === 0) {
    return (
      <div className="dev-view">
        <div className="empty-view">
          <span className="scan-root-chip">{rootLabel}</span>
          <span>No developer artifacts left on this scan.</span>
          <span className="empty-view-sub">DiskHound looks for worktrees, package trees, Rust targets, venvs, and compiler caches on this scan. Switch drives in the header to see another root.</span>
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
            disabled={rows.length === 0 || bulkBusy}
            onClick={toggleVisible}
          >
            {allVisibleSelected ? "Clear selection" : "Select visible"}
          </button>
          <button
            className="action-btn warn"
            disabled={selectedVisible.length === 0 || bulkBusy}
            onClick={() => void trashMany(selectedVisible.map((a) => a.path), "Trash selected trees?")}
          >
            {selectedVisible.length > 0
              ? `Trash selected (${formatCount(selectedVisible.length)} · ${formatBytes(selectedBytes)})`
              : "Trash selected"}
          </button>
          <button
            className="action-btn danger"
            disabled={remaining.length === 0 || bulkBusy}
            onClick={() => void trashMany(remaining.map((a) => a.path), "Trash all listed developer trees?")}
          >
            Trash all
          </button>
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
        <div className="chip-group" role="radiogroup" aria-label="Group by">
          <button className={`chip ${groupBy === "kind" ? "active" : ""}`} onClick={() => setGroupBy("kind")}>By kind</button>
          <button className={`chip ${groupBy === "project" ? "active" : ""}`} onClick={() => setGroupBy("project")}>By project</button>
        </div>
        <div className="chip-group">
          <button className={`chip ${kindFilter === "all" ? "active" : ""}`} onClick={() => setKindFilter("all")}>All</button>
          {kindTotals.slice(0, 6).map((entry) => (
            <button
              key={entry.kind}
              className={`chip ${kindFilter === entry.kind ? "active" : ""}`}
              onClick={() => setKindFilter(entry.kind)}
              title={formatBytes(entry.size)}
            >
              {DEV_KIND_LABEL[entry.kind]}
            </button>
          ))}
        </div>
      </div>

      <div className="dev-list">
        {groups.map((group) => {
          const groupAll = group.artifacts.every((a) => selected.has(a.path));
          return (
            <section key={group.key} className="dev-group">
              <header className="dev-group-header">
                <label className="dev-group-select">
                  <input
                    type="checkbox"
                    className="dev-check"
                    checked={groupAll}
                    onChange={() => toggleGroup(group.artifacts)}
                  />
                  <span className="dev-group-title">{group.label}</span>
                </label>
                <span className="dev-group-size">{formatBytes(group.size)}</span>
              </header>
              {group.artifacts.map((artifact) => (
                <div key={artifact.path} className={`dev-row ${selected.has(artifact.path) ? "selected" : ""}`}>
                  <label className="dev-row-check">
                    <input
                      type="checkbox"
                      className="dev-check"
                      checked={selected.has(artifact.path)}
                      onChange={() => toggleOne(artifact.path)}
                    />
                  </label>
                  <div className="dev-row-main">
                    <div className="dev-row-name" title={artifact.path}>{artifact.path}</div>
                    <div className="dev-row-meta">
                      {DEV_KIND_LABEL[artifact.kind]}
                      {artifact.projectName !== "Unscoped" ? ` · ${artifact.projectName}` : ""}
                      {` · ${formatCount(artifact.fileCount)} files`}
                      {artifact.deltaBytes != null && artifact.deltaBytes !== 0 ? (
                        <span className={artifact.deltaBytes > 0 ? "dev-delta-up" : "dev-delta-down"}>
                          {` · ${artifact.deltaBytes > 0 ? "+" : ""}${formatBytes(artifact.deltaBytes)} since last scan`}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="dev-row-size">{formatBytes(artifact.size)}</div>
                  <div className="dev-row-actions">
                    <button className="action-btn" onClick={() => void nativeApi.revealPath(artifact.path)}>Reveal</button>
                    <button
                      className="action-btn warn"
                      disabled={bulkBusy || busyPaths.has(artifact.path)}
                      onClick={() => void trashOne(artifact.path)}
                    >
                      Trash
                    </button>
                  </div>
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
