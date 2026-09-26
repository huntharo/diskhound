import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkUsnForAnyChanges } from "../usnMonitor";
import { normPath } from "../shared/pathUtils";
import { runIncrementalRescan, type IncrementalRescanDeps } from "../incrementalRescan";
import { commitCompletedScan, settingsWithRecentScan } from "../scanCommit";
import type { DiskDelta, ScanSnapshot } from "../shared/contracts";
import { __resetDiskMonitorForTests, flushDiskMonitor, initDiskMonitor, markFullScan } from "../shared/diskMonitor";
import { createFullDiffLoader } from "../shared/fullDiffLoader";
import { initFullDiffCacheStore, writeFullDiffCache } from "../shared/fullDiffCacheStore";
import { computeFullDiffFromIndexFiles } from "../shared/fullDiffWorkerRuntime";
import {
  getScanHistory,
  initScanHistory,
  loadHistoricalSnapshot,
  saveScanToHistory,
  setMaxHistoryPerRoot,
} from "../shared/scanHistory";
import {
  devArtifactsSidecarPath,
  folderTreeSidecarPath,
  indexFilePath,
  initScanIndex,
} from "../shared/scanIndex";
import { createScanSnapshotStore, type ScanSnapshotStore } from "../shared/scanStore";
import { createSettingsStore } from "../shared/settingsStore";
import {
  __resetStoreForTests as resetCursors,
  flushUsnCursorStore,
  getCursor,
  initUsnCursorStore,
  setCursor,
} from "../shared/usnCursorStore";
import { expectIoBudget, measureFsIo } from "../test/ioBudget";
import { completedScanSnapshot } from "../test/scanSnapshotFixture";
import {
  syntheticTree,
  writeSyntheticFolderTreeSidecar,
  writeSyntheticIndex,
  type SyntheticTree,
} from "../test/scanIndexFixture";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFsPromises(await importOriginal()));

const paths = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: () => paths.userData } }));

/** NDJSON lines the fake native scanner prints for `--mode journal`. */
const journal = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return {
    ...original,
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      child.stdout.once("end", () => setImmediate(() => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      }));
      setImmediate(() => {
        child.stderr.end();
        child.stdout.end(journal.lines.map((line) => `${line}\n`).join(""));
      });
      return child;
    },
  };
});
// Windows maps a root to its drive's journal. Pinned, so the POSIX runs
// of this suite take the same path and record the same budget.
vi.mock("../shared/usnCursorStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/usnCursorStore")>()),
  volumeForPath: () => "C:",
}));

/** Files per fixture index: several sort runs at the test chunk size below. */
const FILES = 20_000;
/** The test's sort run size; the app's is 120,000 records. */
const SORT_CHUNK = 5_000;
const HOUR = 3_600_000;
const JOURNAL_ID = 42;

const ROOT = Path.resolve(Path.sep, "scan-root");

let dataDir: string;
let tmpDir: string;
let savedTmpEnv: Record<string, string | undefined>;
let scanStore: ScanSnapshotStore;
let baseTree: SyntheticTree;
let now: number;

