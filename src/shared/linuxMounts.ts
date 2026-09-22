import { readFileSync } from "node:fs";

/**
 * Linux scans stay on the filesystem they started on.
 *
 * btrfs subvolumes of one pool share a major:minor in
 * /proc/self/mountinfo, so a scan of `/` still includes `/home` when
 * both are subvolumes of the same disk. `stat.dev` is the wrong key:
 * btrfs gives each subvolume its own st_dev even though `df` shows
 * one pool. NTFS at `/mnt/windows`, tmpfs, and FUSE mounts have a
 * different id and are left for their own drive pill.
 */

export interface LinuxMount {
  point: string;
  dev: string;
}

export function unescapeMountinfo(field: string): string {
  const bytes = Buffer.from(field, "utf8");
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    if (
      bytes[i] === 0x5c &&
      i + 3 < bytes.length &&
      bytes[i + 1] >= 0x30 &&
      bytes[i + 1] <= 0x39 &&
      bytes[i + 2] >= 0x30 &&
      bytes[i + 2] <= 0x39 &&
      bytes[i + 3] >= 0x30 &&
      bytes[i + 3] <= 0x39
    ) {
      const oct = bytes.subarray(i + 1, i + 4).toString("ascii");
      const value = Number.parseInt(oct, 8);
      if (Number.isFinite(value)) {
        out.push(value);
        i += 3;
        continue;
      }
    }
    out.push(bytes[i]);
  }
  return Buffer.from(out).toString("utf8");
}

function trimMountPoint(path: string): string {
  if (path.length > 1) return path.replace(/\/+$/, "");
  return path;
}

export function parseMountinfo(text: string): LinuxMount[] {
  const mounts: LinuxMount[] = [];
  for (const line of text.split("\n")) {
    const dash = line.indexOf(" - ");
    if (dash < 0) continue;
    const fields = line.slice(0, dash).split(" ");
    if (fields.length < 5) continue;
    const dev = fields[2] ?? "";
    if (!dev.includes(":")) continue;
    const point = trimMountPoint(unescapeMountinfo(fields[4] ?? ""));
    if (!point) continue;
    mounts.push({ point, dev });
  }
  return mounts;
}

function pathIsUnder(root: string, path: string): boolean {
  if (root === "/") return path !== "/";
  return path.startsWith(root) && path.charCodeAt(root.length) === 0x2f;
}

/** Mount points under `root` that live on a different filesystem. */
export function foreignMountPointsFrom(root: string, mounts: LinuxMount[]): Set<string> {
  const trimmed = trimMountPoint(root);
  let rootDev: string | null = null;
  let bestLen = -1;
  for (const mount of mounts) {
    const matches = trimmed === mount.point || pathIsUnder(mount.point, trimmed);
    if (!matches || mount.point.length <= bestLen) continue;
    bestLen = mount.point.length;
    rootDev = mount.dev;
  }
  if (!rootDev) return new Set();
  const foreign = new Set<string>();
  for (const mount of mounts) {
    if (mount.dev === rootDev) continue;
    if (!pathIsUnder(trimmed, mount.point)) continue;
    foreign.add(mount.point);
  }
  return foreign;
}

export function foreignMountPoints(root: string): Set<string> {
  if (process.platform !== "linux") return new Set();
  try {
    const text = readFileSync("/proc/self/mountinfo", "utf8");
    return foreignMountPointsFrom(root, parseMountinfo(text));
  } catch {
    return new Set();
  }
}
