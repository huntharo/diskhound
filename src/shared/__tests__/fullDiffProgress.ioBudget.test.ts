import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { completedScanSnapshot } from "../../test/scanSnapshotFixture";
import type { FullDiffProgress, FullDiffResult, FullDiffWorkProgress } from "../contracts";
import { createFullDiffLoader } from "../fullDiffLoader";
import { initFullDiffCacheStore } from "../fullDiffCacheStore";
import { initScanHistory, loadHistoricalSnapshot, saveScanToHistory } from "../scanHistory";
import { initScanIndex } from "../scanIndex";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));

let dir: string;
beforeEach(async () => {
  dir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-progress-"));
  initScanHistory(dir); initScanIndex(dir); initFullDiffCacheStore(dir);
});
afterEach(async () => { await FSP.rm(dir, { recursive: true, force: true }); });

async function seed() {
  const snapshot = completedScanSnapshot("/scan", 1_800_000_000_000);
  const baselineId = (await saveScanToHistory({ ...snapshot, finishedAt: snapshot.finishedAt! - 1000, bytesSeen: 1 }))!;
  const currentId = (await saveScanToHistory(snapshot))!;
  const result: FullDiffResult = { baselineId, currentId, totalChanges: 0, totalAdded: 0, totalRemoved: 0,
    totalGrew: 0, totalShrank: 0, totalBytesAdded: 0, totalBytesRemoved: 0, changes: [], truncated: false };
  return { snapshot, baselineId, currentId, result };
}

it("replays progress to a joining Changes load without writing progress to disk", async () => {
  const { snapshot, baselineId, currentId, result } = await seed();
  let report!: (progress: FullDiffWorkProgress) => void;
  let finish!: (result: FullDiffResult) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const onProgress = vi.fn<(progress: FullDiffProgress) => void>();
  const runWorker = vi.fn((_input, progress) => new Promise<FullDiffResult>((resolve) => {
    report = progress; finish = resolve; started();
  }));
  const loader = createFullDiffLoader({ loadSnapshot: loadHistoricalSnapshot, runWorker,
    computeInline: vi.fn(), log: vi.fn(), onProgress });
  const warm = loader.warmLatest("/scan", snapshot);
  // Synchronous start signal: main can send it before the scan's Done snapshot.
  expect(loader.getProgress()[0]).toMatchObject({ rootPath: "/scan", baselineId, currentId, status: "running", fraction: 0 });
  await ready;
  let joined!: Promise<FullDiffResult | null>;
  const { io } = await measureFsIo(() => {
    joined = loader.load(baselineId, currentId, 1000);
    for (let i = 0; i < 400; i++) report({ phase: "merging", fraction: 0.55 + i / 1000, completed: i, total: 400 });
    expect(loader.getProgress()[0].status).toBe("running");
    expect(loader.getProgress()[0].fraction).toBeCloseTo(0.949);
  });
  expectIoBudget({ scenario: "full-diff-progress", io,
    note: "400 progress messages (100 s at 4/s), a Changes load joining the warm, and a late window reading progress: 0 writes, 0 MB/day at both the 6-hour default and the 1-minute interval. The existing diff runs and result cache retain their separate budgets." });
  finish(result);
  expect(await warm).toEqual(result);
  expect(await joined).toEqual(result);
  expect(runWorker).toHaveBeenCalledTimes(1);
  expect(loader.getProgress()[0]).toMatchObject({ status: "complete", fraction: 1 });
});

it("clears running state on worker and fallback failure, and reports a retry", async () => {
  const { snapshot, baselineId, currentId, result } = await seed();
  const runWorker = vi.fn().mockRejectedValueOnce(new Error("worker failed")).mockResolvedValueOnce(result);
  const loader = createFullDiffLoader({ loadSnapshot: loadHistoricalSnapshot, runWorker,
    computeInline: vi.fn().mockRejectedValue(new Error("fallback failed")), log: vi.fn() });
  expect(await loader.warmLatest("/scan", snapshot)).toBeNull();
  expect(loader.getProgress()[0].status).toBe("error");
  const revision = loader.getProgress()[0].revision;
  expect(await loader.load(baselineId, currentId, 1000, { retryFailed: true })).toEqual(result);
  expect(loader.getProgress()[0].status).toBe("complete");
  expect(loader.getProgress()[0].revision).toBeGreaterThan(revision);
});

it("finishes the warm's pending state on a disk cache hit", async () => {
  const { snapshot, result } = await seed();
  const deps = { loadSnapshot: loadHistoricalSnapshot, runWorker: vi.fn().mockResolvedValue(result),
    computeInline: vi.fn(), log: vi.fn() };
  await createFullDiffLoader(deps).warmLatest("/scan", snapshot);
  deps.runWorker.mockClear();
  const loader = createFullDiffLoader(deps);
  await loader.warmLatest("/scan", snapshot);
  expect(deps.runWorker).not.toHaveBeenCalled();
  expect(loader.getProgress()[0].status).toBe("complete");
});
