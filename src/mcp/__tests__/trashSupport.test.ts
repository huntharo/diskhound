import { describe, expect, it } from "vitest";

import {
  linuxVolumes,
  macVolumes,
  parseLinuxMounts,
  parseMacMounts,
  TrashProbe,
  windowsVolumes,
  type ProbeFs,
  type VolumeTable,
} from "../trashSupport";

const NOW = Date.UTC(2026, 9, 12, 12);

const MAC_MOUNT = [
  "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
  "devfs on /dev (devfs, local, nobrowse)",
  "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)",
  "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
  "//sam@nas._smb._tcp.local/team-share on /Volumes/team-share (smbfs, nodev, nosuid, mounted by sam)",
  "/dev/disk5s1 on /Volumes/My Archive (apfs, local, nodev, nosuid, journaled, noowners)",
  "/dev/disk6s1 on /Users/sam/datasets/archive (apfs, local, nodev, nosuid, journaled, noowners)",
  "/dev/disk7s1 on /Volumes/NTFS (ntfs, local, read-only, noowners)",
].join("\n");

/** Devices: / is 1, the Data volume 2, My Archive 5, the mount inside datasets 6, NTFS 7. */
const MAC_DEVS: Record<string, number> = {
  "/": 1,
  "/dev": 9,
  "/System/Volumes/Data": 2,
  "/System/Volumes/Data/home": 8,
  "/Volumes/My Archive": 5,
  "/Users/sam/datasets/archive": 6,
  "/Volumes/NTFS": 7,
};

function fakeFs(devOf: (path: string) => number, extra: Partial<ProbeFs> = {}): ProbeFs {
  return {
    lstat: async (path) => ({ dev: devOf(path), mode: 0o40755, isDirectory: () => true, isSymbolicLink: () => false, uid: 501 }),
    stat: async (path) => ({ dev: devOf(path) }),
    access: async () => undefined,
    ...extra,
  };
}

/**
 * `oneGroupDev`: macOS 26 reports the APFS volume group's one device for
 * the sealed system volume and its Data volume alike, for / itself and
 * for every path on either.
 */
function macProbe({ oneGroupDev = false } = {}) {
  const devs = oneGroupDev ? { ...MAC_DEVS, "/": 2 } : MAC_DEVS;
  const table: VolumeTable = {
    platform: "darwin",
    volumes: macVolumes(parseMacMounts(MAC_MOUNT)).map((volume) =>
      volume.noTrash?.includes("network") ? volume : { ...volume, dev: devs[volume.mountPoint] }),
    homeDev: null,
    uid: null,
  };
  // Firmlinked paths (/Users/…) are on the Data volume.
  const devOf = (path: string) =>
    path.startsWith("/Users/sam/datasets/archive") ? 6
      : path.startsWith("/Volumes/My Archive") ? 5
        : path.startsWith("/Volumes/NTFS") ? 7
          : path.startsWith("/Users") || path.startsWith("/System/Volumes/Data") || oneGroupDev ? 2
            : 1;
  return new TrashProbe(async () => table, { platform: "darwin", fs: fakeFs(devOf), now: () => NOW });
}

describe("parseMacMounts", () => {
  it("keeps devices and mount points with spaces, and the options", () => {
    const mounts = parseMacMounts(MAC_MOUNT);
    expect(mounts.find((mount) => mount.point === "/System/Volumes/Data/home")).toMatchObject({ device: "map auto_home", fsType: "autofs" });
    expect(mounts.find((mount) => mount.point === "/Volumes/My Archive")).toMatchObject({ fsType: "apfs", options: expect.arrayContaining(["local"]) });
    expect(mounts.find((mount) => mount.point === "/Volumes/team-share")).toMatchObject({ fsType: "smbfs" });
  });
});

