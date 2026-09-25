import { describe, expect, it } from "vitest";

import {
  HEAP_BYTES_PER_SIDECAR_BYTE,
  MAX_TREE_HEAP_BYTES,
  planFolderTreeLoad,
  type FolderTreeLoadInputs,
} from "../folderTreeLoadPlan";

const MB = 1024 * 1024;
/** Electron 40's main-process limit: pointer compression caps it at 4 GB. */
const ELECTRON_HEAP_LIMIT = 4096 * MB;

const base: FolderTreeLoadInputs = {
  sidecarBytes: null,
  hasIndex: true,
  heapLimitBytes: ELECTRON_HEAP_LIMIT,
  heapUsedBytes: 15 * MB,
};

describe("planFolderTreeLoad", () => {
  it("pages the 42M-file / scan that aborted the app at boot", () => {
    const plan = planFolderTreeLoad({
      ...base,
      sidecarBytes: 995_151_299,
      filesVisited: 42_261_014,
      directoriesVisited: 10_025_363,
    });
    expect(plan.mode).toBe("paged");
    expect(plan.estimatedHeapBytes).toBeGreaterThan(ELECTRON_HEAP_LIMIT);
    expect(plan.reason).toContain("sidecar 949 MB");
  });

  it("keeps a typical 7M-file C:\\ sidecar in memory", () => {
    const plan = planFolderTreeLoad({
      ...base,
      sidecarBytes: 50 * MB,
      filesVisited: 7_270_000,
      directoriesVisited: 1_000_000,
    });
    expect(plan.mode).toBe("memory");
    expect(plan.estimatedHeapBytes).toBe(500 * MB);
  });

  it("switches to paging right at the tree budget", () => {
    const atBudget = MAX_TREE_HEAP_BYTES / HEAP_BYTES_PER_SIDECAR_BYTE;
    expect(planFolderTreeLoad({ ...base, sidecarBytes: atBudget }).mode).toBe("memory");
    expect(planFolderTreeLoad({ ...base, sidecarBytes: atBudget + 1 }).mode).toBe("paged");
  });

  it("caps the tree at a quarter of a smaller heap limit", () => {
    const plan = planFolderTreeLoad({ ...base, heapLimitBytes: 2048 * MB, sidecarBytes: 60 * MB });
    expect(plan.allowedHeapBytes).toBe(512 * MB);
    expect(plan.mode).toBe("paged");
  });

  it("pages a tree that fits the budget when the heap is already busy", () => {
    const inputs = { ...base, sidecarBytes: 40 * MB };
    expect(planFolderTreeLoad({ ...inputs, heapUsedBytes: 2000 * MB }).mode).toBe("memory");
    const busy = planFolderTreeLoad({ ...inputs, heapUsedBytes: 2100 * MB });
    expect(busy.mode).toBe("paged");
    expect(busy.reason).toContain("2,100 MB of 4,096 MB heap already in use");
  });

  it("never allows a negative budget when the heap is past the load ceiling", () => {
    const plan = planFolderTreeLoad({ ...base, sidecarBytes: 1, heapUsedBytes: 3900 * MB });
    expect(plan.allowedHeapBytes).toBe(0);
    expect(plan.mode).toBe("paged");
  });

  it("honours an override that forces paging", () => {
    expect(planFolderTreeLoad({ ...base, sidecarBytes: 1024, maxTreeHeapBytes: 0 }).mode).toBe("paged");
  });

  it("sizes an index rebuild from history counts at twice the tree, and refuses big ones", () => {
    const small = planFolderTreeLoad({ ...base, filesVisited: 500_000, directoriesVisited: 50_000 });
    expect(small.mode).toBe("memory");
    expect(small.estimatedHeapBytes).toBe(500_000 * 130 + 50_000 * 400);

    const big = planFolderTreeLoad({ ...base, filesVisited: 42_261_014, directoriesVisited: 10_025_363 });
    expect(big.mode).toBe("unavailable");
    expect(big.reason).toMatch(/^no sidecar; index rebuild peaks at/);
  });

  it("is unavailable when neither the sidecar nor the index is on disk", () => {
    const plan = planFolderTreeLoad({ ...base, hasIndex: false });
    expect(plan.mode).toBe("unavailable");
    expect(plan.reason).toBe("no folder-tree sidecar and no scan index on disk");
  });

  it("uses the sidecar even when history counts are huge", () => {
    // Counts are an upper bound; the sidecar size is the measurement.
    const plan = planFolderTreeLoad({
      ...base,
      sidecarBytes: 20 * MB,
      filesVisited: 40_000_000,
      directoriesVisited: 9_000_000,
    });
    expect(plan.mode).toBe("memory");
  });
});
