import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

import type { DevArtifact, DevArtifactKind, DevArtifactReport, ScanSnapshot } from "../../shared/contracts";
import { DEV_KIND_LABEL } from "../../shared/devArtifacts";
import { formatBytes, formatCount } from "../lib/format";
import { nativeApi } from "../nativeApi";
import { toast } from "./Toasts";

interface Props {
  snapshot: ScanSnapshot;
}

type GroupBy = "kind" | "project";

export function DevView({ snapshot }: Props) {
  const root = snapshot.rootPath;
  const [report, setReport] = useState<DevArtifactReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>("kind");
  const [kindFilter, setKindFilter] = useState<DevArtifactKind | "all">("all");
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [trashed, setTrashed] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    if (!root) {
      setReport(null);
      return;
    }
    setLoading(true);
    try {
      const next = await nativeApi.getDevArtifacts(root);
      setReport(next);
    } finally {
      setLoading(false);
    }
  }, [root, snapshot.finishedAt, snapshot.bytesSeen]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    if (!report) return [];
    const visible = report.artifacts.filter((a) => !trashed.has(a.path));
    return kindFilter === "all"
      ? visible
      : visible.filter((a) => a.kind === kindFilter);
  }, [report, kindFilter, trashed]);

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

  const trash = async (path: string) => {
    setBusyPath(path);
    try {
      const result = await nativeApi.trashPath(path);
      if (result?.ok) {
        toast("success", "Moved to trash", path);
        setTrashed((prev) => new Set(prev).add(path));
      } else {
        toast("error", "Could not trash", result?.message ?? path);
      }
    } finally {
      setBusyPath(null);
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
        <div className="empty-view"><span>Reading the scan index for developer artifacts…</span></div>
      </div>
    );
  }

  if (!report || report.artifacts.length === 0) {
    return (
      <div className="dev-view">
        <div className="empty-view">
          <span>No developer artifacts on this scan. DiskHound looks for worktrees, package trees, Rust targets, venvs, and compiler caches.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="dev-view">
      <div className="dev-summary">
        <div className="dev-summary-net">
          <span className="changes-delta-big">{formatBytes(report.totalBytes)}</span>
          <span className="changes-delta-label">developer artifacts on disk</span>
        </div>
        <div className="changes-summary-stats">
          <div className="summary-item">
            <div className="summary-item-label">Projects</div>
            <div className="summary-item-value">{formatCount(report.projectCount)}</div>
          </div>
          <div className="summary-item">
            <div className="summary-item-label">Trees</div>
            <div className="summary-item-value">{formatCount(report.artifacts.length)}</div>
          </div>
          <div className="summary-item">
            <div className="summary-item-label">Files</div>
            <div className="summary-item-value">{formatCount(report.totalFiles)}</div>
          </div>
        </div>
      </div>

      <div className="dev-toolbar">
        <div className="chip-group" role="radiogroup" aria-label="Group by">
          <button className={`chip ${groupBy === "kind" ? "active" : ""}`} onClick={() => setGroupBy("kind")}>By kind</button>
          <button className={`chip ${groupBy === "project" ? "active" : ""}`} onClick={() => setGroupBy("project")}>By project</button>
        </div>
        <div className="chip-group">
          <button className={`chip ${kindFilter === "all" ? "active" : ""}`} onClick={() => setKindFilter("all")}>All</button>
          {report.kindTotals.slice(0, 6).map((entry) => (
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
        {groups.map((group) => (
          <section key={group.key} className="dev-group">
            <header className="dev-group-header">
              <span className="dev-group-title">{group.label}</span>
              <span className="dev-group-size">{formatBytes(group.size)}</span>
            </header>
            {group.artifacts.map((artifact) => (
              <div key={artifact.path} className="dev-row">
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
                    disabled={busyPath === artifact.path}
                    onClick={() => {
                      if (!confirm(`Move this tree to the trash?\n\n${artifact.path}`)) return;
                      void trash(artifact.path);
                    }}
                  >
                    Trash
                  </button>
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