beforeEach(async () => {
  dataDir = FS.realpathSync(await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-rescan-io-")));
  paths.userData = dataDir;
  // The full diff's external sort spills into OS.tmpdir().
  tmpDir = Path.join(dataDir, "tmp");
  FS.mkdirSync(tmpDir);
  savedTmpEnv = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TMPDIR = tmpDir;
  process.env.TEMP = tmpDir;
  process.env.TMP = tmpDir;

  now = Date.now();
  initScanHistory(dataDir);
  initScanIndex(dataDir);
  initFullDiffCacheStore(dataDir);
  setMaxHistoryPerRoot(7);
  __resetDiskMonitorForTests();
  seedBaselines();
  await initDiskMonitor(dataDir);
  resetCursors();
  await initUsnCursorStore(dataDir);
  scanStore = await createScanSnapshotStore(dataDir);
  baseTree = syntheticTree(ROOT, FILES);
  journal.lines = [];
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedTmpEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetDiskMonitorForTests();
  resetCursors();
  await FSP.rm(dataDir, { recursive: true, force: true });
});

/** A long-running install: disk-baselines.json's delta history is at its 500-entry cap (~113 KB). */
function seedBaselines(): void {
  const deltaHistory: DiskDelta[] = Array.from({ length: 500 }, (_, i) => ({
    drive: i % 2 === 0 ? "C:" : "D:",
    previousFreeBytes: 400_000_000_000 + i * 7_654_321,
    currentFreeBytes: 400_000_000_000 + i * 7_654_321 - 12_345_678,
    deltaBytes: -12_345_678,
    deltaPercent: -0.0012345678901234,
    measuredAt: now - (i + 1) * HOUR,
  }));
  const drive = (name: string) => ({
    drive: name,
    totalBytes: 1e12,
    freeBytes: 4e11,
    usedBytes: 6e11,
    usedPercent: 60,
    timestamp: now - HOUR,
  });
  FS.writeFileSync(Path.join(dataDir, "disk-baselines.json"), JSON.stringify({
    previousDrives: { "C:": drive("C:"), "D:": drive("D:") },
    lastFullScanAt: now - 6 * HOUR,
    lastDrives: [drive("C:"), drive("D:")],
    lastDeltas: [],
    lastCheckedAt: now - HOUR,
    deltaHistory,
  }, null, 2));
}

/** A small Dev Artifacts sidecar, as the scanner leaves next to each index. */
function writeDevSidecar(filePath: string): void {
  const roots = Array.from({ length: 200 }, (_, i) => ({
    path: Path.join(ROOT, "Users", "someone", "Projects", `workspace-${i}`, "node_modules"),
    kind: "node_modules",
    size: 250_000_000 + i,
    files: 12_000 + i,
  }));
  FS.writeFileSync(filePath, JSON.stringify({ version: 1, rootPath: ROOT, roots }));
}

/**
 * Seven completed scans of ROOT, oldest first, each with its index,
 * both sidecars and the full diff against the scan before it: the
 * steady state after a week of daily scans, where every new history
 * entry pushes the oldest out. The newest scan's snapshot is the one
 * buildSnapshotFromIndex makes from its index, as an incremental tick
 * would have saved it.
 */
async function seedHistoryAtCap(): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) {
    const finishedAt = now - (7 - i) * 6 * HOUR;
    const id = (await saveScanToHistory({
      ...completedScanSnapshot(ROOT, finishedAt),
      filesVisited: FILES,
      bytesSeen: 1e12 + i,
    }))!;
    writeSyntheticIndex(indexFilePath(id), baseTree);
    writeSyntheticFolderTreeSidecar(folderTreeSidecarPath(id), baseTree);
    writeDevSidecar(devArtifactsSidecarPath(id));
    const previous = ids.at(-1);
    if (previous) {
      await writeFullDiffCache({
        baselineId: previous,
        currentId: id,
        totalChanges: 0,
        totalAdded: 0,
        totalRemoved: 0,
        totalGrew: 0,
        totalShrank: 0,
        totalBytesAdded: 0,
        totalBytesRemoved: 0,
        changes: [],
        truncated: false,
      }, 1000);
    }
    ids.push(id);
  }
  expect(getScanHistory(ROOT)).toHaveLength(7);
  return ids;
}

function journalRecord(filePath: string, op: string, size: number | null, mtime: number, identity = { fileRef: 1, usn: 3 }) {
  return JSON.stringify({
    type: "journal-record",
    op,
    path: filePath,
    fileRef: identity.fileRef,
    parentRef: 2,
    usn: identity.usn,
    reasonMask: 0,
    timestamp: mtime,
    ...(size === null ? {} : { size }),
    mtime,
    isDirectory: false,
  });
}

