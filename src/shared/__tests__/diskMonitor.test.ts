import { execFile } from "node:child_process";
import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiskSpaceInfo } from "../contracts";
import {
  getDiskSpace,
  initDiskMonitor,
  parseLinuxDfOutput,
  parseMacDfOutput,
  parseWindowsCimLogicalDisks,
  runDf,
  stdoutOfFailedDf,
} from "../diskMonitor";

const execFileAsync = promisify(execFile);

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

  it("reads rows whose filesystem, mount point, or both contain spaces", () => {
    const stdout = [
      "Filesystem                1024-blocks       Used  Available Capacity  Mounted on",
      "/dev/disk3s1s1             1948404040   12347096  108707764    11%    /",
      // NFS sources are host:path with the path as typed.
      "nas:/export/Family Photos  3906250000 1000000000 2906250000    26%    /Volumes/nas",
      "/dev/disk4s1                976490576  400000000  576490576    41%    /Volumes/My  Passport",
      "nas:/export/Backup 2024    3906250000 2000000000 1906250000    52%    /Volumes/Backup 2024",
      // SMB sources are URL-encoded, so only the mount point has a space.
      "//me@nas/Media%20Share     1952981152  500000000 1452981152    26%    /Volumes/Media Share",
    ].join("\n");

    const drives = parseMacDfOutput(stdout, 7);

    expect(drives.map((drive) => drive.drive)).toEqual([
      "/",
      "/Volumes/nas",
      // Runs of spaces in a mount point survive; it must stay a real path.
      "/Volumes/My  Passport",
      // A source ending in a number is not mistaken for the size column.
      "/Volumes/Backup 2024",
      "/Volumes/Media Share",
    ]);
    expect(drives[1]).toEqual({
      drive: "/Volumes/nas",
      totalBytes: 3906250000 * 1024,
      usedBytes: 1000000000 * 1024,
      freeBytes: 2906250000 * 1024,
      usedPercent: (1000000000 / 3906250000) * 100,
      timestamp: 7,
    });
    expect(drives[3]).toMatchObject({
      totalBytes: 3906250000 * 1024,
      usedBytes: 2000000000 * 1024,
      freeBytes: 1906250000 * 1024,
    });
  });

  it("still hides autofs triggers whose map name has a space", () => {
    // `map auto_home` is on every Mac. A direct map under /Volumes
    // prints a zero-sized trigger until something walks into it.
    const stdout = [
      "Filesystem     1024-blocks Used Available Capacity  Mounted on",
      "map auto_home            0    0         0   100%    /System/Volumes/Data/home",
      "map -hosts               0    0         0   100%    /net",
      "map auto_nas             0    0         0   100%    /Volumes/nas",
    ].join("\n");

    expect(parseMacDfOutput(stdout)).toEqual([]);
  });

  it("drops rows with sizes that are not finite numbers", () => {
    const huge = "9".repeat(400);
    const stdout = [
      "Filesystem   1024-blocks Used Available Capacity Mounted on",
      `/dev/disk9s1 ${huge} 500 500 50% /Volumes/Broken`,
      "/dev/disk9s2 - - - - /Volumes/Unknown",
      "/dev/disk9s3 1000 500 500 50% /Volumes/Fine",
    ].join("\n");

    const drives = parseMacDfOutput(stdout);

    expect(drives.map((drive) => drive.drive)).toEqual(["/Volumes/Fine"]);
  });
});

