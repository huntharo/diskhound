import { execFileSync } from "node:child_process";
import * as FS from "node:fs";
import { describe, expect, it } from "vitest";

import {
  loadScanPrunePlan,
  macPrunePlan,
  parseFirmlinks,
  parseMacMountPoints,
  skipReason,
  type Firmlink,
} from "../scanPrune";

const FIRMLINKS = [
  "/AppleInternal\tAppleInternal",
  "/Applications\tApplications",
  "/Library\tLibrary",
  "/System/Library/Caches\tSystem/Library/Caches",
  "/System/Library/CoreServices/CoreTypes.bundle/Contents/Library\tSystem/Library/CoreServices/CoreTypes.bundle/Contents/Library",
  "/Users\tUsers",
  "/Volumes\tVolumes",
  "/cores\tcores",
  "/opt\topt",
  "/pkg\tpkg",
  "/private\tprivate",
  "/usr/local\tusr/local",
  "",
].join("\n");

/** A Mac with no /AppleInternal and no /pkg on `/`: the loader drops those. */
const firmlinks = (): Firmlink[] =>
  parseFirmlinks(FIRMLINKS).filter((link) => link.system !== "/AppleInternal" && link.system !== "/pkg");

/** `mount` on a macOS 26 Mac with Xcode, plus a USB disk, an SMB share and a disk image in a home folder. */
const MOUNT_OUTPUT = `/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
devfs on /dev (devfs, local, nobrowse)
/dev/disk3s6 on /System/Volumes/VM (apfs, local, noexec, journaled, noatime, nobrowse)
/dev/disk3s2 on /System/Volumes/Preboot (apfs, local, journaled, nobrowse)
/dev/disk3s4 on /System/Volumes/Update (apfs, local, journaled, nobrowse)
/dev/disk1s2 on /System/Volumes/xarts (apfs, local, noexec, journaled, noatime, nobrowse)
/dev/disk1s1 on /System/Volumes/iSCPreboot (apfs, local, journaled, nobrowse)
/dev/disk1s3 on /System/Volumes/Hardware (apfs, local, journaled, nobrowse)
/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)
map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)
/dev/disk5s1 on /Library/Developer/CoreSimulator/Volumes/iOS_21A342 (apfs, local, nodev, nosuid, read-only, journaled, noatime, nobrowse)
/dev/disk7s1 on /private/var/run/com.apple.security.cryptexd/mnt/com.apple.MobileAsset.MetalToolchain (apfs, sealed, local, read-only, journaled, nobrowse)
/dev/disk9s1 on /Volumes/Storage (apfs, local, nodev, nosuid, journaled, noowners)
//me@nas._smb._tcp.local/Media%20Share on /Volumes/Media Share (smbfs, nodev, nosuid, mounted by me)
/dev/disk10s1 on /Users/me/mnt/image (apfs, local, nodev, nosuid, read-only, noowners, mounted by me)
`;

const mounts = () => parseMacMountPoints(MOUNT_OUTPUT);

describe("parseFirmlinks", () => {
  it("reads both names of each firmlink", () => {
    const links = parseFirmlinks(FIRMLINKS);
    expect(links).toHaveLength(12);
    expect(links[5]).toEqual({ system: "/Users", data: "/System/Volumes/Data/Users" });
    expect(links[11]!.data).toBe("/System/Volumes/Data/usr/local");
  });

  it("skips lines that aren't a firmlink", () => {
    expect(parseFirmlinks("garbage\n/\tx\nrelative\tx\n/a\t\n")).toEqual([]);
  });
});

describe("parseMacMountPoints", () => {
  it("keeps spaces and runs to the options in parentheses", () => {
    const points = mounts();
    expect(points).toHaveLength(15);
    expect(points).toContain("/Volumes/Media Share");
    expect(points).toContain("/System/Volumes/Data/home");
    expect(parseMacMountPoints("/dev/disk4s1 on /Volumes/Disk (1) (apfs, local)\n")).toEqual(["/Volumes/Disk (1)"]);
  });
});

