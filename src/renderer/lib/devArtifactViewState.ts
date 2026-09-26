import type { DevArtifact, DevArtifactKind, DevArtifactReport, ScanSnapshot } from "../../shared/contracts";
import { DEV_KIND_LABEL } from "../../shared/devArtifacts";
import { summarizeDevSharing } from "../../shared/storageSharing";

export type DevGroupBy = "all" | "kind" | "project";
export type DevSortBy = "size" | "increase";

export type DevArtifactGroup = {
  key: string;
  label: string;
  /** Sum of the trees' sizes. */
  size: number;
  /** What deleting every tree in the group frees, low and high end (see summarizeDevSharing). */
  frees: number;
  freesAtMost: number;
  artifacts: DevArtifact[];
};

function groupOf(key: string, label: string, artifacts: DevArtifact[]): DevArtifactGroup {
  const sharing = summarizeDevSharing(artifacts);
  return {
    key,
    label,
    size: sharing.totalBytes,
    frees: sharing.freesBytes,
    freesAtMost: sharing.freesAtMostBytes,
    artifacts,
  };
}

function bySize(a: DevArtifact, b: DevArtifact): number {
  return b.size - a.size || a.path.localeCompare(b.path);
}

/** Null / missing deltas rank as 0 — with neutrals, after real increases. */
function deltaOrZero(artifact: DevArtifact): number {
  return artifact.deltaBytes ?? 0;
}

function byIncrease(a: DevArtifact, b: DevArtifact): number {
  return deltaOrZero(b) - deltaOrZero(a) || bySize(a, b);
}

function compareArtifacts(sortBy: DevSortBy): (a: DevArtifact, b: DevArtifact) => number {
  return sortBy === "increase" ? byIncrease : bySize;
}

/** Visible change data: a measured delta, or a previous size we can compare. */
export function hasDevChangeData(rows: DevArtifact[]): boolean {
  return rows.some((artifact) => artifact.deltaBytes != null || artifact.previousSize != null);
}

/** Keep the user's increase preference; fall back to size when this filter has no deltas. */
export function effectiveDevSort(sortBy: DevSortBy, filterHasIncrease: boolean): DevSortBy {
  return sortBy === "increase" && filterHasIncrease ? "increase" : "size";
}

/**
 * Flat All, or buckets by kind / project. Lists are size-first, or increase-first.
 * With `reclaim`, groups rank by the middle of what deleting them frees, as the
 * kind rail does once clones make the listed sizes overstate it.
 */
export function groupDevArtifacts(
  rows: DevArtifact[],
  groupBy: DevGroupBy,
  sortBy: DevSortBy = "size",
  reclaim = false,
): DevArtifactGroup[] {
  const compare = compareArtifacts(sortBy);
  if (groupBy === "all") {
    const artifacts = [...rows].sort(compare);
    if (artifacts.length === 0) return [];
    return [groupOf("all", "All trees", artifacts)];
  }

  const map = new Map<string, DevArtifact[]>();
  for (const artifact of rows) {
    const key = groupBy === "kind" ? artifact.kind : (artifact.projectPath ?? "unscoped");
    const list = map.get(key) ?? [];
    list.push(artifact);
    map.set(key, list);
  }
  const amount = (g: DevArtifactGroup) => (reclaim ? (g.frees + g.freesAtMost) / 2 : g.size);
  return [...map.entries()].map(([key, artifacts]) => groupOf(
    key,
    groupBy === "kind"
      ? DEV_KIND_LABEL[key as DevArtifactKind]
      : (artifacts[0]?.projectName ?? "Unscoped"),
    [...artifacts].sort(compare),
  )).sort((a, b) => amount(b) - amount(a) || a.label.localeCompare(b.label));
}

/** Rows whose path is one of `paths`, in row order. */
export function artifactsAtPaths(rows: DevArtifact[], paths: readonly string[]): DevArtifact[] {
  const wanted = new Set(paths);
  return rows.filter((artifact) => wanted.has(artifact.path));
}

export function reportKey(root: string | null, finishedAt: number | null): string {
  return `${root ?? ""}|${finishedAt ?? 0}`;
}

export function isUsefulDevReport(
  report: DevArtifactReport | null | undefined,
): report is DevArtifactReport {
  return Boolean(report && report.artifacts.length > 0);
}

export type DevSessionCache = {
  key: string;
  report: DevArtifactReport;
} | null;

export type DevLastGood = {
  root: string;
  report: DevArtifactReport;
} | null;

export function seedDevViewState(
  root: string | null,
  finishedAt: number | null,
  status: ScanSnapshot["status"],
  sessionReport: DevSessionCache,
  lastGood: DevLastGood,
  settledEmptyKey: string | null,
): { report: DevArtifactReport | null; loading: boolean; settled: boolean; startedAt: number | null } {
  const key = reportKey(root, finishedAt);
  if (sessionReport?.key === key && isUsefulDevReport(sessionReport.report)) {
    return { report: sessionReport.report, loading: false, settled: true, startedAt: null };
  }
  if (root && lastGood?.root === root && isUsefulDevReport(lastGood.report)) {
    return { report: lastGood.report, loading: false, settled: false, startedAt: null };
  }
  if (settledEmptyKey === key && status === "done") {
    return {
      report: sessionReport?.key === key ? sessionReport.report : null,
      loading: false,
      settled: true,
      startedAt: null,
    };
  }
  if (status === "done" && root) {
    return { report: null, loading: true, settled: false, startedAt: Date.now() };
  }
  return { report: null, loading: false, settled: false, startedAt: null };
}

export function resolveDevPaint(input: {
  report: DevArtifactReport | null;
  remainingCount: number;
  loading: boolean;
  settled: boolean;
  loadError: string | null;
}): "list" | "loading" | "error" | "empty" {
  if (input.report && input.remainingCount > 0) return "list";
  if (input.loadError && !input.report && input.settled && !input.loading) return "error";
  if (!input.settled || input.loading) return "loading";
  return "empty";
}