describe("parseLinuxDfOutput", () => {
  // `df -P -k -T` from coreutils. GNU df prints spaces in the source
  // and mount point as-is (it undoes /proc/self/mountinfo's \040).
  const header =
    "Filesystem                Type       1024-blocks       Used  Available Capacity Mounted on";

  it("reads rows whose filesystem, mount point, or both contain spaces", () => {
    const stdout = [
      header,
      "/dev/nvme0n1p2            ext4         490617784  412345678   53278906      89% /",
      "//nas/My Share            cifs        1952981152  500000000 1452981152      26% /mnt/nas",
      "/dev/sdb1                 exfat        976490576  400000000  576490576      41% /media/me/My Passport",
      "nas:/export/Family Photos nfs4        3906250000 1000000000 2906250000      26% /mnt/Family Photos",
    ].join("\n");

    const drives = parseLinuxDfOutput(stdout, 5);

    expect(drives.map((drive) => drive.drive)).toEqual([
      "/",
      "/mnt/nas",
      "/media/me/My Passport",
      "/mnt/Family Photos",
    ]);
    expect(drives[1]).toEqual({
      drive: "/mnt/nas",
      totalBytes: 1952981152 * 1024,
      usedBytes: 500000000 * 1024,
      freeBytes: 1452981152 * 1024,
      usedPercent: (500000000 / 1952981152) * 100,
      timestamp: 5,
    });
    expect(drives[3]).toMatchObject({
      totalBytes: 3906250000 * 1024,
      usedBytes: 1000000000 * 1024,
      freeBytes: 2906250000 * 1024,
    });
  });

  it("keeps the type filter and the snap, boot, and zero-size skips", () => {
    const stdout = [
      header,
      "udev                      devtmpfs       8123456          0    8123456       0% /dev",
      "tmpfs                     tmpfs          1629876       2140    1627736       1% /run",
      "/dev/nvme0n1p2            ext4         490617784  412345678   53278906      89% /",
      "/dev/loop3                squashfs         64896      64896          0     100% /snap/core20/2318",
      "/dev/nvme0n1p1            vfat            523248       6220     517028       2% /boot/efi",
      // The source's space must not push "fuse.sshfs" out of the type column.
      "me@host:/srv/My Files     fuse.sshfs     1000000     500000     500000      50% /home/me/remote",
      "/dev/sdd1                 ext4                 0          0          0        - /mnt/empty",
      "tank/My Data              ZFS            2000000    1000000    1000000      50% /tank/My Data",
    ].join("\n");

    expect(parseLinuxDfOutput(stdout).map((drive) => drive.drive)).toEqual([
      "/",
      "/tank/My Data",
    ]);
  });

  it("keeps a filesystem that has run into its root reserve", () => {
    // GNU df prints a negative Available once root's reserved blocks
    // are in use.
    const stdout = [
      header,
      "/dev/sdc1                 ext4           1000000     990000     -40000     105% /srv/full",
    ].join("\n");

    expect(parseLinuxDfOutput(stdout, 1)).toEqual([
      {
        drive: "/srv/full",
        totalBytes: 1000000 * 1024,
        usedBytes: 990000 * 1024,
        freeBytes: -40000 * 1024,
        usedPercent: (990000 / 1000000) * 100,
        timestamp: 1,
      },
    ]);
  });

  it("drops rows with sizes that are not finite numbers", () => {
    const stdout = [
      header,
      `/dev/sde1 ext4 ${"9".repeat(400)} 500 500 50% /mnt/broken`,
      "/dev/sde2 ext4 - - - - /mnt/unknown",
      "/dev/sde3 ext4 1000 500 500 50% /mnt/fine",
    ].join("\n");

    expect(parseLinuxDfOutput(stdout).map((drive) => drive.drive)).toEqual(["/mnt/fine"]);
  });
});

describe("stdoutOfFailedDf", () => {
  // A Node child stands in for df so each case gets the error that
  // promisified execFile really rejects with.
  function runFakeDf(script: string, timeout?: number): Promise<unknown> {
    return execFileAsync(process.execPath, ["-e", script], { timeout }).then(
      () => {
        throw new Error("expected the fake df to fail");
      },
      (error: unknown) => error,
    );
  }

  it("keeps the rows GNU df printed before exiting 1 for a dead mount", async () => {
    // coreutils prints every mount it could stat, then exits 1 when
    // statfs failed on one of them with anything but EACCES or ENOENT.
    const table = [
      "Filesystem     Type 1024-blocks      Used Available Capacity Mounted on",
      "/dev/nvme0n1p2 ext4   490617784 412345678  53278906      89% /",
      "/dev/sdb1      ext4   976490576 400000000 576490576      41% /mnt/backup",
      "",
    ].join("\n");
    const error = await runFakeDf(
      `process.stdout.write(${JSON.stringify(table)});` +
        `process.stderr.write("df: /home/me/remote: Transport endpoint is not connected\\n");` +
        `process.exitCode = 1;`,
    );

    const stdout = stdoutOfFailedDf(error);

    expect(stdout).toBe(table);
    expect(parseLinuxDfOutput(stdout ?? "").map((drive) => drive.drive)).toEqual(["/", "/mnt/backup"]);
  });

  it("returns nothing when df exited with an error and printed no table", async () => {
    const error = await runFakeDf(`process.stderr.write("df: no file systems processed\\n"); process.exitCode = 1;`);

    expect(error).toMatchObject({ code: 1 });
    expect(stdoutOfFailedDf(error)).toBeNull();
  });

  it("drops what a df killed by the timeout had written", async () => {
    const error = await runFakeDf(
      `process.stdout.write("Filesystem 1024-blocks Used Available Capacity Mounted on\\n");` +
        `setTimeout(() => {}, 60_000);`,
      500,
    );

    expect(error).toMatchObject({ killed: true, code: null });
    expect(stdoutOfFailedDf(error)).toBeNull();
  });

  it("returns nothing when df could not be started", async () => {
    const error = await execFileAsync("diskhound-no-such-df", ["-P"]).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "ENOENT" });
    expect(stdoutOfFailedDf(error)).toBeNull();
  });

  it("returns nothing for errors that carry no exit status", () => {
    expect(stdoutOfFailedDf(undefined)).toBeNull();
    expect(stdoutOfFailedDf(new Error("boom"))).toBeNull();
    expect(stdoutOfFailedDf({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "/dev/sda1" })).toBeNull();
    expect(stdoutOfFailedDf({ code: 1, stdout: Buffer.from("rows") })).toBeNull();
  });
});

