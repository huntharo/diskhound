import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { defaultSettings, type DiskDelta, type DiskSpaceInfo } from "../contracts";
import {
  __resetDiskMonitorForTests,
  checkDiskDeltas,
  flushDiskMonitor,
  initDiskMonitor,
  markFullScan,
  startDiskMonitoring,
} from "../diskMonitor";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));

const TB = 1_000_000_000_000;
const HOUR = 3_600_000;

let dataDir: string;
let monitor: ReturnType<typeof setInterval> | null = null;
/** Free bytes df reports per drive; tests move these between checks. */
let free: Record<string, number>;

async function readDrives(): Promise<DiskSpaceInfo[]> {
  return Object.entries(free).map(([drive, freeBytes]) => ({
    drive,
    totalBytes: TB,
    freeBytes,
    usedBytes: TB - freeBytes,
    usedPercent: ((TB - freeBytes) / TB) * 100,
    timestamp: Date.now(),
  }));
}

/** An idle machine: logs and caches move free space by less than the 1 MB noise floor. */
function idleDrift(): void {
  for (const drive of Object.keys(free)) free[drive] -= 200_000;
}

/** A long-running install: the delta history is at its 500-entry cap. */
async function seedBaselines(): Promise<void> {
  const now = Date.now();
  const drives = await readDrives();
  const deltaHistory: DiskDelta[] = Array.from({ length: 500 }, (_, i) => ({
    drive: i % 2 === 0 ? "/" : "/Volumes/Backup",
    previousFreeBytes: 400_000_000_000 + i * 7_654_321,
    currentFreeBytes: 400_000_000_000 + i * 7_654_321 - 12_345_678,
    deltaBytes: -12_345_678,
    deltaPercent: -0.0012345678901234,
    measuredAt: now - (i + 1) * HOUR,
  }));
  FS.writeFileSync(
    Path.join(dataDir, "disk-baselines.json"),
    JSON.stringify({
      previousDrives: Object.fromEntries(drives.map((drive) => [drive.drive, drive])),
      lastFullScanAt: now - 24 * HOUR,
      lastDrives: drives,
      lastDeltas: [],
      lastCheckedAt: now - HOUR,
      deltaHistory,
    }, null, 2),
  );
}

/** main.ts at startup: load the baselines, then one check to prime the UI. */
async function launch(): Promise<void> {
  await initDiskMonitor(dataDir);
  idleDrift();
  await checkDiskDeltas(readDrives);
}

/** A launch, then main.ts's restartMonitoring with this interval. */
async function startApp(checkIntervalMinutes: number): Promise<void> {
  await seedBaselines();
  await launch();
  monitor = startDiskMonitoring(
    { ...defaultSettings().monitoring, enabled: true, checkIntervalMinutes },
    {
      systemIdleSeconds: () => 0,
      onChecked: () => undefined,
      check: () => {
        idleDrift();
        return checkDiskDeltas(readDrives);
      },
    },
  );
}

beforeEach(async () => {
  dataDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-monitor-io-"));
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
  __resetDiskMonitorForTests();
  free = { "/": 400_000_000_000, "/Volumes/Backup": 700_000_000_000 };
});

afterEach(async () => {
  if (monitor) clearInterval(monitor);
  monitor = null;
  vi.useRealTimers();
  await FSP.rm(dataDir, { recursive: true, force: true });
});

describe("disk monitor", () => {
  it("writes nothing at launch when the drives match the saved baselines", async () => {
    await seedBaselines();

    const { io } = await measureFsIo(launch);

    expectIoBudget({
      scenario: "disk-monitor-launch",
      note: "initDiskMonitor plus the startup check, drives within the noise floor of the saved baselines: 1 read, 0 writes; was 1 rewrite per launch",
      io,
    });
  });

  it("writes the baselines when free space moves past the noise floor", async () => {
    await startApp(defaultSettings().monitoring.checkIntervalMinutes);

    const { io } = await measureFsIo(async () => {
      free["/"] -= 5_000_000_000;
      await checkDiskDeltas(readDrives);
    });

    expectIoBudget({
      scenario: "disk-monitor-check-with-delta",
      note: "one check that records a 5 GB drop: 1 rewrite of disk-baselines.json (~113 KB with its 500-entry history)",
      io,
    });
  });

  it("writes nothing through an idle hour at the default 60-minute interval", async () => {
    expect(defaultSettings().monitoring.checkIntervalMinutes).toBe(60);
    await startApp(60);

    const { io } = await measureFsIo(() => vi.advanceTimersByTimeAsync(HOUR));

    expectIoBudget({
      scenario: "disk-monitor-idle-hour-default-interval",
      note: "1 idle check (free space drifts < 1 MB) at the 60-minute default: 0 writes; was 1 rewrite of ~113 KB, 24/day and ~2.7 MB/day",
      io,
    });
  });

  it("writes nothing through an idle hour at the 1-minute minimum interval", async () => {
    await startApp(1);

    const { io } = await measureFsIo(() => vi.advanceTimersByTimeAsync(HOUR));

    expectIoBudget({
      scenario: "disk-monitor-idle-hour-min-interval",
      note: "60 idle checks at the 1-minute minimum: 0 writes; was 60 rewrites of ~113 KB, 1,440/day and ~166 MB/day",
      io,
    });
  });

  it("writes the latest readings once at quit after idle checks", async () => {
    await startApp(1);
    await vi.advanceTimersByTimeAsync(HOUR);

    const { io } = await measureFsIo(flushDiskMonitor);

    expectIoBudget({
      scenario: "disk-monitor-quit-after-idle",
      note: "before-quit flush after idle checks moved the baseline: 1 rewrite (~113 KB) per session",
      io,
    });
    const saved = JSON.parse(FS.readFileSync(Path.join(dataDir, "disk-baselines.json"), "utf8"));
    expect(saved.previousDrives["/"].freeBytes).toBe(free["/"]);
    expect(saved.lastCheckedAt).toBe(Date.now());
  });

  it("writes nothing at quit when the last write already holds the latest readings", async () => {
    await startApp(60);
    free["/"] -= 5_000_000_000;
    await checkDiskDeltas(readDrives);

    const { io } = await measureFsIo(flushDiskMonitor);

    expectIoBudget({
      scenario: "disk-monitor-quit-clean",
      note: "before-quit flush right after a check that wrote a delta: 0 writes",
      io,
    });
  });

  it("writes the baselines once when a full scan finishes", async () => {
    await startApp(60);

    const { io } = await measureFsIo(() => markFullScan());

    expectIoBudget({
      scenario: "disk-monitor-full-scan",
      note: "markFullScan after each completed scan: 1 rewrite of disk-baselines.json (~113 KB); 4/day at the 6 h scheduled-rescan default",
      io,
    });
  });
});
