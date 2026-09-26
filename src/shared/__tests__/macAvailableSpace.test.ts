import * as FS from "node:fs";
import * as Path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetDiskMonitorForTests, checkDiskDeltas, getDiskDeltaHistory, withMacAvailableSpace,
} from "../diskMonitor";
import {
  buildStorageAccountingReport, getStorageAccounting, getVolumeStorageAccounting,
  parseVolumeCapacityJson, type StorageAccountingDeps,
} from "../macStorageAccounting";

const capacityJson = FS.readFileSync(Path.join(__dirname, "fixtures/macStorage/volume-capacity.json"), "utf8");
const report = buildStorageAccountingReport({
  platform: "darwin", volumePath: "/", checkedAt: 42,
  apfsSnapshots: [], tmutilSnapshotNames: [], info: null, containers: null,
  capacity: parseVolumeCapacityJson(capacityJson),
});
const drive = {
  drive: "/", totalBytes: 1_995_165_736_960, freeBytes: 112_000_000_000,
  usedBytes: 1_883_165_736_960, usedPercent: 94.4, timestamp: 50,
};

afterEach(() => { __resetDiskMonitorForTests(); vi.restoreAllMocks(); });

describe("macOS Available mapping", () => {
  it("maps the Foundation fixture without changing df counters or subtracting samples taken at different times", () => {
    expect(withMacAvailableSpace(drive, report)).toEqual({
      ...drive, availableBytes: 181_609_421_575, purgeableBytes: 68_940_589_831,
    });
  });

  it("falls back to raw free for missing/invalid capacity, another volume, or another platform", () => {
    for (const patch of [
      { availableForImportantUsageBytes: null }, { availableForImportantUsageBytes: NaN },
      { availableForImportantUsageBytes: -1 }, { volumePath: "/Volumes/Other" },
      { platform: "linux" as const }, { platform: "win32" as const },
    ]) expect(withMacAvailableSpace(drive, { ...report, ...patch })).toBe(drive);
  });

  it("accepts zero, bounds capacity and keeps unknown purgeable unknown", () => {
    expect(withMacAvailableSpace(drive, { ...report, availableForImportantUsageBytes: 0, purgeableBytes: null }))
      .toEqual({ ...drive, availableBytes: 0 });
    expect(withMacAvailableSpace(drive, { ...report, availableForImportantUsageBytes: 3e12, purgeableBytes: 4e12 }))
      .toMatchObject({ availableBytes: drive.totalBytes, purgeableBytes: drive.totalBytes });
  });

  it("ignores purgeable swings in change history but still records raw free-space changes", async () => {
    await checkDiskDeltas(async () => [drive]); // Includes compatibility with old persisted baselines.
    const enriched = withMacAvailableSpace(drive, report);
    expect((await checkDiskDeltas(async () => [enriched])).deltas).toEqual([]);
    expect((await checkDiskDeltas(async () => [{ ...enriched, availableBytes: 700e9, purgeableBytes: 588e9 }])).deltas).toEqual([]);
    const next = await checkDiskDeltas(async () => [{ ...enriched, freeBytes: drive.freeBytes - 5e9 }]);
    expect(next.deltas[0]?.deltaBytes).toBe(-5e9);
    expect(getDiskDeltaHistory()).toHaveLength(1);
  });
});

describe("shared storage accounting cache", () => {
  it("coalesces polls and card requests, refreshes once per minute, and permits a fresh check after deletion", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    let time = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => time);
    const run = vi.fn(async (command: string) => command.endsWith("osascript") ? capacityJson : null);
    const deps: StorageAccountingDeps = { platform: "darwin", run, exists: () => false };
    const mount = "/Volumes/Cache Test";
    const first = getVolumeStorageAccounting(mount, {}, deps);
    expect(getStorageAccounting(`${mount}/folder`)).toBe(first);
    await first;
    for (let i = 1; i < 6; i++) {
      time += 10_000;
      expect(getVolumeStorageAccounting(mount, {}, deps)).toBe(first);
    }
    expect(run).toHaveBeenCalledTimes(5);
    time += 10_000;
    const renewed = getVolumeStorageAccounting(mount, {}, deps);
    expect(renewed).not.toBe(first);
    await renewed;
    expect(run).toHaveBeenCalledTimes(10);
    time += 2_000;
    const fresh = getVolumeStorageAccounting(mount, { fresh: true }, deps);
    expect(getStorageAccounting(mount, { fresh: true })).toBe(fresh);
    await fresh;
    expect(run).toHaveBeenCalledTimes(15);
  });

  it("queries an exact nonstandard mount instead of silently reading the startup disk", async () => {
    const run = vi.fn(async () => null);
    const result = await getVolumeStorageAccounting("/mnt/archive", {}, {
      platform: "darwin", run, exists: () => true,
    });
    expect(result.volumePath).toBe("/mnt/archive");
    expect(run.mock.calls).toContainEqual(["/usr/sbin/diskutil", ["info", "-plist", "/mnt/archive"], 8_000]);
  });
});
