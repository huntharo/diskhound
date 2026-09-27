import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { __resetDiskMonitorForTests, checkDiskDeltas, enrichMacDiskSpace, initDiskMonitor } from "../diskMonitor";
import { getVolumeStorageAccounting } from "../macStorageAccounting";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));

afterEach(() => { vi.useRealTimers(); __resetDiskMonitorForTests(); });

it.each([60, 1])("writes nothing during 10-second macOS display polling with %i-minute monitoring", async (interval) => {
  const dir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-available-io-"));
  const capacity = JSON.parse(FS.readFileSync(Path.join(__dirname, "fixtures/macStorage/volume-capacity.json"), "utf8"));
  const drive = {
    drive: `/Volumes/Budget-${interval}`, totalBytes: capacity.NSURLVolumeTotalCapacityKey,
    freeBytes: capacity.NSURLVolumeAvailableCapacityKey, usedBytes: 1_882_496_905_216,
    usedPercent: 94, timestamp: 0,
  };
  await FSP.writeFile(Path.join(dir, "disk-baselines.json"), JSON.stringify({
    previousDrives: { [drive.drive]: drive }, lastFullScanAt: null, lastDrives: [drive],
  }));
  await initDiskMonitor(dir);
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const run = vi.fn(async (command: string) => command.endsWith("osascript")
    ? JSON.stringify({ ...capacity, NSURLVolumeAvailableCapacityForImportantUsageKey: 200e9 + Date.now() * 100_000 }) : null);
  let polls = 0;
  const timer = setInterval(async () => {
    const [reading] = await enrichMacDiskSpace([drive], (mount) =>
      getVolumeStorageAccounting(mount, {}, { platform: "darwin", run, exists: () => false }));
    if (++polls % (interval * 6) === 0) {
      expect((await checkDiskDeltas(async () => [reading])).deltas).toEqual([]);
    }
  }, 10_000);
  try {
    const { io } = await measureFsIo(() => vi.advanceTimersByTimeAsync(3_600_000));
    expect(polls).toBe(360);
    expect(run).toHaveBeenCalledTimes(60 * 5);
    expectIoBudget({
      scenario: `mac-available-polling-${interval}-minute-monitor`,
      note: "One hour of 10 s display polls plus raw-free monitoring while purgeable swings: 0 writes, 0 MB. Projects 0 writes/day and 0 MB/day at both the 60-minute default and 1-minute minimum; shared in-memory accounting runs once/minute/volume. Existing dirty baseline flush remains once per quit.",
      io,
    });
  } finally {
    clearInterval(timer);
    vi.useRealTimers();
    await FSP.rm(dir, { recursive: true, force: true });
  }
});
