import "node:fs";
import "node:fs/promises";

import { beforeAll, describe, expect, it, vi } from "vitest";

import type { FullDiffStatus, ScanDiffResult, ScanHistoryEntry } from "../shared/contracts";
import { expectIoBudget, measureFsIo } from "../test/ioBudget";
import { bootMainProcess, type MainProcess } from "../test/mainProcessHarness";
import { hostRoot, seedProfile } from "../test/mainProfileFixture";

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

const ROOT = hostRoot("/Volumes/Data");
/** The Settings maximum for "Scan history per drive". */
const HISTORY = 30;
/** ChangesView asks for the full per-file diff at this limit. */
const FULL_DIFF_LIMIT = 1_000;
/** ChangesView auto-loads the full diff when both indexes together are under this. */
const FULL_DIFF_AUTOLOAD_MAX_BYTES = 64 * 1024 * 1024;

let main: MainProcess;

beforeAll(async () => {
  main = await bootMainProcess({
    seed: (userData) => seedProfile(userData, { roots: [{ rootPath: ROOT, scans: HISTORY }] }).then(() => undefined),
  });
}, 60_000);

/** Full-diff status, then the full diff itself when ChangesView would auto-load it. */
async function showPair(baselineId: string, currentId: string): Promise<void> {
  const status = await main.invoke<FullDiffStatus>("diskhound:get-full-diff-status", baselineId, currentId, FULL_DIFF_LIMIT);
  const bytes = (status.baselineIndexBytes ?? Infinity) + (status.currentIndexBytes ?? Infinity);
  if (status.cached || bytes <= FULL_DIFF_AUTOLOAD_MAX_BYTES) {
    await main.invoke("diskhound:compute-full-scan-diff", baselineId, currentId, FULL_DIFF_LIMIT);
  }
}

/** What ChangesView asks main for when the tab mounts. */
async function mountChanges(): Promise<ScanHistoryEntry[]> {
  const [history, diff] = await Promise.all([
    main.invoke<ScanHistoryEntry[]>("diskhound:get-scan-history", ROOT),
    main.invoke<ScanDiffResult | null>("diskhound:get-latest-diff", ROOT),
    main.invoke("diskhound:get-scan-schedule-info"),
  ]);
  expect(diff).not.toBeNull();
  await showPair(diff!.baselineId, diff!.currentId);
  return history;
}

/** Clicking every older scan in the sidebar, in the default cumulative mode. */
async function browseBaselines(history: ScanHistoryEntry[]): Promise<void> {
  const current = history[0]!.id;
  for (const baseline of history.slice(1)) {
    await main.invoke("diskhound:compute-scan-diff", baseline.id, current);
    await showPair(baseline.id, current);
  }
}

describe("Changes tab", () => {
  it("serves a remount from memory", async () => {
    const first = await measureFsIo(mountChanges, { countProcesses: true });
    expectIoBudget({
      scenario: "main-changes-first-mount",
      note: "first Changes mount: the latest two snapshots (~2.8 MB each) once, and the full diff of that pair (equal totals, so the empty result is computed without a worker and cached to disk once, after both indexes are stat'd for the failed-diff check)",
      io: first.io,
    });

    const again = await measureFsIo(async () => {
      for (let i = 0; i < 10; i++) await mountChanges();
    }, { countProcesses: true });
    expectIoBudget({
      scenario: "main-changes-remount",
      note: "10 more Changes mounts: 0 reads (was 1 access and 2 stats per mount for the full-diff status)",
      io: again.io,
    });
  });

  it("serves a second pass over all 30 scans from memory", async () => {
    const history = await mountChanges();
    expect(history).toHaveLength(HISTORY);

    const first = await measureFsIo(() => browseBaselines(history), { countProcesses: true });
    expectIoBudget({
      scenario: "main-changes-browse-history-first",
      note: "clicking each of the 29 older scans once (the mount loaded the first): per new pair, the baseline snapshot is read and its index size stat'd once, both indexes are stat'd for the failed-diff check, the full-diff cache is checked once (it was checked twice before), and the empty full diff is written to it once",
      io: first.io,
    });

    const again = await measureFsIo(async () => {
      await mountChanges();
      await browseBaselines(history);
    }, { countProcesses: true });
    expectIoBudget({
      scenario: "main-changes-browse-history-again",
      note: "remount and click all 29 older scans again: 0 reads (the 8-snapshot cache used to re-read ~21 snapshots of ~2.8 MB, and the full-diff status did 1 access and 2 stats per click)",
      io: again.io,
    });
  });
});
