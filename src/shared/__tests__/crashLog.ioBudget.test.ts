import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { CRASH_LOG_FLUSH_DELAY_MS, createCrashLog, formatRendererError, type CrashLog } from "../crashLog";
import { createMemoryDiagnostics, type MemorySample } from "../memoryDiagnostics";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));

const MB = 1024 * 1024;
const MINUTE = 60_000;

let userData = "";
const logPath = () => Path.join(userData, "crash.log");
const readLog = () => FS.readFileSync(logPath(), "utf8");

/**
 * A launched app's log. The first flush of a process stats crash.log
 * once to learn its size; that happens during startup, so it is done
 * here and the scenarios measure the steady state.
 */
function launchedLog(): CrashLog {
  const log = createCrashLog({ path: logPath });
  log.write("startup", "whenReady fired");
  return log;
}

/** main.ts's memory line, at the given main-process footprint. */
function memorySample(rssMb: number, heapUsedMb: number, caches = "0/0/0/0/0"): MemorySample {
  return {
    rssBytes: rssMb * MB,
    heapUsedBytes: heapUsedMb * MB,
    caches,
    text: `rss=${rssMb} MB heapUsed=${heapUsedMb} MB heapTotal=${heapUsedMb + 40} MB external=12 MB arrayBuffers=3 MB`
      + " | folderTree: 0 trees, 0 entries | folderTreePages: 0 pages, 0 nodes, ~0 MB"
      + " | treemapCache: 0 entries, 0 inflight | fullDiffMem: 0 entries",
  };
}

/**
 * The native scanner's stderr for a scan of 1,000 folders it cannot
 * read plus 20 files, recorded from the debug build on macOS with
 * every folder `chmod 000`. Unreadable folders are counted in
 * `skipped=`; no line names them. The Windows walkers do the same:
 * a failed FindFirstFileExW sends `Skipped` and returns Ok.
 */
const UNREADABLE_SCAN_STDERR = [
  "[diskhound-native-scanner] linux: walking with jwalk, 16 rayon threads",
  "[diskhound-native-scanner] linux: walk done in 10 ms (files=20, dirs=1001, skipped=1000, foreign_mounts_pruned=0, duplicate_mounts_pruned=0, firmlink_twins_pruned=0, readdir_calls=1001, stat_calls=1021)",
  "[diskhound-native-scanner] hardlinks: 0 extra links counted once (0 bytes), 0 inodes with links outside the scan",
  "[diskhound-native-scanner] phase: walk took 11 ms (files=20, dirs=1001, inherited_dirs=0, inherited_files=0, readdir_calls=1001, stat_calls=1021, baseline_bytes_read=0)",
  "[diskhound-native-scanner] folder-tree sidecar: 2 parents written to \"/Users/me/Library/Application Support/DiskHound/folder-trees/pending-3f2a.bin\" in 0 ms (parallel: 8 shards)",
];

beforeEach(async () => {
  userData = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-crash-log-io-"));
  vi.useFakeTimers({ now: new Date("2026-09-25T12:00:00Z") });
});

afterEach(async () => {
  vi.useRealTimers();
  await FSP.rm(userData, { recursive: true, force: true });
});

