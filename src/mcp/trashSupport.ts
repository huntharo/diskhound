import { execFile } from "node:child_process";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { promisify } from "node:util";

import { trashName, type RemovalMountInside, type RemovalVolumeCheck } from "../shared/agentRemovals";
import { formatSizeBytes } from "../shared/sizeUnits";
import { unescapeMountinfo } from "../shared/linuxMounts";

const execFileAsync = promisify(execFile);

/**
 * Whether the Trash (Recycle Bin on Windows) can take an item, worked
 * out before DiskHound ever labels it "moves to the Trash".
 *
 * - macOS: network volumes (smbfs, afpfs, nfs, webdav) have no Trash,
 *   and read-only ones can't be changed at all. `mount` lists both.
 * - Linux: Electron trashes through gio. On the home folder's device an
 *   item goes to ~/.local/share/Trash. Elsewhere gio wants
 *   `<top>/.Trash/<uid>` or `<top>/.Trash-<uid>` at the mount's top,
 *   creating the second when it can, and refuses "system internal"
 *   mounts outright: tmpfs, overlay, nfs, cifs and the like, and mounts
 *   at /, /mnt, /var and similar paths. /proc/self/mountinfo has the type,
 *   the path and the ro flag.
 * - Windows: network and removable drives have no Recycle Bin, a drive
 *   can have it turned off, and an item bigger than the bin's quota
 *   isn't recycled (Explorer deletes it; Electron refuses). One
 *   PowerShell call reads every drive's type and quota.
 * - Everywhere: a folder with another volume mounted inside can't move
 *   as a unit, and a recursive delete would empty that volume too, so
 *   both actions leave mounts alone. Those are listed per item.
 */

export interface VolumeEntry {
  /** "/", "/System/Volumes/Data", "/Volumes/team-share", "C:\\", "C:\\Mounts\\Data". */
  mountPoint: string;
  /** For the user: "the startup disk", "team-share", "D:", "/mnt/scratch". */
  name: string;
  fsType: string;
  readOnly: boolean;
  /** Why this volume has no Trash, or null when it has one (Linux: see linuxTrash). */
  noTrash: string | null;
  /** macOS: st_dev of the mount point, to place paths reached through firmlinks. */
  dev?: number;
  /** Linux: mount options that say "no Trash here". */
  options?: string;
  /** Windows: the Recycle Bin's quota in bytes; null when unknown. */
  binBytes?: number | null;
  /** Windows: the drive's size, for the default quota. */
  totalBytes?: number | null;
}

export interface VolumeTable {
  platform: NodeJS.Platform;
  volumes: VolumeEntry[];
  /** Linux: st_dev of the home folder. gio sends items on that device to ~/.local/share/Trash. */
  homeDev: number | null;
  /** Linux: whose `.Trash-<uid>` gio would use. */
  uid: number | null;
}

export type VolumeLoader = () => Promise<VolumeTable>;

/** The parts of the file system the checks touch. Tests substitute these. */
export interface ProbeFs {
  lstat(path: string): Promise<{ dev: number; mode: number; isDirectory(): boolean; isSymbolicLink(): boolean; uid: number }>;
  stat(path: string): Promise<{ dev: number }>;
  access(path: string, mode: number): Promise<void>;
}

type ProbeStat = Awaited<ReturnType<ProbeFs["lstat"]>>;

const realFs: ProbeFs = {
  lstat: (path) => FS.lstat(path),
  stat: (path) => FS.stat(path),
  access: (path, mode) => FS.access(path, mode),
};

// ── macOS ─────────────────────────────────────────────────

export interface MacMount {
  device: string;
  point: string;
  fsType: string;
  options: string[];
}

/**
 * `mount` on macOS: `<device> on <point> (<type>, <option>, …)`. The
 * device can contain spaces ("map auto_home") and so can the point, so
 * split on the first " on /" and the last " (".
 */
