import { describe, expect, it } from "vitest";

import type { DuplicateAnalysis, DuplicateGroup, DuplicateScanProgress } from "../../../shared/contracts";
import { duplicateGroupReclaimable } from "../../../shared/duplicateReclaim";
import { countReads, expectNearLinear, measureOpsSync } from "../../../testing/opCounter";
import {
  appendDuplicateProgress,
  compareDuplicateGroups,
  updateDuplicateGroupWindow,
  type DuplicateGroupWindow,
  type DuplicateSortMode,
} from "../duplicateStream";

// Operation-count scaling tests: stream N and 8N groups through the path
// a scan's progress events take (App appends, the list updates its page)
// and require the total work to grow at most ~2× faster than linear. A
// per-event copy, total or sort over every group so far grows ~64×.

const BATCH = 10;
const PAGE = 200;

function group(i: number): DuplicateGroup {
  const copies = 2 + (i % 4);
  return {
    hash: `h${i}`,
    size: 1_000 + ((i * 7_919) % 5_000),
    files: Array.from({ length: copies }, (_, c) => ({
      path: `/data/${c}/f${i}.bin`,
      name: `f${i}.bin`,
      parentPath: `/data/${c}`,
      modifiedAt: c,
    })),
    reclaimableBytes: (copies - 1) * (1_000 + ((i * 7_919) % 5_000)),
  };
}

function progress(newGroups: DuplicateGroup[]): DuplicateScanProgress {
  return {
    rootPath: "/data",
    status: "hashing",
    filesWalked: 0,
    candidateGroups: 0,
    filesHashed: 0,
    groupsConfirmed: 0,
    elapsedMs: 0,
    errorMessage: null,
    newGroups,
  };
}

/** Every progress event's work, as App and DuplicatesView do it, for `count` groups. */
function stream(count: number, sortMode: DuplicateSortMode) {
  const groups = Array.from({ length: count }, (_, i) => countReads(group(i)));
  const noneDismissed = new Set<string>();
  let analysis: DuplicateAnalysis | undefined;
  let window: DuplicateGroupWindow | null = null;
  const { ops } = measureOpsSync(() => {
    for (let at = 0; at < count; at += BATCH) {
      analysis = appendDuplicateProgress(analysis, progress(groups.slice(at, at + BATCH)));
      window = updateDuplicateGroupWindow(window, analysis.groups, sortMode, noneDismissed, PAGE);
    }
  });
  return { ops, analysis: analysis!, window: window! };
}

describe("duplicate group streaming scaling", () => {
  for (const sortMode of ["wasted", "copies", "size"] as DuplicateSortMode[]) {
    it(`does work per new group, not per group so far (${sortMode})`, () => {
      const small = stream(500, sortMode);
      const large = stream(4_000, sortMode);
      // ~70 ops per group, most of it placing groups into the 200-group page.
      expectNearLinear(`duplicate streaming ${sortMode}`, small.ops, large.ops, { maxTotal: 4_000 * 150 });
    });
  }
});

describe("duplicate group streaming results", () => {
  it("matches totals and a full stable sort cut to the page", () => {
    for (const sortMode of ["wasted", "copies", "size"] as DuplicateSortMode[]) {
      const { analysis, window } = stream(1_234, sortMode);
      const all = Array.from({ length: 1_234 }, (_, i) => group(i));
      expect(analysis.groups.map((g) => g.hash)).toEqual(all.map((g) => g.hash));
      expect(analysis.totalGroups).toBe(1_234);
      expect(analysis.totalWastedBytes).toBe(all.reduce((sum, g) => sum + duplicateGroupReclaimable(g), 0));
      expect(analysis.totalDuplicateFiles).toBe(all.reduce((sum, g) => sum + g.files.length, 0));
      const expected = [...all].sort(compareDuplicateGroups(sortMode)).slice(0, PAGE).map((g) => g.hash);
      expect(window.shown.map((g) => g.hash)).toEqual(expected);
      expect(window.visibleCount).toBe(1_234);
      expect(window.visibleWasted).toBe(analysis.totalWastedBytes);
    }
  });

  it("copies instead of appending twice when an updater runs again on the same state", () => {
    const first = appendDuplicateProgress(undefined, progress([group(0), group(1)]));
    const again = progress([group(2)]);
    const once = appendDuplicateProgress(first, again);
    const twice = appendDuplicateProgress(first, again);
    expect(once.groups.map((g) => g.hash)).toEqual(["h0", "h1", "h2"]);
    expect(twice.groups.map((g) => g.hash)).toEqual(["h0", "h1", "h2"]);
    expect(twice.totalWastedBytes).toBe(once.totalWastedBytes);
  });

  it("copies a finished result instead of appending to it", () => {
    const finished: DuplicateAnalysis = {
      groups: [group(0)],
      totalWastedBytes: 1,
      totalGroups: 1,
      totalDuplicateFiles: 1,
      rootPath: "/data",
      filesWalked: 0,
      filesHashed: 0,
      elapsedMs: 0,
      analyzedAt: 5,
    };
    const next = appendDuplicateProgress(finished, progress([group(1)]));
    expect(finished.groups).toHaveLength(1);
    expect(next.groups.map((g) => g.hash)).toEqual(["h0", "h1"]);
    expect(next.totalWastedBytes).toBe(duplicateGroupReclaimable(group(0)) + duplicateGroupReclaimable(group(1)));
    expect(next.analyzedAt).toBe(5);
  });

  it("rebuilds the page when the sort, dismissals or page size change", () => {
    const { analysis, window } = stream(600, "wasted");
    const bigger = updateDuplicateGroupWindow(window, analysis.groups, "wasted", window.dismissed, PAGE * 2);
    expect(bigger.shown).toHaveLength(400);
    const dismissed = new Set(bigger.shown.slice(0, 3).map((g) => g.hash));
    const fewer = updateDuplicateGroupWindow(bigger, analysis.groups, "wasted", dismissed, PAGE * 2);
    expect(fewer.visibleCount).toBe(597);
    expect(fewer.shown[0]).toBe(bigger.shown[3]);
    const bySize = updateDuplicateGroupWindow(fewer, analysis.groups, "size", dismissed, PAGE * 2);
    expect(bySize.shown.map((g) => g.size)).toEqual([...bySize.shown].map((g) => g.size).sort((a, b) => b - a));
  });
});
