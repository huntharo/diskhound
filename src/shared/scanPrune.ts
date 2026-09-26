import { execFile } from "node:child_process";
import * as FS from "node:fs/promises";

import { linuxMountPrunes } from "./linuxMounts";

/**
 * Which directories the JS worker leaves out. Same rules as the native
 * walker (native/diskhound-native-scanner/src/walk_prune.rs):
 *
 *   - Other filesystems mounted below the scan root keep their own drive
 *     pill. Linux compares mountinfo device ids (see linuxMounts.ts), so
 *     btrfs subvolumes of one pool stay in. macOS keeps the startup
 *     disk's System and Data volumes together and leaves out /Volumes/*,
 *     the VM, Preboot and Update volumes, simulator and cryptex images,
 *     and autofs. A scan of the mount point itself still walks it.
 *   - Linux second copies: a bind mount, or a subvolume also visible
 *     inside another mount, is walked once (duplicateMountPathsFrom).
 *   - macOS firmlinks. `/` is the sealed System volume and user files
 *     live on the Data volume at /System/Volumes/Data. /usr/share/firmlinks
 *     joins them: /Users and /System/Volumes/Data/Users are one directory.
 *     When both names are under the scan root, the walk keeps /Users and
 *     skips the Data-side twin. Data-only content (.Spotlight-V100,
 *     .fseventsd, MobileSoftwareUpdate, …) has no twin and is walked once.
 */

export interface ScanPrunePlan {
  /** Mount points below the root that belong to another filesystem. */
  otherMounts: Set<string>;
  /** Linux: second paths to files another mount of the root's filesystem already shows. */
  duplicateMounts: Set<string>;
  /** Data-volume names of directories reached through a firmlink below the root. */
  firmlinkTwins: Set<string>;
}

export type PruneReason = "other-mount" | "duplicate-mount" | "firmlink-twin";

export const emptyPrunePlan = (): ScanPrunePlan => ({
  otherMounts: new Set(),
  duplicateMounts: new Set(),
  firmlinkTwins: new Set(),
});

/** Why the walk must not enter the directory `path`, or null to keep it. */
export function skipReason(plan: ScanPrunePlan, path: string): PruneReason | null {
  if (plan.otherMounts.has(path)) return "other-mount";
  if (plan.duplicateMounts.has(path)) return "duplicate-mount";
  if (plan.firmlinkTwins.has(path)) return "firmlink-twin";
  return null;
}

/** Where macOS mounts the startup disk's Data volume. */
export const MAC_DATA_VOLUME = "/System/Volumes/Data";

/** A directory reachable as `system` (/Users) and as `data` (/System/Volumes/Data/Users). */
export interface Firmlink {
  system: string;
  data: string;
}

function trimMountPoint(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** `path` is strictly below `root`. */
function isUnder(root: string, path: string): boolean {
  if (root === "/") return path.length > 1 && path.startsWith("/");
  return path.startsWith(root) && path.charCodeAt(root.length) === 0x2f;
}

function isAtOrUnder(root: string, path: string): boolean {
  return path === root || isUnder(root, path);
}

/** Each line of /usr/share/firmlinks is `<path on />\t<path relative to the Data volume>`. */
export function parseFirmlinks(text: string): Firmlink[] {
  const links: Firmlink[] = [];
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const system = trimMountPoint(line.slice(0, tab));
    const relative = line.slice(tab + 1).replace(/\r$/, "").replace(/^\/+|\/+$/g, "");
    if (!system.startsWith("/") || system === "/" || !relative) continue;
    links.push({ system, data: `${MAC_DATA_VOLUME}/${relative}` });
  }
  return links;
}

/**
 * Mount points from macOS `mount`, which reads the kernel's cached table
 * (getfsstat with MNT_NOWAIT), so a dead network share can't hang it the
 * way it can hang `df`. Lines look like
 * `//me@nas/Media%20Share on /Volumes/Media Share (smbfs, nodev, nosuid)`.
 * The mount point runs to the last ` (`: macOS doesn't escape spaces or
 * parentheses in it.
 */
