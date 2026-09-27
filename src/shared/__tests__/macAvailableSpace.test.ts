import * as FS from "node:fs";
import * as Path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetDiskMonitorForTests, checkDiskDeltas, enrichMacDiskSpace, getDiskDeltaHistory, withMacAvailableSpace,
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

afterEach(() => { __resetDiskMonitorForTests(); vi.useRealTimers(); vi.restoreAllMocks(); });

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
  it("bounds drive enrichment and retains a stalled collection past both timeout and cache expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let finishCapacity!: (value: string | null) => void;
    const stalledCapacity = new Promise<string | null>((resolve) => { finishCapacity = resolve; });
    // Models a command that outlives execFile's SIGTERM: its callback has
    // not fired, even after the 8 s command timeout and 60 s cache TTL.
    const run = vi.fn((command: string) => command.endsWith("osascript")
      ? stalledCapacity : Promise.resolve(null));
    const deps: StorageAccountingDeps = { platform: "darwin", run, exists: () => false };
    const stalled = { ...drive, drive: "/Volumes/Stalled capacity" };
    const first = getVolumeStorageAccounting(stalled.drive, {}, deps);
    const readAccounting = (mount: string) => mount === drive.drive
      ? Promise.resolve(report) : getVolumeStorageAccounting(mount, {}, deps);
    let settled = false;
    const result = enrichMacDiskSpace([drive, stalled], readAccounting).then((rows) => {
      settled = true;
      return rows;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const rows = await result;
    expect(rows).toEqual([withMacAvailableSpace(drive, report), stalled]);
    expect(rows[1]).toBe(stalled);

    await vi.advanceTimersByTimeAsync(61_000);
    expect(getVolumeStorageAccounting(stalled.drive, {}, deps)).toBe(first);
    expect(getVolumeStorageAccounting(stalled.drive, { fresh: true }, deps)).toBe(first);
    const latestRaw = { ...stalled, freeBytes: stalled.freeBytes + 5e9, timestamp: Date.now() };
    const poll = enrichMacDiskSpace([drive, latestRaw], readAccounting);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await poll)[1]).toBe(latestRaw);
    expect(run).toHaveBeenCalledTimes(5);

    // The late result must not mutate an already-returned raw reading.
    finishCapacity(capacityJson);
    await first;
    expect(rows[1]).not.toHaveProperty("availableBytes");
    const recovered = getVolumeStorageAccounting(stalled.drive, {}, deps);
    expect(recovered).not.toBe(first);
    await recovered;
    expect(run).toHaveBeenCalledTimes(10);
    expect((await enrichMacDiskSpace([latestRaw], readAccounting))[0]).toMatchObject({
      ...latestRaw, availableBytes: 181_609_421_575, purgeableBytes: 68_940_589_831,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back immediately when enrichment rejects, without holding healthy drives", async () => {
    vi.useFakeTimers();
    const failed = { ...drive, drive: "/Volumes/Failed capacity" };
    const rows = await enrichMacDiskSpace([drive, failed], (mount) => mount === drive.drive
      ? Promise.resolve(report) : Promise.reject(new Error("capacity unavailable")));
    expect(rows).toEqual([withMacAvailableSpace(drive, report), failed]);
    expect(vi.getTimerCount()).toBe(0);
  });

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
