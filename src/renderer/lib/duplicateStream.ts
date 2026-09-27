import type { DuplicateAnalysis, DuplicateGroup, DuplicateScanProgress } from "../../shared/contracts";
import { duplicateGroupReclaimable } from "../../shared/duplicateReclaim";
import { TopK } from "../../shared/topK";

// Duplicate groups stream in during a scan, a few per progress event
// (every ~200 ms). Anything that touches every group so far on each event
// makes a scan's total work quadratic in its group count, and a drive can
// have tens of thousands of groups. These helpers keep each event's work
// proportional to the groups it adds (and the page of groups on screen).

/** Group arrays created here, which `appendDuplicateProgress` may extend in place. */
const streamedGroupArrays = new WeakSet<DuplicateGroup[]>();

/**
 * The live analysis after a progress event's `newGroups` arrive: groups
 * appended and totals carried forward.
 *
 * The group array is extended in place when this module made it and
 * `existing` is its latest version (its `totalGroups` still matches the
 * array's length). Otherwise, the first event of a scan or a state
 * updater run a second time on the same state, it is copied once and the
 * totals are recounted.
 */
export function appendDuplicateProgress(
  existing: DuplicateAnalysis | undefined,
  progress: DuplicateScanProgress,
): DuplicateAnalysis {
  const newGroups = progress.newGroups ?? [];
  const base = existing?.groups;
  let groups: DuplicateGroup[];
  let totalWastedBytes: number;
  let totalDuplicateFiles: number;
  if (base && existing && streamedGroupArrays.has(base) && base.length === existing.totalGroups) {
    groups = base;
    totalWastedBytes = existing.totalWastedBytes;
    totalDuplicateFiles = existing.totalDuplicateFiles;
  } else {
    groups = base ? base.slice(0, existing?.totalGroups ?? base.length) : [];
    streamedGroupArrays.add(groups);
    totalWastedBytes = 0;
    totalDuplicateFiles = 0;
    for (const group of groups) {
      totalWastedBytes += duplicateGroupReclaimable(group);
      totalDuplicateFiles += group.files.length;
    }
  }
  for (const group of newGroups) {
    groups.push(group);
    totalWastedBytes += duplicateGroupReclaimable(group);
    totalDuplicateFiles += group.files.length;
  }
  return {
    groups,
    totalWastedBytes,
    totalGroups: groups.length,
    totalDuplicateFiles,
    rootPath: progress.rootPath,
    filesWalked: progress.filesWalked,
    filesHashed: progress.filesHashed,
    elapsedMs: progress.elapsedMs,
    analyzedAt: existing?.analyzedAt ?? Date.now(),
  };
}

export type DuplicateSortMode = "wasted" | "copies" | "size";

export function compareDuplicateGroups(mode: DuplicateSortMode): (a: DuplicateGroup, b: DuplicateGroup) => number {
  switch (mode) {
    case "copies":
      return (a, b) => b.files.length - a.files.length;
    case "size":
      return (a, b) => b.size - a.size;
    case "wasted":
    default:
      return (a, b) => duplicateGroupReclaimable(b) - duplicateGroupReclaimable(a);
  }
}

/**
 * The first `limit` groups the Duplicates list shows, and totals over
 * every group not dismissed.
 */
export interface DuplicateGroupWindow {
  /** The group array this was built from, and how many of its groups it has seen. */
  source: readonly DuplicateGroup[];
  seen: number;
  sortMode: DuplicateSortMode;
  dismissed: ReadonlySet<string>;
  limit: number;
  /** The first `limit` visible groups of a stable sort by `sortMode`. */
  shown: DuplicateGroup[];
  /** Visible (not dismissed) groups, and the bytes deleting their extra copies frees. */
  visibleCount: number;
  visibleWasted: number;
}

/**
 * Bring `prev` up to date with `groups`. When only new groups were
 * appended since `prev` (a streaming progress event), select the best new
 * groups and merge the page once: O(new × log limit + limit), whatever
 * the total. Anything else (a new array, sort, dismissal or page size)
 * rebuilds from every group.
 */
export function updateDuplicateGroupWindow(
  prev: DuplicateGroupWindow | null,
  groups: readonly DuplicateGroup[],
  sortMode: DuplicateSortMode,
  dismissed: ReadonlySet<string>,
  limit: number,
): DuplicateGroupWindow {
  const compare = compareDuplicateGroups(sortMode);
  if (
    prev
    && prev.source === groups
    && prev.sortMode === sortMode
    && prev.dismissed === dismissed
    && prev.limit === limit
    && groups.length >= prev.seen
  ) {
    if (groups.length === prev.seen) return prev;
    const incoming = new TopK<DuplicateGroup>(limit, compare);
    let { visibleCount, visibleWasted } = prev;
    for (let i = prev.seen; i < groups.length; i += 1) {
      const group = groups[i]!;
      if (dismissed.has(group.hash)) continue;
      visibleCount += 1;
      visibleWasted += duplicateGroupReclaimable(group);
      // Existing groups win ties, so groups behind a full page cannot enter.
      if (prev.shown.length >= limit
        && (limit <= 0 || compare(group, prev.shown[prev.shown.length - 1]!) >= 0)) continue;
      incoming.offer(group);
    }
    let shown = prev.shown;
    if (incoming.size > 0) {
      const added = incoming.sorted();
      shown = [];
      let oldAt = 0;
      let newAt = 0;
      while (shown.length < incoming.limit && (oldAt < prev.shown.length || newAt < added.length)) {
        // Existing groups arrived first and win ties in the stable sort.
        if (oldAt < prev.shown.length
          && (newAt >= added.length || compare(prev.shown[oldAt]!, added[newAt]!) <= 0)) {
          shown.push(prev.shown[oldAt++]!);
        } else {
          shown.push(added[newAt++]!);
        }
      }
    }
    return { ...prev, seen: groups.length, shown, visibleCount, visibleWasted };
  }

  const top = new TopK<DuplicateGroup>(limit, compare);
  let visibleCount = 0;
  let visibleWasted = 0;
  for (const group of groups) {
    if (dismissed.has(group.hash)) continue;
    visibleCount += 1;
    visibleWasted += duplicateGroupReclaimable(group);
    top.offer(group);
  }
  return {
    source: groups,
    seen: groups.length,
    sortMode,
    dismissed,
    limit,
    shown: top.sorted(),
    visibleCount,
    visibleWasted,
  };
}
