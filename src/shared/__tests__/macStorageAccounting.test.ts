import * as FS from "node:fs";
import * as Path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildStorageAccountingReport,
  collectStorageAccounting,
  macDataVolumeFor,
  macVolumeForPath,
  parseApfsListPlist,
  parseApfsSnapshotsPlist,
  parseDiskutilInfoPlist,
  parseTmutilLocalSnapshots,
  parseTmutilSnapshotDates,
  parseVolumeCapacityJson,
  snapshotCreatedAtFromName,
  snapshotKindForName,
  SNAPSHOT_SIZE_NOTE,
  type CommandRunner,
} from "../macStorageAccounting";

// Captured on macOS 26.6.1 (M-series, FileVault on, one local Time
// Machine snapshot). Volume / snapshot UUIDs replaced with
// 00000000-0000-4000-8000-0000000000NN; SMART counters dropped.
const FIXTURES = Path.join(__dirname, "fixtures", "macStorage");
const fixture = (name: string) => FS.readFileSync(Path.join(FIXTURES, name), "utf8");

const TM_NAME = "com.apple.TimeMachine.2026-09-24-003521.local";
const TM_AT = new Date(2026, 8, 24, 0, 35, 21).getTime();

describe("tmutil parsers", () => {
  it("lists snapshot names from `tmutil listlocalsnapshots /`", () => {
    expect(parseTmutilLocalSnapshots(fixture("tmutil-listlocalsnapshots.txt"))).toEqual([TM_NAME]);
  });

  it("handles several snapshots, no header and error chatter", () => {
    const stdout = [
      "com.apple.TimeMachine.2026-09-23-120000.local",
      "com.apple.TimeMachine.2026-09-23-130000.local",
      "",
      "No such file or directory: /Volumes/Gone",
      "com.bombich.ccc.1234",
    ].join("\n");
    expect(parseTmutilLocalSnapshots(stdout)).toEqual([
      "com.apple.TimeMachine.2026-09-23-120000.local",
      "com.apple.TimeMachine.2026-09-23-130000.local",
      "com.bombich.ccc.1234",
    ]);
  });

  it("parses `tmutil listlocalsnapshotdates` as local wall-clock time", () => {
    expect(parseTmutilSnapshotDates(fixture("tmutil-listlocalsnapshotdates.txt"))).toEqual([TM_AT]);
  });

  it("derives kind and creation time from snapshot names", () => {
    expect(snapshotKindForName(TM_NAME)).toBe("time-machine");
    expect(snapshotKindForName("com.apple.os.update-ABC")).toBe("os-update");
    expect(snapshotKindForName("com.bombich.ccc.1")).toBe("other");
    expect(snapshotCreatedAtFromName(TM_NAME)).toBe(TM_AT);
    expect(snapshotCreatedAtFromName("com.apple.TimeMachine.2026-09-24-003521")).toBe(TM_AT);
    expect(snapshotCreatedAtFromName("com.bombich.ccc.1")).toBeNull();
  });
});