function journalCursor(records: number, dropped = 0) {
  return JSON.stringify({
    type: "journal-cursor",
    cursor: 2_000_000,
    journalId: JOURNAL_ID,
    recordsEmitted: records,
    recordsDropped: dropped,
  });
}

async function saveCursor(): Promise<void> {
  await setCursor({ volume: "C:", cursor: 1_000_000, journalId: JOURNAL_ID, capturedAt: now - 6 * HOUR, rootPath: ROOT });
}

function incrementalDeps(overrides: Partial<IncrementalRescanDeps> = {}) {
  const calls = { warmFullDiff: 0, onCommitted: 0, published: [] as ScanSnapshot[] };
  const deps: IncrementalRescanDeps = {
    scannerPath: "diskhound-native-scanner",
    publishSnapshot: async (snapshot, options) => {
      calls.published.push(snapshot);
      await scanStore.set(snapshot, options);
    },
    markFullScan,
    loadSnapshot: loadHistoricalSnapshot,
    warmFullDiff: () => { calls.warmFullDiff += 1; },
    onCommitted: () => { calls.onCommitted += 1; },
    onPruned: () => {},
    log: () => {},
    ...overrides,
  };
  return { deps, calls };
}

describe("scheduled full scan", () => {
  it("commits a finished scan at the 7-scan history cap", async () => {
    const ids = await seedHistoryAtCap();
    const settingsStore = await createSettingsStore();
    // What the native scanner leaves behind: the index and both sidecars
    // under a pending name. Its own writes are not counted here.
    const pending = {
      indexPath: indexFilePath("pending-full"),
      folderTreePath: folderTreeSidecarPath("pending-full"),
      devArtifactsPath: devArtifactsSidecarPath("pending-full"),
    };
    writeSyntheticIndex(pending.indexPath, syntheticTree(ROOT, FILES, 2));
    writeSyntheticFolderTreeSidecar(pending.folderTreePath, syntheticTree(ROOT, FILES, 2));
    writeDevSidecar(pending.devArtifactsPath);
    const snapshot = completedScanSnapshot(ROOT, now);

    // handleRuntimeMessage's done path, in order. The full-diff warm is
    // its own scenario below; the USN cursor capture runs on NTFS only.
    const { io, result } = await measureFsIo(async () => {
      const committed = await commitCompletedScan(snapshot, pending, { log: () => {} });
      await scanStore.set(snapshot);
      markFullScan();
      await settingsStore.set(settingsWithRecentScan(settingsStore.get(), snapshot, "scheduled"));
      return committed;
    });

    expectIoBudget({
      scenario: "scheduled-full-scan",
      note: "a scheduled full scan's commit at the 7-scan cap: the history snapshot (~2.7 MB) and index, 3 renames of the scanner's pending files, last-scan.json (the same ~2.7 MB again), disk-baselines.json, settings.json, and the pruned scan's 5 files (was 6: its folder-tree sidecar was unlinked twice). ~5.6 MB here; the Rust scanner also writes the index (~330 MB at 7M files) and folder-tree sidecar (~50 MB), so ~385 MB per scan: 4/day and ~1.5 GB/day at the 6 h default, up to 1,440/day and ~555 GB/day at the 1-minute minimum. The full-diff warm after it is its own scenario",
      io,
    });
    expect(result.prunedIds).toEqual([ids[0]]);
    expect(FS.existsSync(indexFilePath(result.historyId!))).toBe(true);
    expect(FS.existsSync(indexFilePath(ids[0]!))).toBe(false);
  });
});