describe("macPrunePlan", () => {
  it("walks the Data volume once from / and leaves out other volumes", () => {
    const plan = macPrunePlan("/", mounts(), firmlinks());

    expect([...plan.firmlinkTwins].sort()).toEqual([
      "/System/Volumes/Data/Applications",
      "/System/Volumes/Data/Library",
      "/System/Volumes/Data/System/Library/Caches",
      "/System/Volumes/Data/System/Library/CoreServices/CoreTypes.bundle/Contents/Library",
      "/System/Volumes/Data/Users",
      "/System/Volumes/Data/Volumes",
      "/System/Volumes/Data/cores",
      "/System/Volumes/Data/opt",
      "/System/Volumes/Data/private",
      "/System/Volumes/Data/usr/local",
    ]);
    for (const point of [
      "/dev",
      "/System/Volumes/VM",
      "/System/Volumes/Preboot",
      "/System/Volumes/Update",
      "/System/Volumes/Data/home",
      "/Library/Developer/CoreSimulator/Volumes/iOS_21A342",
      "/private/var/run/com.apple.security.cryptexd/mnt/com.apple.MobileAsset.MetalToolchain",
      "/Volumes/Storage",
      "/Volumes/Media Share",
      "/Users/me/mnt/image",
    ]) {
      expect(skipReason(plan, point), point).toBe("other-mount");
    }
    // Data-only folders are walked, through the Data volume. /pkg is not a
    // live firmlink here, so its Data side is the only way in.
    for (const kept of [
      "/System/Volumes/Data",
      "/System/Volumes/Data/.Spotlight-V100",
      "/System/Volumes/Data/MobileSoftwareUpdate",
      "/System/Volumes/Data/System/Library/CoreServices",
      "/System/Volumes/Data/pkg",
      "/Users",
      "/usr/local",
    ]) {
      expect(skipReason(plan, kept), kept).toBeNull();
    }
  });

  it("has no twins for a scan of the Data volume, and names mounts by their Data path", () => {
    const plan = macPrunePlan("/System/Volumes/Data", mounts(), firmlinks());
    expect(plan.firmlinkTwins.size).toBe(0);
    expect(plan.otherMounts).toContain("/System/Volumes/Data/home");
    expect(plan.otherMounts).toContain("/System/Volumes/Data/Volumes/Storage");
    expect(plan.otherMounts).toContain("/System/Volumes/Data/Library/Developer/CoreSimulator/Volumes/iOS_21A342");
    expect([...plan.otherMounts].every((m) => m.startsWith("/System/Volumes/Data/"))).toBe(true);
  });

  it("puts a home folder on the Data volume and leaves out an image mounted in it", () => {
    const plan = macPrunePlan("/Users/me", mounts(), firmlinks());
    expect(plan.firmlinkTwins.size).toBe(0);
    expect([...plan.otherMounts]).toEqual(["/Users/me/mnt/image"]);
  });

  it("walks a mount when it is the scan root", () => {
    expect(macPrunePlan("/Volumes/Storage", mounts(), firmlinks()).otherMounts.size).toBe(0);
    expect(macPrunePlan("/Volumes/Storage/", mounts(), firmlinks()).otherMounts.size).toBe(0);
  });

  it("skips the twins of firmlinks below /System", () => {
    const plan = macPrunePlan("/System", mounts(), firmlinks());
    expect([...plan.firmlinkTwins].sort()).toEqual([
      "/System/Volumes/Data/System/Library/Caches",
      "/System/Volumes/Data/System/Library/CoreServices/CoreTypes.bundle/Contents/Library",
    ]);
    expect(plan.otherMounts).toContain("/System/Volumes/VM");
    expect(plan.otherMounts).not.toContain("/System/Volumes/Data");
  });

  it("still skips twins without a mount table", () => {
    const plan = macPrunePlan("/", [], firmlinks());
    expect(plan.otherMounts.size).toBe(0);
    expect(plan.firmlinkTwins).toContain("/System/Volumes/Data/Users");
  });
});

describe.runIf(process.platform === "darwin" && FS.existsSync("/System/Volumes/Data"))("live plan for / on this Mac", () => {
  it("matches the native scanner's rules on the real mount table", async () => {
    const plan = await loadScanPrunePlan("/");
    expect(plan.firmlinkTwins).toContain("/System/Volumes/Data/Users");
    expect(plan.firmlinkTwins).toContain("/System/Volumes/Data/private");
    expect(skipReason(plan, "/System/Volumes/Data")).toBeNull();
    expect(skipReason(plan, "/Users")).toBeNull();
    for (const twin of plan.firmlinkTwins) {
      const system = twin.slice("/System/Volumes/Data".length);
      const [a, b] = [FS.statSync(system, { bigint: true }), FS.statSync(twin, { bigint: true })];
      expect([a.dev, a.ino], twin).toEqual([b.dev, b.ino]);
    }
    const mounted = parseMacMountPoints(execFileSync("/sbin/mount", { encoding: "utf8" }));
    if (mounted.includes("/System/Volumes/VM")) expect(plan.otherMounts).toContain("/System/Volumes/VM");
  });
});
