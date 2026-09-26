import { readFileSync } from "node:fs";

/**
 * Linux scans stay on the filesystem they started on, and walk each part
 * of it once.
 *
 * btrfs subvolumes of one pool share a major:minor in
 * /proc/self/mountinfo, so a scan of `/` still includes `/home` when
 * both are subvolumes of the same disk. `stat.dev` is the wrong key:
 * btrfs gives each subvolume its own st_dev even though `df` shows
 * one pool. NTFS at `/mnt/windows`, tmpfs, and FUSE mounts have a
 * different id and are left for their own drive pill.
 *
 * Mirrors the native scanner's `foreign_mount_points` and
 * `duplicate_mount_paths`.
 */

export interface LinuxMount {
  point: string;
  dev: string;
  /** Path inside the filesystem the mount shows: `/`, `/@home`, a bind's source. */
  root: string;
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
    const root = trimMountPoint(unescapeMountinfo(fields[3] ?? "/"));
    mounts.push({ point, dev, root });
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

/** `path` relative to `base`: "" when equal, "/rest" when under, null otherwise. */
function relativeMountPath(path: string, base: string): string | null {
  if (path === base) return "";
  if (base === "/") return path;
  return pathIsUnder(base, path) ? path.slice(base.length) : null;
}

function joinMountPath(base: string, rel: string): string {
  if (!rel) return base;
  return base === "/" ? rel : base + rel;
}

/**
 * Paths under `root` that would walk a second copy of files the scan
 * already reaches through another mount of the same filesystem: a bind
 * mount, a btrfs subvolume also visible inside a mounted top-level
 * volume, or openSUSE's `/.snapshots/<n>/snapshot` for the running root.
 *
 * For two walked mounts A and B on one device, where B's mountinfo root
 * is inside A's, B's files also appear inside A at A + (root(B) − root(A)).
 * That second path is pruned and B's mount point is kept. If B is mounted
 * inside that path, a bind of a folder into itself, B is pruned instead.
 * Two mounts of the same subtree keep the one mounted first. Sibling
 * subvolumes (`/` from `@`, `/home` from `@home`) are both walked.
 */
export function duplicateMountPathsFrom(root: string, mounts: LinuxMount[]): Set<string> {
  const trimmed = trimMountPoint(root);
  // A later mount on the same point hides the earlier one.
  const lastAt = new Map(mounts.map((mount, index) => [mount.point, index]));
  const visible = mounts
    .map((mount, index) => ({ mount, index }))
    .filter(({ mount, index }) => lastAt.get(mount.point) === index);
  let home: { mount: LinuxMount; index: number } | null = null;
  for (const entry of visible) {
    const matches = trimmed === entry.mount.point || pathIsUnder(entry.mount.point, trimmed);
    if (matches && (!home || entry.mount.point.length > home.mount.point.length)) home = entry;
  }
  if (!home) return new Set();
  const homeIndex = home.index;
  const homeDev = home.mount.dev;
  // The walk never gets to a mount under another filesystem's mount, or to
  // one a later mount above it covers. Pruning its source would leave
  // those files counted nowhere.
  const reachable = (index: number, mount: LinuxMount) =>
    !visible.some((above) =>
      pathIsUnder(above.mount.point, mount.point)
      && (above.index > index || (above.mount.dev !== homeDev && pathIsUnder(trimmed, above.mount.point))));
  // Each same-device mount the walk enters, where it enters, and the path
  // inside the filesystem found there.
  const walked = visible
    .filter(({ mount, index }) =>
      index === homeIndex
      || (mount.dev === homeDev && pathIsUnder(trimmed, mount.point) && reachable(index, mount)))
    .map(({ mount, index }) => {
      const entry = index === homeIndex ? trimmed : mount.point;
      return { index, entry, fs: joinMountPath(mount.root, relativeMountPath(entry, mount.point) ?? "") };
    });

  const duplicates = new Set<string>();
  for (const a of walked) {
    for (const b of walked) {
      if (a.index === b.index) continue;
      const rel = relativeMountPath(b.fs, a.fs);
      if (rel === null) continue;
      if (rel === "" && a.index < b.index) continue;
      const copy = joinMountPath(a.entry, rel);
      // Another mount inside A, at or above `copy`, covers A's files there.
      const covered = visible.some(({ mount }) =>
        pathIsUnder(a.entry, mount.point) && (mount.point === copy || pathIsUnder(mount.point, copy)));
      if (covered) continue;
      // `copy` itself is B's mount point only when B is bound onto itself,
      // and the check above already skipped that.
      duplicates.add(pathIsUnder(copy, b.entry) ? b.entry : copy);
    }
  }
  // Paths under another pruned path are never reached anyway.
  for (const path of [...duplicates]) {
    if ([...duplicates].some((other) => pathIsUnder(other, path))) duplicates.delete(path);
  }
  return duplicates;
}

/**
 * Directories a Linux walk of `root` skips: other filesystems, which have
 * their own drive pill, and second copies of this one.
 */
export function linuxMountPrunes(root: string): { foreign: Set<string>; duplicates: Set<string> } {
  if (process.platform !== "linux") return { foreign: new Set(), duplicates: new Set() };
  try {
    const mounts = parseMountinfo(readFileSync("/proc/self/mountinfo", "utf8"));
    return {
      foreign: foreignMountPointsFrom(root, mounts),
      duplicates: duplicateMountPathsFrom(root, mounts),
    };
  } catch {
    return { foreign: new Set(), duplicates: new Set() };
  }
}