describe("crash.log write budget", () => {
  it("costs two appends for a scan of 1,000 unreadable folders", async () => {
    const log = launchedLog();

    const { io } = await measureFsIo(() => {
      // Walk starts: the first stderr line.
      log.write("scanner", UNREADABLE_SCAN_STDERR[0]);
      vi.advanceTimersByTime(30_000);
      // Walk ends: the rest of stderr, then main's post-scan lines.
      for (const line of UNREADABLE_SCAN_STDERR.slice(1)) log.write("scanner", line);
      log.write("memory", `post-scan /Users/me/scan-root files=20: ${memorySample(610, 240).text}`);
      log.write("folder-tree-plan", "scanId=3f2a mode=memory: 2 parents, estimate 1 MB");
      vi.advanceTimersByTime(400);
      log.write("folder-tree-sidecar-read", "scanId=3f2a lines=2 parseFailures=0 treeSize=2");
      log.write("folder-tree-sidecar-hit", "scanId=3f2a entries=2 load=3ms");
      vi.advanceTimersByTime(CRASH_LOG_FLUSH_DELAY_MS);
    });

    expectIoBudget({
      scenario: "crash-log-scan-unreadable-folders",
      note: "a 30 s scan of 1,000 unreadable folders: the scanner's 5 real stderr lines (skipped=1000 is one count; no line per folder) and main's 4 post-scan lines land in 2 appends, one per burst, ~1.5 KB. 8/day and ~6 KB/day at the 6 h rescan default; at the 1-minute minimum, up to 2,880/day and ~2 MB/day, beside the index each scan rewrites. Was 9 sync appends, 9 mkdirs and 9 stats a scan",
      io,
    });
    const text = readLog();
    expect(text).toContain("skipped=1000");
    expect(text.split("\n").filter((line) => line.includes("[scanner]"))).toHaveLength(5);
  });

  it("counts a poll that rejects every 2 s instead of writing each failure", async () => {
    const log = launchedLog();
    // What DiskIoView's reportPollFailure sends when the handler throws.
    const failure = formatRendererError({
      message: "DiskIoView poll failed: Error invoking remote method 'diskhound:get-disk-io-snapshot': Error: spawn typeperf ENOENT",
      stack: "Error: Error invoking remote method 'diskhound:get-disk-io-snapshot': Error: spawn typeperf ENOENT\n"
        + "    at IpcRenderer.invoke (node:electron/js2c/renderer_init:2:7071)\n"
        + "    at async refresh (file:///C:/Program%20Files/DiskHound/resources/app.asar/dist/assets/index-4b1c.js:40:18233)",
    });
    const polls = (10 * MINUTE) / 2_000;

    const { io } = await measureFsIo(() => {
      for (let poll = 0; poll < polls; poll++) {
        log.write("renderer", failure);
        vi.advanceTimersByTime(2_000);
      }
    });

    expectIoBudget({
      scenario: "crash-log-renderer-poll-rejecting",
      note: "DiskIoView's 2 s poll rejecting for 10 minutes: 300 identical failures cost the first line and repeat counts at 1, 3 and 7 minutes, 4 appends, ~1 KB. Count windows double up to an hour, so a poll that fails all day costs ~30 appends/day and ~7 KB/day whatever its rate. Was one sync append, mkdir and stat per failure: 43,200 of each a day at 2 s",
      io,
    });
    log.flushAll();
    const text = readLog();
    const repeats = [...text.matchAll(/repeated (\d+) more times?/g)].map((match) => Number(match[1]));
    expect(text.split("DiskIoView poll failed").length - 1).toBe(1 + repeats.length);
    expect(repeats.reduce((sum, count) => sum + count, 0)).toBe(polls - 1);
  });

  it("writes one heartbeat in an idle hour", async () => {
    const log = launchedLog();
    // GC sawtooth: a few MB either way, well inside the move threshold.
    const drift = [0, 3, -2, 5, 1, -4, 2, 6, -1, 3, 0, -3];
    let tick = 0;
    const diagnostics = createMemoryDiagnostics({
      sample: () => {
        const offset = drift[tick++ % drift.length];
        return memorySample(420 + offset, 150 + offset);
      },
      isScanning: () => false,
      write: log.write,
    });
    diagnostics.start();
    log.flush();

    const { io } = await measureFsIo(() => {
      vi.advanceTimersByTime(60 * MINUTE + CRASH_LOG_FLUSH_DELAY_MS);
    });
    diagnostics.stop();

    expectIoBudget({
      scenario: "crash-log-idle-hour",
      note: "an hour in the tray with memory flat: 12 samples 5 minutes apart log only the hourly heartbeat, 1 append, ~250 bytes. 24/day and ~6 KB/day; no setting changes the idle cadence. Was 12 lines, each a sync append, mkdir and stat: 288 of each a day",
      io,
    });
    expect(readLog().match(/\[memory\]/g)).toHaveLength(2);
  });

  it("logs memory during a scan only when it moves", async () => {
    const log = launchedLog();
    let scanning = false;
    let minutes = 0;
    const diagnostics = createMemoryDiagnostics({
      // Worst case: main's footprint climbs the whole hour, 20 MB/min of
      // RSS and 8 MB/min of heap, as it does while the JS worker scans.
      sample: () => memorySample(450 + 20 * minutes, 180 + 8 * minutes),
      isScanning: () => scanning,
      write: log.write,
    });
    diagnostics.start();
    log.flush();

    const { io } = await measureFsIo(() => {
      scanning = true;
      diagnostics.retune();
      log.write("scanner", "[diskhound-native-scanner] baseline accepted: dirs=812004 file_records=6921877 (ratio 8.52)");
      log.write("scanner", "[diskhound-native-scanner] phase: baseline load took 4210 ms (loaded=true, dirs=812004, bytes_read=388110231)");
      log.write("scanner", "[diskhound-native-scanner] parallel: walking with 16 workers (baseline_can_inherit=true)");
      for (minutes = 1; minutes <= 60; minutes++) vi.advanceTimersByTime(MINUTE);
      log.write("scanner", "[diskhound-native-scanner] parallel: walk complete in 3597000 ms, mtime syscalls saved via enum-hint: 204118");
      log.write("scanner", "[diskhound-native-scanner] phase: walk took 3601210 ms (files=6921877, dirs=812004, inherited_dirs=0, inherited_files=0, readdir_calls=812004, stat_calls=0, baseline_bytes_read=388110231)");
      vi.advanceTimersByTime(CRASH_LOG_FLUSH_DELAY_MS);
    });
    diagnostics.stop();

    expectIoBudget({
      scenario: "crash-log-scanning-hour",
      note: "an hour-long scan with main's memory climbing 20 MB/min: 60 samples a minute apart log 12 lines, one each time RSS or heap moves 10% (32 MB floor), plus the scanner's start and end bursts, 14 appends, ~4 KB. With memory flat the hour logs 1 sample. Scanning all day, the 1-minute rescan worst case, is 336/day and ~94 KB/day; at the 6 h default scans take minutes. Was 65 sync appends, mkdirs and stats",
      io,
    });
    expect(readLog().match(/\[memory-scanning\]/g)).toHaveLength(12);
  });
});