describe("TrashProbe on macOS", () => {
  it("says yes for a folder on the Data volume reached through a firmlink", async () => {
    const [check] = await macProbe().check([{ path: "/Users/sam/github/atlas/dist", sizeBytes: 1 }]);
    expect(check).toEqual({ volume: "the startup disk", trash: "yes", readOnly: false, mountsInside: [], checkedAt: NOW });
  });

  it("says the Data volume, not the read-only system volume, when both report one device", async () => {
    const probe = macProbe({ oneGroupDev: true });
    for (const path of ["/Users/sam/github/atlas/dist", "/Applications/Old.app"]) {
      const [check] = await probe.check([{ path, sizeBytes: 1 }]);
      expect(check).toEqual({ volume: "the startup disk", trash: "yes", readOnly: false, mountsInside: [], checkedAt: NOW });
    }
  });

  it("says no for a network volume, by its path alone", async () => {
    const [check] = await macProbe().check([{ path: "/Volumes/team-share/renders/old", sizeBytes: 1 }]);
    expect(check).toMatchObject({ volume: "team-share", trash: "no", trashWhy: "team-share is a network volume with no Trash." });
  });

  it("marks a read-only volume", async () => {
    const [check] = await macProbe().check([{ path: "/Volumes/NTFS/movies", sizeBytes: 1 }]);
    expect(check).toMatchObject({ volume: "NTFS", readOnly: true });
  });

  it("lists another volume mounted inside a folder", async () => {
    const [check] = await macProbe().check([{ path: "/Users/sam/datasets", sizeBytes: 1 }]);
    expect(check).toMatchObject({
      volume: "the startup disk",
      trash: "yes",
      mountsInside: [{ path: "/Users/sam/datasets/archive", volume: "archive" }],
    });
  });

  it("knows a path where a volume is mounted", async () => {
    const probe = macProbe();
    expect(await probe.mountedAt("/Volumes/My Archive")).toBe("My Archive");
    expect(await probe.mountedAt("/volumes/my archive")).toBe("My Archive");
    expect(await probe.mountedAt("/Volumes/My Archive/x")).toBeNull();
  });

  it("reads the table once per TTL and again after invalidate", async () => {
    let loads = 0;
    let now = NOW;
    const probe = new TrashProbe(async () => {
      loads++;
      return { platform: "darwin", volumes: [], homeDev: null, uid: null };
    }, { platform: "darwin", fs: fakeFs(() => 1), now: () => now, ttlMs: 60_000 });
    await probe.check([{ path: "/a", sizeBytes: 1 }, { path: "/b", sizeBytes: 1 }]);
    await probe.mountedAt("/a");
    expect(loads).toBe(1);
    now += 61_000;
    await probe.check([{ path: "/a", sizeBytes: 1 }]);
    expect(loads).toBe(2);
    probe.invalidate();
    await probe.check([{ path: "/a", sizeBytes: 1 }]);
    expect(loads).toBe(3);
  });

  it("says unknown, never yes, when it can't read the volumes", async () => {
    const probe = new TrashProbe(async () => {
      throw new Error("mount failed");
    }, { platform: "darwin", now: () => NOW });
    const [check] = await probe.check([{ path: "/a", sizeBytes: 1 }]);
    expect(check).toMatchObject({ trash: "unknown", trashWhy: expect.stringContaining("mount failed") });
  });
});

const MOUNTINFO = [
  "22 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw",
  "23 22 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:5 - proc proc rw",
  "24 22 0:5 / /tmp rw,nosuid,nodev shared:6 - tmpfs tmpfs rw",
  "25 22 8:17 / /mnt/scratch rw,relatime shared:7 - ext4 /dev/sdb1 rw",
  "26 22 8:33 / /mnt/backup ro,relatime shared:8 - ext4 /dev/sdc1 ro",
  "27 22 0:50 / /mnt/nas rw,relatime shared:9 - nfs4 nas:/export rw",
  "28 25 8:49 / /mnt/scratch/build/cache rw,relatime shared:10 - ext4 /dev/sdd1 rw",
  "29 22 8:65 / /media/sam/USB\\040Stick rw,relatime shared:11 - vfat /dev/sde1 rw",
  "30 22 8:81 / /data rw,relatime shared:12 - ext4 /dev/sdf1 rw,x-gvfs-notrash",
].join("\n");