export function parseMacMounts(text: string): MacMount[] {
  const mounts: MacMount[] = [];
  for (const line of text.split("\n")) {
    const on = line.indexOf(" on /");
    const open = line.lastIndexOf(" (");
    if (on < 0 || open < on || !line.endsWith(")")) continue;
    const [fsType = "", ...options] = line.slice(open + 2, -1).split(",").map((part) => part.trim());
    mounts.push({ device: line.slice(0, on), point: line.slice(on + 4, open), fsType, options });
  }
  return mounts;
}

const MAC_NO_TRASH_TYPES = new Set(["devfs", "autofs", "nullfs", "fdesc", "lifs"]);

function macVolumeName(point: string): string {
  if (point === "/" || point.startsWith("/System/Volumes/")) return "the startup disk";
  return Path.posix.basename(point) || point;
}

export function macVolumes(mounts: readonly MacMount[]): VolumeEntry[] {
  return mounts.map((mount) => {
    const name = macVolumeName(mount.point);
    const local = mount.options.includes("local");
    const readOnly = mount.options.includes("read-only");
    const noTrash = !local
      ? `${name} is a network volume with no Trash.`
      : MAC_NO_TRASH_TYPES.has(mount.fsType)
        ? `${name} has no Trash.`
        : null;
    return { mountPoint: mount.point, name, fsType: mount.fsType, readOnly, noTrash };
  });
}

