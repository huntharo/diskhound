import { describe, expect, it } from "vitest";
import { createIdleScanSnapshot, type FullDiffProgress, type ScanSnapshot } from "../../../shared/contracts";
import { scanDisplayProgress } from "../scanProgress";

const snapshot: ScanSnapshot = { ...createIdleScanSnapshot(), status: "done", rootPath: "/", startedAt: 123 };
const progress: FullDiffProgress = { rootPath: "/", scanStartedAt: 123, baselineId: "a", currentId: "b",
  isLatestPair: true, status: "running", revision: 1, phase: "merging", fraction: 0.73, completed: 2, total: 5 };
const display = (snap = snapshot, comparisons = [progress]) => scanDisplayProgress(snap, [], comparisons, "darwin");

describe("shared scan progress", () => {
  it("shows a moving finalizing bar even when bytes exceed drive usage", () => {
    expect(display({ ...snapshot, status: "running", scanPhase: "finalizing", finalizingStep: "writing_folder_tree" }))
      .toEqual({ active: true, label: "Finalizing", detail: "Writing folder tree", percent: null });
  });
  it("keeps the completed scan busy while its comparison runs", () => {
    expect(display()).toMatchObject({ active: true, label: "Examining changes", percent: 73 });
    expect(display(snapshot, [{ ...progress, fraction: 1 }]).percent).toBe(99);
    expect(display(snapshot, [{ ...progress, status: "complete", fraction: 1 }]))
      .toMatchObject({ active: false, label: "Complete", percent: 100 });
  });
  it("ignores other roots and stale scan pairs", () => {
    for (const unrelated of [{ ...progress, isLatestPair: false }, { ...progress, rootPath: "/Volumes/Other" }, { ...progress, scanStartedAt: 122 }]) {
      expect(display(snapshot, [unrelated]).label).toBe("Complete");
    }
    expect(display({ ...snapshot, status: "running", scanPhase: "indexing" }).label).toBe("Scanning");
  });
  it("clears activity on failure, cancellation, and the first scan", () => {
    expect(display(snapshot, [{ ...progress, status: "error" }])).toMatchObject({ active: false, label: "Comparison unavailable" });
    expect(display({ ...snapshot, status: "cancelled" }).active).toBe(false);
    expect(display(snapshot, []).label).toBe("Complete");
  });
});