describe("diskutil parsers", () => {
  it("reads Time Machine snapshots on the Data volume", () => {
    expect(parseApfsSnapshotsPlist(fixture("apfs-listsnapshots-data.plist"))).toEqual([
      {
        name: TM_NAME,
        kind: "time-machine",
        createdAt: TM_AT,
        purgeable: true,
        limitsContainerShrink: true,
      },
    ]);
  });

  it("reads the sealed system volume's OS-update snapshot", () => {
    const snaps = parseApfsSnapshotsPlist(fixture("apfs-listsnapshots-root.plist"));
    expect(snaps).toHaveLength(1);
    expect(snaps![0]).toMatchObject({ kind: "os-update", purgeable: false, createdAt: null });
  });

  it("returns null for non-plist error output", () => {
    expect(parseApfsSnapshotsPlist("Could not find disk for /Volumes/NotThere")).toBeNull();
  });

  it("prefers APFS container free over the Data volume's zero FreeSpace", () => {
    expect(parseDiskutilInfoPlist(fixture("diskutil-info-data.plist"))).toEqual({
      device: "disk3s5",
      containerDevice: "disk3",
      filesystem: "apfs",
      mountPoint: "/System/Volumes/Data",
      totalBytes: 1995165736960,
      freeBytes: 112822804480,
      containerTotalBytes: 1995165736960,
      containerFreeBytes: 112822804480,
    });
  });

  it("reads containers and per-volume usage from `diskutil apfs list -plist`", () => {
    const containers = parseApfsListPlist(fixture("apfs-list.plist"))!;
    expect(containers.map((c) => c.device)).toEqual(["disk1", "disk2", "disk3", "disk5", "disk7"]);
    const main = containers.find((c) => c.device === "disk3")!;
    expect(main.totalBytes).toBe(1995165736960);
    expect(main.freeBytes).toBe(112822796288);
    expect(main.volumes.find((v) => v.roles.includes("Data"))).toEqual({
      name: "Data",
      device: "disk3s5",
      roles: ["Data"],
      usedBytes: 1835910733824,
    });
  });
});

describe("parseVolumeCapacityJson", () => {
  it("reads Foundation's capacity keys", () => {
    expect(parseVolumeCapacityJson(fixture("volume-capacity.json"))).toEqual({
      totalBytes: 1995165736960,
      availableBytes: 112668831744,
      importantUsageBytes: 181609421575,
      opportunisticUsageBytes: 120290214695,
    });
  });

  it("drops non-numeric values and rejects garbage", () => {
    expect(parseVolumeCapacityJson('{"NSURLVolumeAvailableCapacityKey":null}')).toMatchObject({
      availableBytes: null,
    });
    expect(parseVolumeCapacityJson("execution error: -1743")).toBeNull();
  });
});

describe("volume mapping", () => {
  it("maps paths to the mount Time Machine / diskutil address", () => {
    expect(macVolumeForPath("/Users/me/github")).toBe("/");
    expect(macVolumeForPath("/Volumes/Archive/photos")).toBe("/Volumes/Archive");
    expect(macVolumeForPath("/Volumes/Archive")).toBe("/Volumes/Archive");
  });

  it("uses the Data role volume for the startup disk", () => {
    expect(macDataVolumeFor("/", () => true)).toBe("/System/Volumes/Data");
    expect(macDataVolumeFor("/", () => false)).toBe("/");
    expect(macDataVolumeFor("/Volumes/X", () => true)).toBe("/Volumes/X");
  });
});