function linuxProbe(options: { writable?: (path: string) => boolean; trashDirs?: Record<string, { mode: number; uid: number }> } = {}) {
  const volumes = linuxVolumes(parseLinuxMounts(MOUNTINFO));
  const table: VolumeTable = { platform: "linux", volumes, homeDev: 100, uid: 1000 };
  const devOf = (path: string) => (path.startsWith("/home/") ? 100 : 200);
  const fs = fakeFs(devOf, {
    lstat: async (path) => {
      const dir = options.trashDirs?.[path];
      if (path.includes(".Trash") && !dir) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { dev: devOf(path), mode: dir?.mode ?? 0o40755, isDirectory: () => true, isSymbolicLink: () => false, uid: dir?.uid ?? 1000 };
    },
    access: async (path) => {
      if (options.writable && !options.writable(path)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    },
  });
  return new TrashProbe(async () => table, { platform: "linux", fs, now: () => NOW });
}

describe("parseLinuxMounts", () => {
  it("keeps the type, the ro flag, options and escaped spaces", () => {
    const mounts = parseLinuxMounts(MOUNTINFO);
    expect(mounts.find((mount) => mount.point === "/mnt/backup")).toMatchObject({ fsType: "ext4", readOnly: true });
    expect(mounts.find((mount) => mount.point === "/media/sam/USB Stick")).toMatchObject({ fsType: "vfat", readOnly: false });
    expect(mounts.find((mount) => mount.point === "/data")?.options).toContain("x-gvfs-notrash");
  });
});

describe("TrashProbe on Linux (gio's rules)", () => {
  it("sends anything on the home folder's device to the home Trash", async () => {
    const [check] = await linuxProbe({ writable: () => false }).check([{ path: "/home/sam/project/node_modules", sizeBytes: 1 }]);
    expect(check).toMatchObject({ volume: "/", trash: "yes" });
  });

  it("refuses system-internal mounts: tmpfs, network file systems, and mounts at system paths", async () => {
    const checks = await linuxProbe().check([
      { path: "/tmp/build", sizeBytes: 1 },
      { path: "/mnt/nas/videos", sizeBytes: 1 },
      { path: "/etc/thing", sizeBytes: 1 },
      { path: "/data/old", sizeBytes: 1 },
    ]);
    expect(checks.map((check) => check.trash)).toEqual(["no", "no", "no", "no"]);
    expect(checks[0]!.trashWhy).toBe("/tmp is a tmpfs mount, where the Trash isn't supported.");
    expect(checks[1]!.trashWhy).toBe("/mnt/nas is a nfs4 mount, where the Trash isn't supported.");
    // "/" isn't the home device here, and gio never trashes at a system mount path.
    expect(checks[2]!.trashWhy).toContain("/ is a ext4 mount");
    expect(checks[3]!.trashWhy).toBe("/data is mounted with no Trash.");
  });

  it("uses .Trash-<uid> at the mount's top, or a top it can write to", async () => {
    const writable = await linuxProbe().check([{ path: "/mnt/scratch/old", sizeBytes: 1 }]);
    expect(writable[0]).toMatchObject({ volume: "/mnt/scratch", trash: "yes" });

    const owned = await linuxProbe({ writable: () => false, trashDirs: { "/mnt/scratch/.Trash-1000": { mode: 0o40700, uid: 1000 } } })
      .check([{ path: "/mnt/scratch/old", sizeBytes: 1 }]);
    expect(owned[0]!.trash).toBe("yes");

    const shared = await linuxProbe({
      writable: () => false,
      trashDirs: { "/mnt/scratch/.Trash": { mode: 0o41777, uid: 0 }, "/mnt/scratch/.Trash/1000": { mode: 0o40700, uid: 1000 } },
    }).check([{ path: "/mnt/scratch/old", sizeBytes: 1 }]);
    expect(shared[0]!.trash).toBe("yes");

    const none = await linuxProbe({ writable: () => false }).check([{ path: "/mnt/scratch/old", sizeBytes: 1 }]);
    expect(none[0]).toMatchObject({ trash: "no", trashWhy: "/mnt/scratch has no Trash folder, and DiskHound can't make one there." });
  });

  it("ignores a shared .Trash that isn't sticky", async () => {
    const [check] = await linuxProbe({
      writable: () => false,
      trashDirs: { "/mnt/scratch/.Trash": { mode: 0o40777, uid: 0 }, "/mnt/scratch/.Trash/1000": { mode: 0o40700, uid: 1000 } },
    }).check([{ path: "/mnt/scratch/old", sizeBytes: 1 }]);
    expect(check!.trash).toBe("no");
  });

  it("marks read-only mounts, and lists mounts inside a folder", async () => {
    const [backup, build] = await linuxProbe().check([
      { path: "/mnt/backup/2024", sizeBytes: 1 },
      { path: "/mnt/scratch/build", sizeBytes: 1 },
    ]);
    expect(backup).toMatchObject({ readOnly: true });
    expect(build).toMatchObject({ trash: "yes", mountsInside: [{ path: "/mnt/scratch/build/cache", volume: "/mnt/scratch/build/cache" }] });
  });
});

describe("TrashProbe on Windows", () => {
  const raw = {
    drives: [
      { root: "C:\\", type: "Fixed", format: "NTFS", totalBytes: 1e12, maxMb: 50_000, nuke: 0 },
      { root: "D:\\", type: "Fixed", format: "NTFS", totalBytes: 4e11, maxMb: 24 * 1024, nuke: 0 },
      { root: "E:\\", type: "Removable", format: "FAT32", totalBytes: 3.2e10, maxMb: null, nuke: null },
      { root: "F:\\", type: "Fixed", format: "NTFS", totalBytes: 2e11, maxMb: 1000, nuke: 1 },
      { root: "Z:\\", type: "Network", format: "NTFS", totalBytes: 5e12, maxMb: null, nuke: null },
      { root: "G:\\", type: "Fixed", format: "NTFS", totalBytes: 1e11, maxMb: null, nuke: null },
    ],
    folders: ["C:\\Mounts\\Data\\"],
  };
  const probe = () => new TrashProbe(async () => ({ platform: "win32", volumes: windowsVolumes(raw), homeDev: null, uid: null }), {
    platform: "win32",
    now: () => NOW,
    sizeText: (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`,
  });
  const GB = 1024 ** 3;

  it("takes what fits the Recycle Bin, and says why it can't take the rest", async () => {
    const checks = await probe().check([
      { path: "C:\\Users\\sam\\big.iso", sizeBytes: 4 * GB },
      { path: "D:\\captures\\raw", sizeBytes: 182 * GB },
      { path: "E:\\DCIM", sizeBytes: GB },
      { path: "F:\\old", sizeBytes: GB },
      { path: "Z:\\share", sizeBytes: GB },
      { path: "d:\\captures\\small", sizeBytes: null },
    ]);
    expect(checks.map((check) => [check.volume, check.trash])).toEqual([
      ["C:", "yes"], ["D:", "no"], ["E:", "no"], ["F:", "no"], ["Z:", "no"], ["D:", "unknown"],
    ]);
    expect(checks[1]!.trashWhy).toBe("It's bigger than the Recycle Bin on D: (24.0 GB). Windows would delete it permanently instead.");
    expect(checks[2]!.trashWhy).toBe("E: is a removable drive with no Recycle Bin.");
    expect(checks[3]!.trashWhy).toBe("The Recycle Bin is turned off for F:.");
    expect(checks[4]!.trashWhy).toBe("Z: is a network drive with no Recycle Bin.");
    expect(checks[5]!.trashWhy).toContain("doesn't know its size");
  });

  it("falls back to Windows' default size when the bin was never configured", async () => {
    const [fits, tooBig] = await probe().check([
      { path: "G:\\a", sizeBytes: GB },
      { path: "G:\\b", sizeBytes: 10 * GB },
    ]);
    expect(fits!.trash).toBe("yes");
    expect(tooBig).toMatchObject({ trash: "unknown", trashWhy: expect.stringContaining("may be bigger than the Recycle Bin on G:") });
  });

  it("lists a volume mounted on a folder inside the item", async () => {
    const [check] = await probe().check([{ path: "C:\\Mounts", sizeBytes: GB }]);
    expect(check).toMatchObject({ volume: "C:", mountsInside: [{ path: "C:\\Mounts\\Data", volume: "Data" }] });
  });

  it("accepts PowerShell's single-object JSON", () => {
    const volumes = windowsVolumes({ drives: raw.drives[0], folders: null });
    expect(volumes).toHaveLength(1);
    expect(volumes[0]).toMatchObject({ mountPoint: "C:\\", binBytes: 50_000 * 1024 * 1024 });
  });
});