describe("scheduled USN rescan (Windows)", () => {
  /** Activity elsewhere on the volume, and a close under the root with no change. */
  function quietJournal(): string[] {
    const first = baseTree.files[0]!;
    return [
      journalRecord(Path.resolve(Path.sep, "elsewhere", "pagefile.sys"), "modify", 8_589_934_592, now),
      journalRecord(first.path, "close", first.size, first.mtime),
      journalCursor(2),
    ];
  }

  it("costs nothing when the journal has no changes under the root", async () => {
    const ids = await seedHistoryAtCap();
    await saveCursor();
    journal.lines = quietJournal();
    const { deps, calls } = incrementalDeps();

    const { io, result } = await measureFsIo(() => runIncrementalRescan(ROOT, deps));

    expectIoBudget({
      scenario: "usn-tick-no-changes",
      note: "a USN tick with no changes under the root: 0 writes, 1 read of the latest snapshot to restamp it in memory; last-scan.json, disk-baselines.json and the cursor wait for the quit flush. Was a whole-index rewrite (~330 MB at 7M files), a new history entry and last-scan.json (~2.3 MB each), both sidecars copied (~50 MB), disk-baselines.json and the cursor, and a real scan pruned from history: ~385 MB per no-op tick, ~1.5 GB/day at the 6 h default and ~555 GB/day at the 1-minute minimum",
      io,
    });
    expect(result).toMatchObject({ changed: false });
    expect(getScanHistory(ROOT).map((entry) => entry.id)).toEqual([...ids].reverse());
    expect(FS.readdirSync(Path.join(dataDir, "scan-indexes")).filter((name) => name.startsWith("pending-"))).toEqual([]);
    expect(calls).toMatchObject({ warmFullDiff: 0, onCommitted: 0 });
    // The UI still hears about the check, restamped.
    expect(calls.published).toHaveLength(1);
    expect(calls.published[0]!.finishedAt).toBeGreaterThanOrEqual(now);
    expect((await scanStore.get()).finishedAt).toBe(calls.published[0]!.finishedAt);
    expect(getCursor("C:")?.cursor).toBe(2_000_000);
  });

  it("preserves the saved index when a live file's journal lookup was dropped", async () => {
    const ids = await seedHistoryAtCap();
    await saveCursor();
    const previousIndex = indexFilePath(ids.at(-1)!);
    const previousBytes = FS.readFileSync(previousIndex);
    // A create/modify/rename record whose file could not be opened by ID:
    // native emits no delete, and reports the unresolved operation instead.
    journal.lines = [journalCursor(0, 1)];
    const { deps, calls } = incrementalDeps();

    const { io, result } = await measureFsIo(() => runIncrementalRescan(ROOT, deps));

    expectIoBudget({
      scenario: "usn-tick-unresolved-file",
      note: "an unresolved current-file lookup is reported as dropped, never as a delete: preserve the index and history, with 1 snapshot read and 0 writes (0 writes/day and 0 MB/day at both the 6 h default and the 1-minute minimum; deferred session flushes use the existing quit budget). The manual probe requests a full rescan on dropped records",
      io,
    });
    expect(result).toMatchObject({ changed: false, stats: { recordsDropped: 1, deletions: 0 } });
    expect(getScanHistory(ROOT).map((entry) => entry.id)).toEqual([...ids].reverse());
    expect(FS.readFileSync(previousIndex)).toEqual(previousBytes);
    expect(calls).toMatchObject({ warmFullDiff: 0, onCommitted: 0 });
    expect(calls.published[0]?.filesVisited).toBe(FILES);
  });

  it("writes an hour of no-op ticks once, at quit", async () => {
    await seedHistoryAtCap();
    await saveCursor();
    journal.lines = quietJournal();
    const { deps, calls } = incrementalDeps();

    // The 1-minute minimum interval, then before-quit's flushes.
    const { io } = await measureFsIo(async () => {
      for (let tick = 0; tick < 60; tick++) await runIncrementalRescan(ROOT, deps);
      flushDiskMonitor();
      scanStore.flush();
      flushUsnCursorStore();
    });

    expectIoBudget({
      scenario: "usn-ticks-hour-min-interval-then-quit",
      note: "60 no-op USN ticks at the 1-minute minimum, then before-quit's flushes: 3 writes per session (last-scan.json ~2.7 MB, disk-baselines.json ~113 KB, usn-cursors.json). Was 60 × ~385 MB at 7M files, ~23 GB an hour",
      io,
    });
    expect(calls.published).toHaveLength(60);
    const saved = JSON.parse(FS.readFileSync(Path.join(dataDir, "last-scan.json"), "utf8")) as ScanSnapshot;
    expect(saved.finishedAt).toBe(calls.published.at(-1)!.finishedAt);
    const cursors = JSON.parse(FS.readFileSync(Path.join(dataDir, "usn-cursors.json"), "utf8"));
    expect(cursors.cursors["C:"].cursor).toBe(2_000_000);
  });

  it("keeps the old index when the journal's records match nothing in it", async () => {
    const ids = await seedHistoryAtCap();
    await saveCursor();
    const same = baseTree.files[1]!;
    journal.lines = [
      // A write that left size and mtime as the index has them.
      journalRecord(same.path, "modify", same.size, same.mtime),
      // A file the index never listed, gone again.
      journalRecord(Path.join(ROOT, "Users", "someone", "AppData", "Local", "Temp", "~tmp1.tmp"), "delete", null, now),
      journalCursor(2),
    ];
    const { deps } = incrementalDeps();

    const { io, result } = await measureFsIo(() => runIncrementalRescan(ROOT, deps));

    expectIoBudget({
      scenario: "usn-tick-records-match-nothing",
      note: "journal records under the root that leave the index as it was (a write that kept size and mtime, a delete of a file it never listed): the new index is streamed, found identical and deleted, so 1 index write (~330 MB at 7M files) and nothing committed. Used to save a history entry, copy both sidecars and prune a real scan too",
      io,
    });
    expect(result).toMatchObject({ changed: false });
    expect(getScanHistory(ROOT).map((entry) => entry.id)).toEqual([...ids].reverse());
    expect(FS.readdirSync(Path.join(dataDir, "scan-indexes")).filter((name) => name.startsWith("pending-"))).toEqual([]);
  });

  it("removes deleted and renamed paths from the committed index", async () => {
    const ids = await seedHistoryAtCap();
    await saveCursor();
    const [gone, old, reused] = baseTree.files;
    const renamedPath = Path.join(ROOT, "renamed.bin");
    journal.lines = [
      journalRecord(gone!.path, "delete", null, now, { fileRef: 1, usn: 10 }),
      journalRecord(old!.path, "delete", null, now, { fileRef: 2, usn: 20 }),
      journalRecord(renamedPath, "rename", old!.size, old!.mtime, { fileRef: 2, usn: 21 }),
      // Grouping by file reference can put an older removal after the
      // current file at a reused path. USN, not output order, must win.
      journalRecord(reused!.path, "create", reused!.size, reused!.mtime, { fileRef: 3, usn: 30 }),
      journalRecord(reused!.path, "delete", null, now, { fileRef: 4, usn: 5 }),
      journalCursor(5),
    ];
    const { deps, calls } = incrementalDeps();
    const { io, result } = await measureFsIo(() => runIncrementalRescan(ROOT, deps));

    expectIoBudget({
      scenario: "usn-tick-delete-and-rename",
      note: "one delete and one rename, including an older delete at a reused path: 5 writeFile calls and 1 index stream, the same persistence as an existing changed tick, with 2 sidecar links and history pruning. At 7M files ~335 MB/tick: 24 content writes/day and ~1,340 MB/day at the 6 h default; 8,640 content writes/day and ~482,400 MB/day at the 1-minute minimum if every tick changes files. No per-record writes added; this records the existing whole-index rewrite cost",
      io,
    });
    expect(result).toMatchObject({ changed: true, stats: { additions: 1, modifications: 0, deletions: 2 } });
    expect(calls).toMatchObject({ onCommitted: 1, warmFullDiff: 1 });
    const newest = getScanHistory(ROOT)[0]!;
    expect(newest.id).not.toBe(ids.at(-1));
    const entries = gunzipSync(FS.readFileSync(indexFilePath(newest.id))).toString("utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as { p: string; s?: number; t?: string });
    const files = new Map(entries.filter((entry) => entry.t !== "d").map((entry) => [normPath(entry.p), entry]));
    expect(files.size).toBe(FILES - 1);
    expect(files.has(normPath(gone!.path))).toBe(false);
    expect(files.has(normPath(old!.path))).toBe(false);
    expect(files.get(normPath(renamedPath))?.s).toBe(old!.size);
    expect(files.get(normPath(reused!.path))?.s).toBe(reused!.size);
    expect(calls.published[0]?.filesVisited).toBe(FILES - 1);
    expect(getCursor("C:")?.cursor).toBe(2_000_000);
  });

  it.each([
    { emitted: 0, dropped: 1, changed: true },
    { emitted: 1, dropped: 0, changed: true },
    { emitted: 0, dropped: 0, changed: false },
  ])("manual probe with $emitted emitted and $dropped dropped records", async ({ emitted, dropped, changed }) => {
    await saveCursor();
    journal.lines = [
      ...(emitted ? [journalRecord(baseTree.files[0]!.path, "delete", null, now)] : []),
      journalCursor(emitted, dropped),
    ];
    const { io, result } = await measureFsIo(() => checkUsnForAnyChanges("diskhound-native-scanner", ROOT));
    expectIoBudget({
      scenario: "usn-manual-probe",
      note: "manual USN probe, including dropped records whose paths cannot be ruled outside the root: 0 writes and 0 MB/day at both the 6 h default and the 1-minute minimum; an uncertain probe requests a full scan",
      io,
    });
    expect(result).toMatchObject({ changed, recordCount: emitted });
  });

  it("rewrites the index when files under the root changed", async () => {
    await seedHistoryAtCap();
    await saveCursor();
    const [grew, shrank, gone] = baseTree.files;
    journal.lines = [
      journalRecord(grew!.path, "modify", grew!.size + 1_048_576, now),
      journalRecord(shrank!.path, "modify", 4096, now),
      journalRecord(gone!.path, "delete", null, now),
      journalRecord(Path.join(ROOT, "Users", "someone", "Downloads", "installer.exe"), "create", 150_000_000, now),
      journalCursor(4),
    ];
    const { deps } = incrementalDeps();

    const { io, result } = await measureFsIo(() => runIncrementalRescan(ROOT, deps));

    expectIoBudget({
      scenario: "usn-tick-small-change",
      note: "a USN tick with 4 changed files: the whole index rewritten (~330 MB at 7M files), the history snapshot and last-scan.json (~2.3 MB each), both sidecars hard-linked (0 B, was ~50 MB of copies), disk-baselines.json and the cursor, and a real scan pruned from history. ~335 MB per tick: ~1.3 GB/day at the 6 h default, ~480 GB/day at the 1-minute minimum if every tick finds a change",
      io,
    });
    expect(result).toMatchObject({ changed: true, stats: { additions: 1, modifications: 2, deletions: 1 } });
  });
});

describe("full diff after a scan", () => {
  /** Two scans of ROOT, the second with a day's worth of change. */
  async function seedPair(): Promise<{ baselineId: string; currentId: string }> {
    const baselineId = (await saveScanToHistory({
      ...completedScanSnapshot(ROOT, now - 6 * HOUR),
      bytesSeen: 1e12,
    }))!;
    writeSyntheticIndex(indexFilePath(baselineId), baseTree);
    const changed = syntheticTree(ROOT, FILES);
    changed.files = changed.files
      .filter((_, i) => i % 97 !== 0)
      .map((file, i) => (i % 53 === 0 ? { ...file, size: file.size + 65_536 } : file));
    changed.files.push(...syntheticTree(Path.join(ROOT, "Users", "someone", "Downloads"), 150, 9).files);
    const currentId = (await saveScanToHistory({
      ...completedScanSnapshot(ROOT, now),
      bytesSeen: 1e12 + 123_456_789,
    }))!;
    writeSyntheticIndex(indexFilePath(currentId), changed);
    return { baselineId, currentId };
  }

  function loader(failing = false) {
    const compute = (input: Parameters<typeof computeFullDiffFromIndexFiles>[0]) =>
      computeFullDiffFromIndexFiles({ ...input, sortChunkRecords: SORT_CHUNK });
    // A diff that spills both indexes and then fails, in the worker and
    // again inline, like one that runs the temp volume out of space.
    const spillThenFail = async (input: Parameters<typeof computeFullDiffFromIndexFiles>[0]) => {
      await compute(input);
      throw new Error("ENOSPC: no space left on device");
    };
    return createFullDiffLoader({
      loadSnapshot: loadHistoricalSnapshot,
      runWorker: failing ? spillThenFail : compute,
      computeInline: failing ? spillThenFail : compute,
      log: () => {},
    });
  }

  it("spills both indexes to the temp dir to warm the latest pair", async () => {
    await seedPair();

    const { io, result } = await measureFsIo(() => loader().warmLatest(ROOT));

    expectIoBudget({
      scenario: "full-diff-warm",
      note: "the latest pair's full diff, warmed after every scan whose totals moved: both indexes sorted into runs spilled to OS.tmpdir() as uncompressed JSONL, ~265 B per file per side (the path twice). 8 runs and 10.6 MB here; 59 runs per side and ~3.7 GB per scan at 7M files, ~15 GB/day at the 6 h default. Plus a ~150 KB full-diff-cache entry, and 2 stats for the failed-diff check",
      io,
    });
    expect(result?.totalChanges).toBeGreaterThan(0);
    expect(FS.readdirSync(tmpDir)).toEqual([]);
  });

  it("does not recompute a diff that failed until an index changes", async () => {
    const { baselineId, currentId } = await seedPair();
    const diffs = loader(true);
    expect(await diffs.warmLatest(ROOT)).toBeNull();

    // The user opens Changes and asks for the same pair.
    const { io, result } = await measureFsIo(() => diffs.load(baselineId, currentId, 1000));

    expectIoBudget({
      scenario: "full-diff-retry-after-failure",
      note: "asking again for a pair whose diff failed in the worker and inline: 2 stats and 0 writes, since the failure is remembered against both indexes' size and mtime. Was both spills again, 2 × 10.6 MB here and ~7.4 GB at 7M files per retry",
      io,
    });
    expect(result).toBeNull();
    expect(FS.readdirSync(tmpDir)).toEqual([]);
  });

  it("tries a failed diff again when an index changes or the user asks", async () => {
    const { baselineId, currentId } = await seedPair();
    let attempts = 0;
    let fail = true;
    const diffs = createFullDiffLoader({
      loadSnapshot: loadHistoricalSnapshot,
      runWorker: async (input) => {
        attempts += 1;
        if (fail) throw new Error("worker out of memory");
        return computeFullDiffFromIndexFiles({ ...input, sortChunkRecords: SORT_CHUNK });
      },
      computeInline: async () => {
        throw new Error("main thread out of memory");
      },
      log: () => {},
    });

    expect(await diffs.load(baselineId, currentId, 1000)).toBeNull();
    expect(await diffs.load(baselineId, currentId, 1000)).toBeNull();
    expect(attempts).toBe(1);
    // The Retry button: the user asked, so it runs again.
    expect(await diffs.load(baselineId, currentId, 1000, { retryFailed: true })).toBeNull();
    expect(attempts).toBe(2);

    // The current index is rewritten, say by a scan that was still
    // finishing: the pair is worth another try.
    fail = false;
    writeSyntheticIndex(indexFilePath(currentId), syntheticTree(ROOT, FILES, 3));
    FS.utimesSync(indexFilePath(currentId), new Date(now + HOUR), new Date(now + HOUR));
    expect((await diffs.load(baselineId, currentId, 1000))?.totalChanges).toBeGreaterThan(0);
    expect(attempts).toBe(3);
  });
});
