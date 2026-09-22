import { describe, expect, it } from "vitest";

import {
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