export function parseMacMountPoints(stdout: string): string[] {
  const points: string[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^.+? on (\/.*) \([^()]*\)$/.exec(line.trim());
    if (match?.[1]) points.push(trimMountPoint(match[1]));
  }
  return points;
}

/** The other names of `path` through firmlinks, e.g. /Users/me ↔ /System/Volumes/Data/Users/me. */
function firmlinkAliases(path: string, firmlinks: Firmlink[]): string[] {
  const aliases: string[] = [];
  for (const link of firmlinks) {
    if (isAtOrUnder(link.system, path)) aliases.push(link.data + path.slice(link.system.length));
    if (isAtOrUnder(link.data, path)) aliases.push(link.system + path.slice(link.data.length));
  }
  return aliases;
}

/**
 * The mount point of the filesystem `path` lives on. The mount table can
 * name a mount by either side of a firmlink, and the longest literal
 * prefix of /Users/me is `/` though it lives on the Data volume, so every
 * alias is checked.
 */
function owningMount(path: string, mounts: string[], firmlinks: Firmlink[]): string | null {
  const names = [path, ...firmlinkAliases(path, firmlinks)];
  let best: string | null = null;
  for (const point of mounts) {
    if (!names.some((name) => isAtOrUnder(point, name))) continue;
    if (best === null || point.length > best.length) best = point;
  }
  return best;
}

/** The sealed System volume and its Data volume are one startup disk. */
const isStartupVolume = (point: string) => point === "/" || point === MAC_DATA_VOLUME;

/** Pure half of the macOS plan: `mounts` from the mount table, `firmlinks` already verified. */
export function macPrunePlan(root: string, mounts: string[], firmlinks: Firmlink[]): ScanPrunePlan {
  const trimmed = trimMountPoint(root);
  const plan = emptyPrunePlan();

  for (const link of firmlinks) {
    if (isUnder(trimmed, link.data) && isAtOrUnder(trimmed, link.system)) {
      plan.firmlinkTwins.add(link.data);
    }
  }

  const rootMount = owningMount(trimmed, mounts, firmlinks);
  if (rootMount === null) return plan;
  for (const point of mounts) {
    const sameDisk = point === rootMount || (isStartupVolume(point) && isStartupVolume(rootMount));
    if (sameDisk) continue;
    for (const name of [point, ...firmlinkAliases(point, firmlinks)]) {
      if (isUnder(trimmed, name)) plan.otherMounts.add(name);
    }
  }
  return plan;
}

/**
 * Firmlinks whose two names really are one directory. /usr/share/firmlinks
 * lists some a Mac doesn't have: /pkg can exist on the Data volume with no
 * /pkg on `/`, and then the Data side is the only way in.
 */
async function loadFirmlinks(): Promise<Firmlink[]> {
  let text: string;
  try {
    text = await FS.readFile("/usr/share/firmlinks", "utf8");
  } catch {
    return [];
  }
  const checked = await Promise.all(
    parseFirmlinks(text).map(async (link) => {
      try {
        const [system, data] = await Promise.all([
          FS.stat(link.system, { bigint: true }),
          FS.stat(link.data, { bigint: true }),
        ]);
        return system.isDirectory() && system.dev === data.dev && system.ino === data.ino ? link : null;
      } catch {
        return null;
      }
    }),
  );
  return checked.filter((link): link is Firmlink => link !== null);
}

function loadMacMountPoints(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("/sbin/mount", { timeout: 5_000 }, (error, stdout) => {
      resolve(error ? [] : parseMacMountPoints(stdout));
    });
  });
}

export async function loadScanPrunePlan(root: string): Promise<ScanPrunePlan> {
  if (process.platform === "linux") {
    const { foreign, duplicates } = linuxMountPrunes(root);
    return { ...emptyPrunePlan(), otherMounts: foreign, duplicateMounts: duplicates };
  }
  if (process.platform !== "darwin") return emptyPrunePlan();
  const [mounts, firmlinks] = await Promise.all([loadMacMountPoints(), loadFirmlinks()]);
  return macPrunePlan(root, mounts, firmlinks);
}
