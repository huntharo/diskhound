import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

import type { DevArtifact, DevArtifactKind, DevArtifactReport, ScanSnapshot } from "../../shared/contracts";
import { DEV_KIND_LABEL } from "../../shared/devArtifacts";
import { formatBytes, formatCount } from "../lib/format";
import { nativeApi } from "../nativeApi";
import { DEV_LOADING_STAGES, DEV_RESCAN_STAGES, IndexLoadingPanel } from "./IndexLoadingPanel";
import { toast } from "./Toasts";

interface Props {
  snapshot: ScanSnapshot;
}

type GroupBy = "kind" | "project";

let sessionReport: { key: string; report: DevArtifactReport } | null = null;
let sessionLoadStarted: { key: string; at: number } | null = null;

function reportKey(root: string, finishedAt: number | null): string {
  return `${root}|${finishedAt ?? 0}`;
}

export function DevView({ snapshot }: Props) {
  const root = snapshot.rootPath;
  const [report, setReport] = useState<DevArtifactReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingStartedAt, setLoadingStartedAt] = useState<number | null>(null);
  const [loadingElapsedSec, setLoadingElapsedSec] = useState(0);
  const [groupBy, setGroupBy] = useState<GroupBy>("kind");
  const [kindFilter, setKindFilter] = useState<DevArtifactKind | "all">("all");
  const [busyPaths, setBusyPaths] = useState<Set<string>>(() => new Set());
  const [trashed, setTrashed] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [rescanning, setRescanning] = useState(false);

  const load = useCallback(async () => {
    if (!root) {
      setReport(null);
      return;
    }
    const key = reportKey(root, snapshot.finishedAt);
    if (sessionReport?.key === key) {
      setReport(sessionReport.report);
      setLoadError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    if (sessionLoadStarted?.key !== key) sessionLoadStarted = { key, at: Date.now() };
    setLoadingStartedAt(sessionLoadStarted.at);
    setLoadingElapsedSec(Math.floor((Date.now() - sessionLoadStarted.at) / 1000));
    try {
      const next = await nativeApi.getDevArtifacts(root);
      setReport(next);
      if (next) {
        sessionReport = { key, report: next };
        sessionLoadStarted = null;
      }
      if (!next) {
        setLoadError(
          "No Dev Artifacts sidecar for this scan. Run a full scan, or open Folders first on an older scan so DiskHound can classify from the folder tree.",
        );
      }
    } catch (err) {
      setReport(null);
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setLoadingStartedAt(null);
    }
  }, [root, snapshot.finishedAt]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!loadingStartedAt) return;
    const id = window.setInterval(() => {
      setLoadingElapsedSec(Math.floor((Date.now() - loadingStartedAt) / 1000));
    }, 500);
    return () => window.clearInterval(id);
  }, [loadingStartedAt]);

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
    setRescanning(true);
    if (!hadReport) setLoading(true);
    setLoadError(null);
    setLoadingStartedAt(Date.now());
    setLoadingElapsedSec(0);
    try {
      const next = await nativeApi.rescanDevArtifacts(root);
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
      const message = err instanceof Error ? err.message : String(err);
      if (!hadReport) setLoadError(message);
      else toast("error", "Rescan failed", message);
    } finally {
      setRescanning(false);
      setLoading(false);
      setLoadingStartedAt(null);
    }
  };

  if (!root || snapshot.status === "idle") {
    return (
      <div className="dev-view">
        <div className="empty-view">
          <span>Scan a drive to find worktrees, node_modules, Rust targets, and other developer bloat.</span>
        </div>
      </div>
    );
  }

  if (loading && !report) {
    return (
      <div className="dev-view">
        <IndexLoadingPanel
          title={rescanning ? "Refreshing artifact trees" : "Reading developer artifacts"}
          stages={rescanning ? DEV_RESCAN_STAGES : DEV_LOADING_STAGES}
          elapsedSec={loadingElapsedSec}
        />
      </div>
    );
  }

  if (loadError && !report) {
    return (
      <div className="dev-view">
        <div className="empty-view">
          <span>{loadError}</span>
          <button className="action-btn" onClick={() => void load()}>Retry</button>
        </div>
      </div>
    );
  }

  if (!report || remaining.length === 0) {
    return (
      <div className="dev-view">
        <div className="empty-view">
          <span>No developer artifacts left on this scan.</span>
          <span className="empty-view-sub">DiskHound looks for worktrees, package trees, Rust targets, venvs, and compiler caches.</span>
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
          <span className="changes-delta-big">{formatBytes(summary.totalBytes)}</span>
          <span className="changes-delta-label">reclaimable developer files</span>
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
        <div className="dev-rescan-banner">Refreshing artifact trees on disk… {loadingElapsedSec}s</div>
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
