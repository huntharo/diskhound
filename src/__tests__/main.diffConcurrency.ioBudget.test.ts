import * as FS from "node:fs";
import "node:fs/promises";
import * as Path from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import { defaultSettings, type ScanDiffResult } from "../shared/contracts";
import { initScanHistory, saveScanToHistory, setMaxHistoryPerRoot } from "../shared/scanHistory";
import { expectIoBudget, measureFsIo } from "../test/ioBudget";
import { bootMainProcess, type MainProcess } from "../test/mainProcessHarness";
import { hostRoot } from "../test/mainProfileFixture";
import { completedScanSnapshot } from "../test/scanSnapshotFixture";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFsPromises(await importOriginal()));
vi.mock("node:child_process", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentChildProcess(await importOriginal()));
vi.mock("node:worker_threads", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentWorkerThreads(await importOriginal()));
vi.mock("electron", async () =>
  (await import("../test/mainProcessHarness")).fakeElectron());
vi.mock("../shared/crashLog", async (importOriginal) =>
  (await import("../test/mainProcessHarness")).settledCrashLog(await importOriginal()));

const ROOT = hostRoot("/Volumes/DiffConcurrency");
let main: MainProcess;
const ids: string[] = [];

beforeAll(async () => {
  main = await bootMainProcess({ seed: async (userData) => {
    const settings = defaultSettings();
    settings.storage.maxHistoryPerRoot = 30;
    settings.monitoring.enabled = false;
    FS.writeFileSync(Path.join(userData, "settings.json"), JSON.stringify(settings));
    initScanHistory(userData);
    setMaxHistoryPerRoot(30);
    for (let scan = 0; scan < 15; scan++) {
      const snapshot = completedScanSnapshot(ROOT, 1_758_800_000_000 + scan * 60_000);
      // Exactly 10,000 changed directory rows per pair, using real-sized
      // snapshots. Fourteen diffs fit in the 200,000-row cache once each.
      snapshot.hottestDirectories = snapshot.hottestDirectories.map((dir) => ({ ...dir, size: dir.size + scan }));
      ids.push((await saveScanToHistory(snapshot))!);
    }
  } });
}, 60_000);

it("charges concurrent cold pairs once and keeps warm navigation free of reads", async () => {
  const current = ids.at(-1)!;
  for (const baseline of ids.slice(0, -1)) {
    const [first, second] = await Promise.all([
      main.invoke<ScanDiffResult>("diskhound:compute-scan-diff", baseline, current),
      main.invoke<ScanDiffResult>("diskhound:compute-scan-diff", baseline, current),
    ]);
    expect(first.directoryDeltas).toHaveLength(10_000);
    expect(second).toBe(first);
  }
  const { io } = await measureFsIo(async () => {
    for (const baseline of ids.slice(0, -1)) {
      await main.invoke("diskhound:compute-scan-diff", baseline, current);
    }
  }, { countProcesses: true });
  expectIoBudget({
    scenario: "main-diff-concurrent-warm-navigation",
    note: "14 pairs of concurrent cold requests charge 140,000 directory rows once; revisiting all pairs reads and writes nothing, even after their snapshots leave the 8-entry cache. 0 writes/day and 0 MB/day at default or 1-minute monitoring.",
    io,
  });
});