describe("buildStorageAccountingReport", () => {
  const base = {
    platform: "darwin" as const,
    volumePath: "/",
    checkedAt: 1,
    apfsSnapshots: parseApfsSnapshotsPlist(fixture("apfs-listsnapshots-data.plist")),
    tmutilSnapshotNames: parseTmutilLocalSnapshots(fixture("tmutil-listlocalsnapshots.txt")),
    info: parseDiskutilInfoPlist(fixture("diskutil-info-data.plist")),
    containers: parseApfsListPlist(fixture("apfs-list.plist")),
    capacity: parseVolumeCapacityJson(fixture("volume-capacity.json")),
  };

  it("combines free, purgeable, container and snapshots", () => {
    const report = buildStorageAccountingReport(base);
    expect(report.supported).toBe(true);
    expect(report.filesystem).toBe("apfs");
    expect(report.freeBytes).toBe(112668831744);
    expect(report.availableForImportantUsageBytes).toBe(181609421575);
    expect(report.purgeableBytes).toBe(181609421575 - 112668831744);
    expect(report.container?.device).toBe("disk3");
    expect(report.container?.volumes[0]?.name).toBe("Data");
    expect(report.snapshots.map((s) => s.name)).toEqual([TM_NAME]);
    expect(report.notes).toContain(SNAPSHOT_SIZE_NOTE);
  });

  it("falls back to tmutil names when diskutil failed, newest first", () => {
    const report = buildStorageAccountingReport({
      ...base,
      apfsSnapshots: null,
      tmutilSnapshotNames: [
        "com.apple.TimeMachine.2026-09-23-120000.local",
        "com.apple.TimeMachine.2026-09-24-120000.local",
      ],
    });
    expect(report.snapshots.map((s) => s.name)).toEqual([
      "com.apple.TimeMachine.2026-09-24-120000.local",
      "com.apple.TimeMachine.2026-09-23-120000.local",
    ]);
    expect(report.snapshots[0]?.purgeable).toBeNull();
  });

  it("adds tmutil-only names to the diskutil list without duplicates", () => {
    const report = buildStorageAccountingReport({
      ...base,
      tmutilSnapshotNames: [TM_NAME, "com.apple.TimeMachine.2026-09-24-013000.local"],
    });
    expect(report.snapshots.map((s) => s.name)).toEqual([
      "com.apple.TimeMachine.2026-09-24-013000.local",
      TM_NAME,
    ]);
  });

  it("marks non-APFS volumes unsupported and leaves purgeable unknown without capacity", () => {
    const report = buildStorageAccountingReport({
      ...base,
      apfsSnapshots: [],
      tmutilSnapshotNames: [],
      info: { ...base.info!, filesystem: "exfat", containerDevice: null },
      capacity: null,
    });
    expect(report.supported).toBe(false);
    expect(report.purgeableBytes).toBeNull();
    expect(report.container).toBeNull();
    expect(report.notes[0]).toMatch(/EXFAT/);
  });
});

describe("collectStorageAccounting", () => {
  it("runs the macOS tools against the Data volume and assembles a report", async () => {
    const calls: string[] = [];
    const run: CommandRunner = async (command, args) => {
      calls.push([command, ...args.filter((a) => !a.includes("\n"))].join(" "));
      if (command.endsWith("tmutil")) return fixture("tmutil-listlocalsnapshots.txt");
      if (command.endsWith("osascript")) return fixture("volume-capacity.json");
      if (args[0] === "info") return fixture("diskutil-info-data.plist");
      if (args[1] === "listSnapshots") return fixture("apfs-listsnapshots-data.plist");
      if (args[1] === "list") return fixture("apfs-list.plist");
      return null;
    };
    const report = await collectStorageAccounting("/Users/me", {
      platform: "darwin",
      run,
      now: () => 42,
      exists: () => true,
    });
    expect(calls).toEqual([
      "/usr/bin/tmutil listlocalsnapshots /",
      "/usr/sbin/diskutil apfs listSnapshots -plist /System/Volumes/Data",
      "/usr/sbin/diskutil info -plist /System/Volumes/Data",
      "/usr/sbin/diskutil apfs list -plist",
      "/usr/bin/osascript -l JavaScript -e /",
    ]);
    expect(report).toMatchObject({ volumePath: "/", checkedAt: 42, supported: true });
    expect(report.snapshots).toHaveLength(1);
  });

  it("survives every command failing", async () => {
    const report = await collectStorageAccounting("/", {
      platform: "darwin",
      run: async () => null,
      exists: () => true,
    });
    expect(report.supported).toBe(false);
    expect(report.snapshots).toEqual([]);
    expect(report.notes.join(" ")).toMatch(/Could not list local snapshots/);
  });

  it("is a stub on Linux and Windows", async () => {
    const run: CommandRunner = async () => {
      throw new Error("should not run");
    };
    const linux = await collectStorageAccounting("/home/me", { platform: "linux", run });
    expect(linux).toMatchObject({ platform: "linux", supported: false, snapshots: [] });
    expect(linux.notes[0]).toMatch(/btrfs \/ ZFS snapshots/);
    const win = await collectStorageAccounting("C:\\", { platform: "win32", run });
    expect(win.notes[0]).toMatch(/Volume Shadow Copies/);
  });
});