describe("runDf", () => {
  // Node children stand in for df, passed as the command.
  const table = [
    "Filesystem   1024-blocks Used Available Capacity Mounted on",
    "/dev/disk4s1        1000  400       600      40% /Volumes/Data",
    "",
  ].join("\n");
  const printTable = `process.stdout.write(${JSON.stringify(table)});`;

  it("shares one df among the callers that ask while it runs", async () => {
    const first = runDf(["-e", `setTimeout(() => { ${printTable} }, 200);`], process.execPath);
    const second = runDf(["-e", `process.stdout.write("another table");`], process.execPath);

    expect(await first).toBe(table);
    expect(await second).toBe(table);
  });

  it.skipIf(process.platform === "win32")(
    "gives up on a df that outlives its timeout and starts no other until it exits",
    async () => {
      const tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-df-"));
      const pidFile = Path.join(tempDir, "pid");
      try {
        // Ignores the timeout's SIGTERM, like a df blocked in FUSE's
        // request_wait_answer on an sshfs mount whose network is gone.
        const stuck = runDf(
          [
            "-e",
            `process.on("SIGTERM", () => {});` +
              `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
              `setInterval(() => {}, 1000);`,
          ],
          process.execPath,
          1_000,
        );

        expect(await stuck).toBeNull();
        // It is still running, so this caller gets its answer too
        // instead of starting a second df.
        expect(await runDf(["-e", printTable], process.execPath)).toBeNull();
      } finally {
        process.kill(Number(FS.readFileSync(pidFile, "utf8")), "SIGKILL");
        await FSP.rm(tempDir, { recursive: true, force: true });
      }

      // Once it exits, the next caller runs a new df.
      await vi.waitFor(
        async () => expect(await runDf(["-e", printTable], process.execPath)).toBe(table),
        { timeout: 5_000 },
      );
    },
  );
});

describe.skipIf(process.platform === "win32")("getDiskSpace", () => {
  // A shell script named df, first on PATH, stands in for the real
  // one. It prints the `-T` layout when asked, so the same row reaches
  // parseLinuxDfOutput on Linux and parseMacDfOutput on macOS.
  let tempDir: string;
  let savedPath: string | undefined;

  beforeEach(async () => {
    tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-df-"));
    savedPath = process.env.PATH;
    process.env.PATH = `${tempDir}${Path.delimiter}${savedPath ?? ""}`;
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    await FSP.rm(tempDir, { recursive: true, force: true });
  });

  function fakeDf(body: string): void {
    // Write a new file and rename it over the old one, so Linux never
    // sees a write to an executable that was just run (ETXTBSY).
    const next = Path.join(tempDir, "df.next");
    FS.writeFileSync(next, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    FS.renameSync(next, Path.join(tempDir, "df"));
  }

  const printsVolumesData = [
    `case " $* " in`,
    `  *" -T "*) printf 'Filesystem Type 1024-blocks Used Available Capacity Mounted on\\n/dev/sdb1 ext4 1000 400 600 40%% /Volumes/Data\\n' ;;`,
    `  *) printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/disk4s1 1000 400 600 40%% /Volumes/Data\\n' ;;`,
    `esac`,
  ].join("\n");

  it("returns the drives df last reported when a run gives no table", async () => {
    // Before df has answered once, the fallback is the last check
    // saved before the app quit.
    const saved: DiskSpaceInfo = {
      drive: "/Volumes/Saved",
      totalBytes: 2048,
      freeBytes: 1024,
      usedBytes: 1024,
      usedPercent: 50,
      timestamp: 1,
    };
    await FSP.writeFile(
      Path.join(tempDir, "disk-baselines.json"),
      JSON.stringify({ previousDrives: {}, lastFullScanAt: null, lastDrives: [saved] }),
    );
    await initDiskMonitor(tempDir);
    fakeDf("exit 1");
    expect(await getDiskSpace()).toEqual([saved]);

    fakeDf(printsVolumesData);
    const fresh = await getDiskSpace();
    expect(fresh.map((drive) => drive.drive)).toEqual(["/Volumes/Data"]);

    fakeDf("exit 1");
    expect(await getDiskSpace()).toEqual(fresh);
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
