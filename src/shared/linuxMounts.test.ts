import { describe, expect, it } from "vitest";

import {
  duplicateMountPathsFrom,
  foreignMountPointsFrom,
  parseMountinfo,
  unescapeMountinfo,
} from "./linuxMounts";

const FIXTURE = [
  "36 35 0:29 / / rw,relatime - btrfs /dev/mapper/root rw",
  "37 36 0:29 /@home /home rw - btrfs /dev/mapper/root rw",
  "38 36 0:29 /@log /var/log rw - btrfs /dev/mapper/root rw",
  "39 36 0:58 / /tmp rw - tmpfs tmpfs rw",
  "40 36 259:9 / /boot rw - vfat /dev/nvme0n1p1 rw",
  "41 36 259:6 / /mnt/windows rw - ntfs3 /dev/nvme1n1p1 ro",
  "42 36 259:7 / /mnt/windows-backup rw - ntfs3 /dev/sdc1 rw",
  "43 39 0:99 / /tmp/.mount_DiskHo rw - fuse.AppImage DiskHound ro",
  "44 36 0:30 / /mnt/my\\040disk rw - ext4 /dev/sdb1 rw",
  "45 41 0:58 / /mnt/windows/nested-tmp rw - tmpfs tmpfs rw",
].join("\n");

describe("linux mount boundaries", () => {
  it("unescapes octal spaces in mount points", () => {
    expect(unescapeMountinfo("/mnt/my\\040disk")).toBe("/mnt/my disk");
  });

  it("keeps same-pool btrfs subvolumes and drops other disks", () => {
    const foreign = foreignMountPointsFrom("/", parseMountinfo(FIXTURE));
    expect(foreign.has("/mnt/windows")).toBe(true);
    expect(foreign.has("/mnt/windows-backup")).toBe(true);
    expect(foreign.has("/boot")).toBe(true);
    expect(foreign.has("/tmp")).toBe(true);
    expect(foreign.has("/tmp/.mount_DiskHo")).toBe(true);
    expect(foreign.has("/mnt/my disk")).toBe(true);
    expect(foreign.has("/home")).toBe(false);
    expect(foreign.has("/var/log")).toBe(false);
    expect(foreign.has("/")).toBe(false);
  });

  it("does not pull the Windows disk into a home scan", () => {
    expect(foreignMountPointsFrom("/home", parseMountinfo(FIXTURE)).size).toBe(0);
  });

  it("walks an explicit Windows scan and skips nested other filesystems", () => {
    const foreign = foreignMountPointsFrom("/mnt/windows", parseMountinfo(FIXTURE));
    expect(foreign.has("/mnt/windows/nested-tmp")).toBe(true);
    expect(foreign.has("/mnt/windows")).toBe(false);
    expect(foreign.has("/mnt/windows-backup")).toBe(false);
  });
});

const duplicates = (mountinfo: string[], root: string) =>
  [...duplicateMountPathsFrom(root, parseMountinfo(mountinfo.join("\n")))].sort();

describe("second copies through another mount", () => {
  it("walks a bind mount once, through its mount point", () => {
    const mountinfo = [
      "125 196 0:66 / /scan rw - tmpfs tmpfs rw",
      "126 125 0:66 /proj /scan/view rw - tmpfs tmpfs rw",
    ];
    expect(duplicates(mountinfo, "/scan")).toEqual(["/scan/proj"]);
    expect(duplicates(mountinfo, "/scan/proj")).toEqual([]);
    expect(duplicates(mountinfo, "/scan/view")).toEqual([]);
  });

  it("walks sibling subvolumes both", () => {
    const mountinfo = [
      "30 1 0:29 /root / rw - btrfs /dev/nvme0n1p3 rw",
      "31 30 0:29 /home /home rw - btrfs /dev/nvme0n1p3 rw",
      "32 30 0:29 /var /var rw - btrfs /dev/nvme0n1p3 rw",
    ];
    expect(duplicates(mountinfo, "/")).toEqual([]);
  });

  it("walks subvolumes of a mounted top-level volume at their mount points", () => {
    expect(duplicates(FIXTURE.split("\n"), "/")).toEqual(["/@home", "/@log"]);
    expect(duplicates(FIXTURE.split("\n"), "/home")).toEqual([]);
  });

  it("does not walk openSUSE's running root again under /.snapshots", () => {
    const mountinfo = [
      "60 1 0:40 /@/.snapshots/1/snapshot / rw - btrfs /dev/vda2 rw",
      "61 60 0:40 /@/.snapshots /.snapshots rw - btrfs /dev/vda2 rw",
      "62 60 0:40 /@/home /home rw - btrfs /dev/vda2 rw",
    ];
    expect(duplicates(mountinfo, "/")).toEqual(["/.snapshots/1/snapshot"]);
  });

  it("skips a folder bound inside itself at the inner mount", () => {
    const mountinfo = [
      "20 1 8:1 / / rw - ext4 /dev/sda1 rw",
      "21 20 8:1 /data /data/sub/loop rw - ext4 /dev/sda1 rw",
    ];
    expect(duplicates(mountinfo, "/")).toEqual(["/data/sub/loop"]);
    expect(duplicates(mountinfo, "/data")).toEqual(["/data/sub/loop"]);
  });

  it("keeps the first of two mounts of the same folder", () => {
    const mountinfo = [
      "20 1 8:1 / / rw - ext4 /dev/sda1 rw",
      "21 20 8:1 /data/x /mnt/a rw - ext4 /dev/sda1 rw",
      "22 20 8:1 /data/x /mnt/b rw - ext4 /dev/sda1 rw",
      "23 20 8:1 / /mnt/whole rw - ext4 /dev/sda1 rw",
    ];
    expect(duplicates(mountinfo, "/")).toEqual(["/data/x", "/mnt/b", "/mnt/whole"]);
  });

  it("prunes nothing for a folder bound onto itself", () => {
    const mountinfo = [
      "20 1 8:1 / / rw - ext4 /dev/sda1 rw",
      "21 20 8:1 /srv /srv rw - ext4 /dev/sda1 rw",
    ];
    expect(duplicates(mountinfo, "/")).toEqual([]);
  });

  it("prunes nothing for a mount the walk never reaches", () => {
    // /tmp/x sits under a tmpfs, and /mnt/y is covered by the tmpfs
    // mounted on /mnt after it, so /data/x and /data/y are the only way
    // to those files.
    const mountinfo = [
      "20 1 8:1 / / rw - ext4 /dev/sda1 rw",
      "21 20 0:50 / /tmp rw - tmpfs tmpfs rw",
      "22 21 8:1 /data/x /tmp/x rw - ext4 /dev/sda1 rw",
      "23 20 8:1 /data/y /mnt/y rw - ext4 /dev/sda1 rw",
      "24 20 0:51 / /mnt rw - tmpfs tmpfs rw",
    ];
    expect(duplicates(mountinfo, "/")).toEqual([]);
  });

  it("leaves a copy hidden under another filesystem alone", () => {
    const mountinfo = [
      "20 1 8:1 / / rw - ext4 /dev/sda1 rw",
      "21 20 0:50 / /data rw - tmpfs tmpfs rw",
      "22 20 8:1 /data/x /mnt/x rw - ext4 /dev/sda1 rw",
    ];
    expect(duplicates(mountinfo, "/")).toEqual([]);
  });
});
