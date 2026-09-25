import { describe, expect, it } from "vitest";

import { parseMacDfOutput, parseWindowsCimLogicalDisks } from "../diskMonitor";

describe("parseMacDfOutput", () => {
  it("keeps the startup disk and mounted user volumes", () => {
    const stdout = [
      "Filesystem   1024-blocks      Used Available Capacity Mounted on",
      "/dev/disk3s1s1 488245288  12345678 123456789    10% /",
      "/dev/disk3s5   488245288  23456789 123456789    16% /System/Volumes/Data",
      "/dev/disk4s1   976490576 400000000 576490576    41% /Volumes/Archive",
      "//nas/media    1952981152 500000000 1452981152   26% /Volumes/Media Share",
    ].join("\n");

    const drives = parseMacDfOutput(stdout, 123);

    expect(drives.map((drive) => drive.drive)).toEqual([
      "/",
      "/Volumes/Archive",
      "/Volumes/Media Share",
    ]);
    expect(drives[0]).toMatchObject({
      totalBytes: 488245288 * 1024,
      usedBytes: (488245288 - 123456789) * 1024,
      freeBytes: 123456789 * 1024,
      timestamp: 123,
    });
    // Volumes outside the startup container keep their own Used.
    expect(drives[1]).toMatchObject({
      usedBytes: 400000000 * 1024,
      freeBytes: 576490576 * 1024,
    });
  });

  it("reports container usage for the sealed root and drops OS-managed images", () => {
    // Real `df -P -k` from a 2 TB Mac that is 95% full.
    const stdout = [
      "Filesystem     1024-blocks       Used Available Capacity  Mounted on",
      "/dev/disk3s1s1  1948404040   12347096 108707764    11%    /",
      "/dev/disk3s6    1948404040   18875720 108707764    15%    /System/Volumes/VM",
      "/dev/disk3s2    1948404040   10628192 108707764     9%    /System/Volumes/Preboot",
      "/dev/disk3s5    1948404040 1794352324 108707764    95%    /System/Volumes/Data",
      "map auto_home            0          0         0   100%    /System/Volumes/Data/home",
      "/dev/disk5s1      16721920   16196960    481864    98%    /Library/Developer/CoreSimulator/Volumes/iOS_21A342",
      "/dev/disk7s1       2252800    2169232     73996    97%    /private/var/run/com.apple.security.cryptexd/mnt/com.apple.MobileAsset.MetalToolchain-v17.6.42.0.rIDLaA",
    ].join("\n");

    const drives = parseMacDfOutput(stdout, 1);

    expect(drives).toHaveLength(1);
    const root = drives[0]!;
    expect(root.drive).toBe("/");
    expect(root.totalBytes).toBe(1948404040 * 1024);
    expect(root.freeBytes).toBe(108707764 * 1024);
    // Container usage: at least everything the mounted volumes hold,
    // not the ~12 GB the sealed System snapshot reports.
    expect(root.usedBytes).toBe((1948404040 - 108707764) * 1024);
    expect(root.usedBytes).toBeGreaterThanOrEqual(
      (12347096 + 18875720 + 10628192 + 1794352324) * 1024,
    );
    expect(root.usedBytes + root.freeBytes).toBe(root.totalBytes);
    // df rounds Capacity up, so its 95% is 94.4% here.
    expect(root.usedPercent).toBeCloseTo(94.42, 2);
  });

  it("keeps /Volumes mounts and direct device mounts outside system trees", () => {
    const stdout = [
      "Filesystem   1024-blocks Used Available Capacity Mounted on",
      "/dev/disk3s1s1 1000 100 900 10% /",
      "/dev/disk9s1   1000 500 500 50% /Volumes/Installer",
      "/dev/disk10s1  1000 200 800 20% /Users/me/mnt/scratch",
      "/dev/disk11s1  1000 300 700 30% /Systemic",
      "/dev/disk12s1  1000 999   1 99% /System/Cryptexes/OS",
      "/dev/disk13s1  1000 999   1 99% /Library/Developer/CoreSimulator/Cryptex/Images/bundle",
      "/dev/disk14s1  1000 999   1 99% /private/var/folders/xy/abc/T/AppTranslocation/1234",
      "/dev/disk15s1  1000 999   1 99% /private/var/run",
    ].join("\n");

    expect(parseMacDfOutput(stdout).map((drive) => drive.drive)).toEqual([
      "/",
      "/Volumes/Installer",
      "/Users/me/mnt/scratch",
      "/Systemic",
    ]);
  });

  it("filters macOS virtual volumes and zero-sized filesystems", () => {
    const stdout = [
      "Filesystem   1024-blocks Used Available Capacity Mounted on",
      "devfs               190  190         0   100% /dev",
      "/dev/disk3s2  488245288 100 488245188     1% /System/Volumes/Preboot",
      "/dev/disk3s4          0   0         0   100% /private/var/vm",
    ].join("\n");

    expect(parseMacDfOutput(stdout)).toEqual([]);
  });
});

describe("parseWindowsCimLogicalDisks", () => {
  it("parses a CIM JSON array of fixed disks", () => {
    const stdout = JSON.stringify([
      { DeviceID: "C:", FreeSpace: 100, Size: 400 },
      { DeviceID: "D:", FreeSpace: 50, Size: 200 },
    ]);
    const drives = parseWindowsCimLogicalDisks(stdout, 9);
    expect(drives).toEqual([
      {
        drive: "C:",
        totalBytes: 400,
        freeBytes: 100,
        usedBytes: 300,
        usedPercent: 75,
        timestamp: 9,
      },
      {
        drive: "D:",
        totalBytes: 200,
        freeBytes: 50,
        usedBytes: 150,
        usedPercent: 75,
        timestamp: 9,
      },
    ]);
  });

  it("accepts a single object when PowerShell has one disk", () => {
    const drives = parseWindowsCimLogicalDisks(
      JSON.stringify({ DeviceID: "C:", FreeSpace: 1, Size: 4 }),
      1,
    );
    expect(drives).toHaveLength(1);
    expect(drives[0]?.drive).toBe("C:");
  });
});