async function loadMacTable(fs: ProbeFs): Promise<VolumeTable> {
  const { stdout } = await execFileAsync("/sbin/mount", [], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  const volumes = macVolumes(parseMacMounts(stdout));
  // Device ids place a path reached through a firmlink (/Users is on the
  // Data volume, not on /). Only local volumes: a stat on a network
  // volume can hang when its server is gone.
  await Promise.all(volumes.map(async (volume) => {
    if (volume.noTrash?.includes("network")) return;
    try {
      volume.dev = (await fs.stat(volume.mountPoint)).dev;
    } catch {
      /* unmounted since */
    }
  }));
  return { platform: "darwin", volumes, homeDev: null, uid: null };
}

// ── Linux ─────────────────────────────────────────────────

/**
 * glib's system-internal file system types. gio refuses to trash on
 * them ("Trashing on system internal mounts is not supported").
 */
const LINUX_SYSTEM_FS = new Set([
  "adfs", "afs", "auto", "autofs", "autofs4", "binfmt_misc", "bpf", "cgroup", "cgroup2", "cifs", "configfs", "cxfs",
  "debugfs", "devfs", "devpts", "devtmpfs", "ecryptfs", "efivarfs", "fdescfs", "fuse.gvfsd-fuse", "fuse.portal",
  "fusectl", "gfs", "gfs2", "gpfs", "hugetlbfs", "kernfs", "linprocfs", "linsysfs", "lustre", "lustre_lite", "mfs",
  "mqueue", "ncpfs", "nfs", "nfs4", "nfsd", "nullfs", "ocfs2", "overlay", "proc", "procfs", "pstore", "ptyfs",
  "rootfs", "rpc_pipefs", "securityfs", "selinuxfs", "smb3", "smbfs", "sysfs", "tmpfs", "tracefs", "usbfs",
]);

/** glib's system mount paths. A volume mounted at one of these gets no Trash folder. */
const LINUX_SYSTEM_PATHS = new Set([
  "/", "/bin", "/boot", "/compat/linux/proc", "/compat/linux/sys", "/dev", "/etc", "/home", "/lib", "/lib64",
  "/libexec", "/live/cow", "/live/image", "/media", "/mnt", "/net", "/opt", "/proc", "/rescue", "/root", "/run",
  "/sbin", "/srv", "/sys", "/sysroot", "/tmp", "/usr", "/usr/X11R6", "/usr/local", "/usr/obj", "/usr/ports",
  "/usr/src", "/usr/xobj", "/var", "/var/crash", "/var/local", "/var/log", "/var/log/audit", "/var/mail",
  "/var/run", "/var/tmp",
]);
const LINUX_SYSTEM_PREFIXES = ["/dev/", "/proc/", "/sys/", "/run/"];

export interface LinuxMountDetail {
  point: string;
  fsType: string;
  readOnly: boolean;
  /** Mount and super options, comma-separated. */
  options: string;
}

/** /proc/self/mountinfo with the type, ro flag and options kept. */
export function parseLinuxMounts(text: string): LinuxMountDetail[] {
  const mounts: LinuxMountDetail[] = [];
  for (const line of text.split("\n")) {
    const dash = line.indexOf(" - ");
    if (dash < 0) continue;
    const fields = line.slice(0, dash).split(" ");
    const tail = line.slice(dash + 3).split(" ");
    if (fields.length < 6 || tail.length < 1) continue;
    const point = unescapeMountinfo(fields[4] ?? "");
    if (!point.startsWith("/")) continue;
    const mountOptions = fields[5] ?? "";
    const superOptions = tail[2] ?? "";
    mounts.push({
      point: point.length > 1 ? point.replace(/\/+$/, "") : point,
      fsType: tail[0] ?? "",
      readOnly: mountOptions.split(",").includes("ro"),
      options: `${mountOptions},${superOptions}`,
    });
  }
  return mounts;
}

export function linuxVolumes(mounts: readonly LinuxMountDetail[]): VolumeEntry[] {
  // A later mount on the same point hides the earlier one.
  const byPoint = new Map<string, LinuxMountDetail>();
  for (const mount of mounts) byPoint.set(mount.point, mount);
  return [...byPoint.values()].map((mount) => {
    const name = mount.point;
    const system = LINUX_SYSTEM_FS.has(mount.fsType) ||
      LINUX_SYSTEM_PATHS.has(mount.point) ||
      LINUX_SYSTEM_PREFIXES.some((prefix) => mount.point.startsWith(prefix));
    const noTrash = system
      ? `${name} is a ${mount.fsType} mount, where the Trash isn't supported.`
      : mount.options.includes("x-gvfs-notrash")
        ? `${name} is mounted with no Trash.`
        : null;
    return { mountPoint: mount.point, name, fsType: mount.fsType, readOnly: mount.readOnly, noTrash, options: mount.options };
  });
}

async function loadLinuxTable(fs: ProbeFs): Promise<VolumeTable> {
  const text = await FS.readFile("/proc/self/mountinfo", "utf8");
  let homeDev: number | null = null;
  try {
    homeDev = (await fs.stat(OS.homedir())).dev;
  } catch {
    /* no home folder */
  }
  return { platform: "linux", volumes: linuxVolumes(parseLinuxMounts(text)), homeDev, uid: process.getuid?.() ?? null };
}

/**
 * Whether gio can trash on the volume mounted at `top`: a `.Trash/<uid>`
 * under a sticky `.Trash` (gio makes it if the shared folder lets it),
 * or a `.Trash-<uid>` it owns, or a writable top folder where it can
 * make one.
 */
async function linuxTrashFolder(top: string, uid: number | null, fs: ProbeFs): Promise<string | null> {
  const id = uid ?? 0;
  const sharedPath = Path.posix.join(top, ".Trash");
  let shared: ProbeStat | null = null;
  try {
    shared = await fs.lstat(sharedPath);
  } catch {
    /* none */
  }
  // gio wants it sticky and not a link.
  if (shared && !shared.isSymbolicLink() && shared.isDirectory() && (shared.mode & 0o1000) !== 0) {
    let own: ProbeStat | null = null;
    try {
      own = await fs.lstat(Path.posix.join(sharedPath, String(id)));
    } catch {
      /* not made yet */
    }
    if (own) {
      if (own.isDirectory() && !own.isSymbolicLink() && own.uid === id) return null;
      // Someone else's: gio falls back to .Trash-<uid>.
    } else {
      try {
        await fs.access(sharedPath, 3 /* W_OK | X_OK */);
        return null;
      } catch {
        /* can't make it there */
      }
    }
  }
  try {
    const own = await fs.lstat(Path.posix.join(top, `.Trash-${id}`));
    if (own.isDirectory() && !own.isSymbolicLink() && own.uid === id) return null;
  } catch {
    /* none */
  }
  try {
    await fs.access(top, 2 /* W_OK */);
    return null;
  } catch {
    return `${top} has no Trash folder, and DiskHound can't make one there.`;
  }
}

// ── Windows ───────────────────────────────────────────────

export interface WindowsDrive {
  /** "C:\\" */
  root: string;
  /** System.IO.DriveType: Fixed, Removable, Network, CDRom, Ram, NoRootDirectory, Unknown. */
  type: string;
  format: string | null;
  totalBytes: number | null;
  /** BitBucket\Volume\{guid} MaxCapacity, in MB. */
  maxMb: number | null;
  /** BitBucket\Volume\{guid} NukeOnDelete: the bin is off for this drive. */
  nuke: number | null;
}

/**
 * One PowerShell call: each drive's type and size, and its Recycle Bin
 * quota from the current user's registry. Volumes mounted on folders
 * come from Win32_Volume names like `C:\Mounts\Data\`.
 */
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$guids = @{}
$folders = @()
foreach ($v in Get-CimInstance -ClassName Win32_Volume) {
  if ($v.DriveLetter) { $guids[$v.DriveLetter.ToUpper()] = $v.DeviceID }
  elseif ($v.Name -match '^[A-Za-z]:\\.+') { $folders += $v.Name }
}
$bin = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\'
$drives = @()
foreach ($d in [System.IO.DriveInfo]::GetDrives()) {
  $row = [ordered]@{ root = $d.Name; type = [string]$d.DriveType; format = $null; totalBytes = $null; maxMb = $null; nuke = $null }
  try { if ($d.IsReady) { $row.format = $d.DriveFormat; $row.totalBytes = $d.TotalSize } } catch {}
  $id = $guids[$d.Name.Substring(0, 2).ToUpper()]
  if ($id -match '(\{[0-9A-Fa-f-]+\})') {
    $p = Get-ItemProperty -LiteralPath ($bin + $Matches[1])
    if ($p) { $row.maxMb = $p.MaxCapacity; $row.nuke = $p.NukeOnDelete }
  }
  $drives += [pscustomobject]$row
}
ConvertTo-Json -Compress -Depth 3 -InputObject ([ordered]@{ drives = @($drives); folders = @($folders) })
`;

export function windowsVolumes(raw: { drives?: unknown; folders?: unknown }): VolumeEntry[] {
  const drives = (Array.isArray(raw.drives) ? raw.drives : [raw.drives]).filter(Boolean) as WindowsDrive[];
  const volumes: VolumeEntry[] = drives.map((drive) => {
    const name = drive.root.replace(/\\$/, "");
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    const noTrash =
      drive.type === "Network" ? `${name} is a network drive with no Recycle Bin.`
      : drive.type === "Removable" ? `${name} is a removable drive with no Recycle Bin.`
      : drive.type === "CDRom" ? `${name} is a disc drive with no Recycle Bin.`
      : drive.type !== "Fixed" ? `${name} has no Recycle Bin.`
      : number(drive.nuke) === 1 ? `The Recycle Bin is turned off for ${name}.`
      : null;
    const maxMb = number(drive.maxMb);
    return {
      mountPoint: drive.root.endsWith("\\") ? drive.root : `${drive.root}\\`,
      name,
      fsType: drive.format ?? "",
      readOnly: drive.type === "CDRom",
      noTrash,
      binBytes: maxMb === null ? null : maxMb * 1024 * 1024,
      totalBytes: number(drive.totalBytes),
    };
  });
  const folders = (Array.isArray(raw.folders) ? raw.folders : [raw.folders]).filter((value): value is string => typeof value === "string");
  for (const folder of folders) {
    const point = folder.replace(/\\+$/, "");
    volumes.push({ mountPoint: point, name: Path.win32.basename(point), fsType: "", readOnly: false, noTrash: null, binBytes: null });
  }
  return volumes;
}

async function loadWindowsTable(): Promise<VolumeTable> {
  const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT], {
    timeout: 20_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return { platform: "win32", volumes: windowsVolumes(JSON.parse(stdout.trim() || "{}")), homeDev: null, uid: null };
}

export function systemVolumeLoader(platform: NodeJS.Platform = process.platform, fs: ProbeFs = realFs): VolumeLoader {
  return () => (platform === "darwin" ? loadMacTable(fs) : platform === "win32" ? loadWindowsTable() : loadLinuxTable(fs));
}

// ── The check ─────────────────────────────────────────────

function pathKey(path: string, platform: NodeJS.Platform): string {
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
  return platform === "win32" || platform === "darwin" ? trimmed.toLowerCase() : trimmed;
}

/** `inner` is `outer` or below it. */
function within(outer: string, inner: string, platform: NodeJS.Platform): boolean {
  const o = pathKey(outer, platform);
  const i = pathKey(inner, platform);
  const sep = platform === "win32" ? "\\" : "/";
  return i === o || i.startsWith(o.endsWith(sep) ? o : o + sep);
}

/** Windows' default bin size when the user never set one: 5% of the drive. */
const DEFAULT_BIN_SHARE = 0.05;

export class TrashProbe {
  private cached: { table: VolumeTable; at: number } | null = null;
  private loading: Promise<VolumeTable> | null = null;

  constructor(
    private readonly load: VolumeLoader,
    private readonly options: {
      platform?: NodeJS.Platform;
      fs?: ProbeFs;
      now?: () => number;
      /** Volumes change rarely; one table serves this long. */
      ttlMs?: number;
      sizeText?: (bytes: number) => string;
    } = {},
  ) {}

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  private get fs(): ProbeFs {
    return this.options.fs ?? realFs;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The volume table, loaded at most once per `ttlMs`. Throws if it can't be read. */
  async table(): Promise<VolumeTable> {
    const ttl = this.options.ttlMs ?? 60_000;
    if (this.cached && this.now() - this.cached.at < ttl) return this.cached.table;
    this.loading ??= this.load().then(
      (table) => {
        this.cached = { table, at: this.now() };
        this.loading = null;
        return table;
      },
      (error: unknown) => {
        this.loading = null;
        throw error;
      },
    );
    return this.loading;
  }

  /** Forget the table: the next check reads the volumes again. */
  invalidate(): void {
    this.cached = null;
  }

  /** The volume mounted exactly at `path`, if any. Such a path can't be moved or deleted. */
  async mountedAt(path: string): Promise<string | null> {
    try {
      const table = await this.table();
      const key = pathKey(path, this.platform);
      const volume = table.volumes.find((candidate) => pathKey(candidate.mountPoint, this.platform) === key);
      return volume ? volume.name : null;
    } catch {
      return null;
    }
  }

  /** Check every item against one volume table. */
  async check(items: readonly { path: string; sizeBytes: number | null }[]): Promise<RemovalVolumeCheck[]> {
    let table: VolumeTable;
    try {
      table = await this.table();
    } catch (error) {
      // Fail closed: without the table, a folder could hold another volume that a delete would walk into.
      const why = `DiskHound couldn't read the list of volumes (${error instanceof Error ? error.message : String(error)}), so it can't tell whether another volume is mounted inside or whether the ${trashName(this.platform)} can take it.`;
      return items.map(() => ({ volume: null, trash: "unknown", trashWhy: why, readOnly: false, mountsInside: [], volumesUnknown: true, checkedAt: this.now() }));
    }
    const linuxTrash = new Map<string, Promise<string | null>>();
    return Promise.all(items.map((item) => this.checkOne(item.path, item.sizeBytes, table, linuxTrash)));
  }

  private async volumeOf(path: string, table: VolumeTable): Promise<VolumeEntry | null> {
    const { platform } = this;
    const deepest = (candidates: readonly VolumeEntry[]) =>
      candidates
        .filter((volume) => within(volume.mountPoint, path, platform))
        .sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0] ?? null;
    if (platform === "win32") {
      // Drive letters only: a volume on a folder is a link, and the path's own drive decides.
      return deepest(table.volumes.filter((volume) => /^[A-Za-z]:\\$/.test(volume.mountPoint)));
    }
    if (platform === "darwin") {
      const network = deepest(table.volumes.filter((volume) => volume.dev === undefined));
      if (network && network.noTrash) return network;
      try {
        const { dev } = await this.fs.lstat(path);
        const byDev = table.volumes.filter((volume) => volume.dev === dev);
        // macOS 26 reports one device for an APFS volume group: the sealed,
        // read-only system volume at / and its Data volume alike. Every
        // path that can be written is on the Data side (firmlinks), and
        // macOS mounts each volume once, so the writable entry wins.
        const writable = byDev.filter((volume) => !volume.readOnly);
        const candidates = writable.length > 0 ? writable : byDev;
        if (candidates.length > 0) return deepest(candidates) ?? candidates[0]!;
      } catch {
        /* gone; fall back to the path */
      }
    }
    return deepest(table.volumes);
  }

  private async checkOne(
    path: string,
    sizeBytes: number | null,
    table: VolumeTable,
    linuxTrash: Map<string, Promise<string | null>>,
  ): Promise<RemovalVolumeCheck> {
    const { platform } = this;
    const checkedAt = this.now();
    const volume = await this.volumeOf(path, table);
    const mountsInside: RemovalMountInside[] = table.volumes
      .filter((candidate) => candidate !== volume && pathKey(candidate.mountPoint, platform) !== pathKey(path, platform) && within(path, candidate.mountPoint, platform))
      .sort((a, b) => a.mountPoint.localeCompare(b.mountPoint))
      .map((candidate) => ({ path: candidate.mountPoint, volume: candidate.name }));
    if (!volume) {
      return { volume: null, trash: "unknown", trashWhy: `DiskHound couldn't tell which volume this is on.`, readOnly: false, mountsInside, selfMount: false, checkedAt };
    }
    const selfMount = pathKey(path, platform) === pathKey(volume.mountPoint, platform);
    const base = { volume: volume.name, readOnly: volume.readOnly, mountsInside, selfMount, checkedAt };

    if (platform === "linux") {
      // gio puts anything on the home folder's device in the home Trash,
      // whatever the mount; only other devices need a Trash at their top.
      let onHome = false;
      try {
        onHome = table.homeDev !== null && (await this.fs.lstat(path)).dev === table.homeDev;
      } catch {
        /* gone */
      }
      if (onHome) return { ...base, trash: "yes" };
      if (volume.noTrash) return { ...base, trash: "no", trashWhy: volume.noTrash };
      let pending = linuxTrash.get(volume.mountPoint);
      if (!pending) {
        pending = linuxTrashFolder(volume.mountPoint, table.uid, this.fs);
        linuxTrash.set(volume.mountPoint, pending);
      }
      const why = await pending;
      return why ? { ...base, trash: "no", trashWhy: why } : { ...base, trash: "yes" };
    }

    if (volume.noTrash) return { ...base, trash: "no", trashWhy: volume.noTrash };

    if (platform === "win32") {
      const binBytes = volume.binBytes ?? null;
      const size = (bytes: number) => (this.options.sizeText ?? ((value: number) => formatSizeBytes(value, 1024)))(bytes);
      if (binBytes !== null) {
        if (sizeBytes !== null && sizeBytes > binBytes) {
          return {
            ...base,
            trash: "no",
            trashWhy: `It's bigger than the Recycle Bin on ${volume.name} (${size(binBytes)}). Windows would delete it permanently instead.`,
          };
        }
        if (sizeBytes === null) {
          return { ...base, trash: "unknown", trashWhy: `DiskHound doesn't know its size, so it can't tell whether the Recycle Bin on ${volume.name} (${size(binBytes)}) can hold it.` };
        }
      } else if (volume.totalBytes) {
        const guess = volume.totalBytes * DEFAULT_BIN_SHARE;
        if (sizeBytes === null || sizeBytes > guess) {
          return {
            ...base,
            trash: "unknown",
            trashWhy: sizeBytes === null
              ? `DiskHound doesn't know its size or the Recycle Bin's on ${volume.name}, so it can't tell whether the bin can hold it.`
              : `It may be bigger than the Recycle Bin on ${volume.name} (about ${size(guess)} unless you changed it).`,
          };
        }
      }
    }
    return { ...base, trash: "yes" };
  }
}
