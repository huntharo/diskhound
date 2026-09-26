import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { completedScanSnapshot } from "../../test/scanSnapshotFixture";
import type { ScanSnapshot } from "../contracts";
import { initScanHistory, saveScanToHistory, setMaxHistoryPerRoot } from "../scanHistory";
import { createScanSnapshotStore } from "../scanStore";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));

const ROOT = "/Volumes/Data";
const FINISHED_AT = 1_758_800_000_000;

let dataDir: string;

beforeEach(async () => {
  dataDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-scan-io-"));
  setMaxHistoryPerRoot(7);
});

afterEach(async () => {
  await FSP.rm(dataDir, { recursive: true, force: true });
});

/** The progress snapshots scanWorker.ts emits every 200 ms. */
function progressSnapshots(done: ScanSnapshot, count: number): ScanSnapshot[] {
  return Array.from({ length: count }, (_, i) => ({
    ...done,
    status: "running",
    finishedAt: null,
    filesVisited: i * 10_000,
    lastUpdatedAt: done.startedAt! + i * 200,
    scanPhase: "indexing",
  }));
}

describe("scan snapshot store (last-scan.json)", () => {
  it("writes once per scan, however many progress ticks came first", async () => {
    const store = await createScanSnapshotStore(dataDir);
    const done = completedScanSnapshot(ROOT, FINISHED_AT);

    const { io } = await measureFsIo(async () => {
      for (const snapshot of progressSnapshots(done, 450)) await store.set(snapshot);
      await store.set(done);
    });

    expectIoBudget({
      scenario: "scan-store-progress-then-done",
      note: "450 progress snapshots (90 s at the 200 ms tick) then done, at the 5,000-file/10,000-dir caps: 1 atomic write of last-scan.json (~2.8 MB; temp file + rename) per completed scan; 4 scheduled scans/day at the 6 h default is ~11 MB/day",
      io,
    });
    expect(JSON.parse(FS.readFileSync(Path.join(dataDir, "last-scan.json"), "utf8")).status).toBe("done");
  });
});

describe("scan history", () => {
  it("writes the snapshot and the index once per completed scan", async () => {
    initScanHistory(dataDir);
    const { io } = await measureFsIo(() => saveScanToHistory(completedScanSnapshot(ROOT, FINISHED_AT)));

    expectIoBudget({
      scenario: "scan-history-save",
      note: "one completed scan: scan-<id>.json (~2.8 MB) plus a sync, pretty-printed, atomic scan-history-index.json (temp file + rename); ~11 MB/day at the 6 h scheduled-rescan default",
      io,
    });
  });

  it("deletes the oldest snapshot once a root passes its retention cap", async () => {
    initScanHistory(dataDir);
    for (let i = 0; i < 7; i++) {
      await saveScanToHistory(completedScanSnapshot(ROOT, FINISHED_AT - (7 - i) * 3_600_000));
    }

    const { io } = await measureFsIo(() => saveScanToHistory(completedScanSnapshot(ROOT, FINISHED_AT)));

    expectIoBudget({
      scenario: "scan-history-save-with-prune",
      note: "the 8th scan of a root with the default 7-scan cap: the two writes and the index rename of a save, plus one unlink of the pruned snapshot",
      io,
    });
  });

  it("costs both files per completed scan in main.ts's done path", async () => {
    // handleRuntimeMessage (main.ts) saves history first, then
    // broadcastSnapshot hands the same snapshot to the scan store.
    initScanHistory(dataDir);
    const store = await createScanSnapshotStore(dataDir);
    const done = completedScanSnapshot(ROOT, FINISHED_AT);

    const { io } = await measureFsIo(async () => {
      await saveScanToHistory(done);
      await store.set(done);
    });

    expectIoBudget({
      scenario: "scan-completed-json-files",
      note: "one completed scan's JSON: the history snapshot and last-scan.json hold the same ~2.8 MB, 5.6 MB per scan and ~22 MB/day at the 6 h default, half of it the duplicate; the history index and last-scan.json are atomic (2 renames); the NDJSON index and sidecar renames are not in this scenario",
      io,
    });
  });
});
