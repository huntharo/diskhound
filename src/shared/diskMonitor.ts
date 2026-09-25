import { execFile } from "node:child_process";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { promisify } from "node:util";

import type { DiskDelta, DiskSpaceInfo, MonitoringSnapshot } from "./contracts";

const execFileAsync = promisify(execFile);
const BASELINE_FILE = "disk-baselines.json";
/**
 * How many historical drive-level deltas to keep. With a 30-min check cadence
 * this is ~10 days of signal — plenty to render a timeline on the Changes tab
 * without bloating the persisted JSON beyond ~50 KB.
 */
const DELTA_HISTORY_CAP = 500;

interface PersistedState {
  previousDrives: Record<string, DiskSpaceInfo>;
  lastFullScanAt: number | null;
  lastDrives?: DiskSpaceInfo[];
  lastDeltas?: DiskDelta[];
  lastCheckedAt?: number;
  /** Rolling history of drive-level deltas (newest first). */
  deltaHistory?: DiskDelta[];
}

let previousDriveMap = new Map<string, DiskSpaceInfo>();
let lastFullScanAt: number | null = null;
let persistDir: string | null = null;
let lastDrives: DiskSpaceInfo[] = [];
let lastDeltas: DiskDelta[] = [];
let lastCheckedAt = 0;
let deltaHistory: DiskDelta[] = [];

// ── Initialization (call once at startup) ───────────────────

export async function initDiskMonitor(dataDir: string): Promise<void> {
  persistDir = dataDir;
  try {
    const raw = await FS.readFile(Path.join(dataDir, BASELINE_FILE), "utf8");
    const state = JSON.parse(raw) as PersistedState;
    previousDriveMap = new Map(Object.entries(state.previousDrives ?? {}));
    lastFullScanAt = state.lastFullScanAt ?? null;
    lastDrives = Array.isArray(state.lastDrives) ? state.lastDrives : [];
    lastDeltas = Array.isArray(state.lastDeltas) ? state.lastDeltas : [];
    lastCheckedAt =
      typeof state.lastCheckedAt === "number" && Number.isFinite(state.lastCheckedAt)
        ? state.lastCheckedAt
        : 0;
    deltaHistory = Array.isArray(state.deltaHistory)
      ? state.deltaHistory.slice(0, DELTA_HISTORY_CAP)
      : [];
  } catch {
    // No existing baseline — fresh start
  }
}

async function persistState(): Promise<void> {
  if (!persistDir) return;
  const state: PersistedState = {
    previousDrives: Object.fromEntries(previousDriveMap),
    lastFullScanAt,
    lastDrives,
    lastDeltas,
    lastCheckedAt,
    deltaHistory,
  };
  try {
    await FS.mkdir(persistDir, { recursive: true });
    await FS.writeFile(
      Path.join(persistDir, BASELINE_FILE),
      JSON.stringify(state, null, 2),
      "utf8",
    );
  } catch {
    // Non-fatal — baselines will be lost on restart
  }
}

// ── Public API ──────────────────────────────────────────────

export async function getDiskSpace(): Promise<DiskSpaceInfo[]> {
  if (process.platform === "win32") {
    return getWindowsDiskSpace();
  }
  if (process.platform === "darwin") {
    return getMacDiskSpace();
  }
  return getLinuxDiskSpace();
}

export async function checkDiskDeltas(): Promise<MonitoringSnapshot> {
  const drives = await getDiskSpace();
  const deltas: DiskDelta[] = [];
  const now = Date.now();

  for (const drive of drives) {
    const prev = previousDriveMap.get(drive.drive);
    if (prev) {
      const deltaBytes = drive.freeBytes - prev.freeBytes;
      const deltaPercent = prev.totalBytes > 0
        ? ((drive.freeBytes - prev.freeBytes) / prev.totalBytes) * 100
        : 0;

      // Only record meaningful changes (> 1 MB noise floor)
      if (Math.abs(deltaBytes) > 1_048_576) {
        deltas.push({
          drive: drive.drive,
          previousFreeBytes: prev.freeBytes,
          currentFreeBytes: drive.freeBytes,
          deltaBytes,
          deltaPercent,
          measuredAt: now,
        });
      }
    }
  }

  previousDriveMap = new Map(drives.map((d) => [d.drive, d]));
  lastDrives = drives;
  lastDeltas = deltas;
  lastCheckedAt = now;

  // Append any meaningful deltas from this check to the rolling timeline so
  // the UI can render drive-level events between full scans.
  if (deltas.length > 0) {
    deltaHistory = [...deltas, ...deltaHistory].slice(0, DELTA_HISTORY_CAP);
  }

  void persistState();

  return {
    drives: lastDrives,
    deltas: lastDeltas,
    lastFullScanAt,
    lastCheckedAt,
  };
}

export function getMonitoringSnapshot(): MonitoringSnapshot {
  return {
    drives: lastDrives,
    deltas: lastDeltas,
    lastFullScanAt,
    lastCheckedAt,
  };
}

export function markFullScan(): void {
  lastFullScanAt = Date.now();
  void persistState();
}

export function getLastFullScanAt(): number | null {
  return lastFullScanAt;
}

/** Return the rolling drive-level delta timeline, newest first. */
export function getDiskDeltaHistory(): DiskDelta[] {
  return deltaHistory.slice();
}

// ── Platform-specific disk space queries ────────────────────

async function getWindowsDiskSpace(): Promise<DiskSpaceInfo[]> {
  // wmic.exe is deprecated/removed on recent Windows. CIM is the supported
  // replacement and already the data source behind `Get-PSDrive`.
  try {
    const script = [
      "Get-CimInstance -ClassName Win32_LogicalDisk -Filter \"DriveType=3\"",
      "| Select-Object DeviceID, FreeSpace, Size",
      "| ConvertTo-Json -Compress",
    ].join(" ");
    const { stdout } = await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 15_000, windowsHide: true },
    );
    const drives = parseWindowsCimLogicalDisks(stdout, Date.now());
    if (drives.length > 0) return drives;
  } catch {
    // fall through
  }
  return getWindowsDiskSpaceFallback();
}

export function parseWindowsCimLogicalDisks(stdout: string, timestamp: number): DiskSpaceInfo[] {
  const cleaned = stdout.replace(/^\uFEFF/, "").trim();
  if (!cleaned) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const drives: DiskSpaceInfo[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as { DeviceID?: unknown; FreeSpace?: unknown; Size?: unknown };
    const deviceId = typeof row.DeviceID === "string" ? row.DeviceID.trim() : "";
    const freeSpace = Number(row.FreeSpace);
    const totalSize = Number(row.Size);
    if (!deviceId || !Number.isFinite(freeSpace) || !Number.isFinite(totalSize) || totalSize <= 0) {
      continue;
    }
    drives.push({
      drive: deviceId,
      totalBytes: totalSize,
      freeBytes: freeSpace,
      usedBytes: totalSize - freeSpace,
      usedPercent: ((totalSize - freeSpace) / totalSize) * 100,
      timestamp,
    });
  }
  return drives;
}

async function getWindowsDiskSpaceFallback(): Promise<DiskSpaceInfo[]> {
  try {
    const script = `Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | Select-Object Name, Used, Free | ConvertTo-Json`;
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script], {
      timeout: 15_000,
    });

    const parsed = JSON.parse(stdout);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const drives: DiskSpaceInfo[] = [];

    for (const item of items) {
      const name = `${item.Name}:`;
      const used = Number(item.Used) || 0;
      const free = Number(item.Free) || 0;
      const total = used + free;
      if (total === 0) continue;

      drives.push({
        drive: name,
        totalBytes: total,
        freeBytes: free,
        usedBytes: used,
        usedPercent: (used / total) * 100,
        timestamp: Date.now(),
      });
    }

    return drives;
  } catch {
    return [];
  }
}

/**
 * Filesystem types that represent real user storage we want to surface.
 * Ordering by frequency: ext4 covers most Linux desktops, btrfs common on
 * modern distros, NTFS/exFAT/FAT used on removable media. Types NOT in
 * this allow-list (tmpfs, proc, sysfs, cgroup, devtmpfs, squashfs,
 * overlay, fusectl, etc.) are virtual/pseudo filesystems that shouldn't
 * appear in the drive picker — users don't scan "memory" or cgroups.
 */
const REAL_FILESYSTEM_TYPES = new Set([
  "ext2", "ext3", "ext4",
  "btrfs",
  "xfs",
  "zfs",
  "reiserfs",
  "jfs",
  "f2fs",
  "ntfs", "ntfs3",       // ntfs-3g (fuse) or kernel ntfs3
  "exfat",
  "vfat", "msdos", "fat",
  "udf",                 // DVD/CD data
  "iso9660",             // mounted ISO images (sometimes worth scanning)
  "hfs", "hfsplus",
  "apfs",
  "nfs", "nfs4",
  "cifs", "smbfs",
  "fuseblk",             // fuse-mounted block devices (exfat-fuse, etc.)
]);

async function getLinuxDiskSpace(): Promise<DiskSpaceInfo[]> {
  try {
    // GNU `df -P -k -T` includes the filesystem type
    // as an extra column. Adding -T upfront means we never need to
    // cross-reference /proc/mounts — one subprocess, one parse pass.
    // Column layout with -T:
    //   Filesystem  Type  1024-blocks  Used  Available  Capacity  Mounted on
    const { stdout } = await execFileAsync("df", ["-P", "-k", "-T"], { timeout: 10_000 });
    const lines = stdout.trim().split("\n").slice(1);
    const drives: DiskSpaceInfo[] = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 7) continue;

      const fsType = (parts[1] ?? "").toLowerCase();
      const totalKb = parseInt(parts[2] ?? "0", 10);
      const usedKb = parseInt(parts[3] ?? "0", 10);
      const freeKb = parseInt(parts[4] ?? "0", 10);
      const mount = parts.slice(6).join(" ");

      // Skip if zero-sized (empty tmpfs instances, broken mounts)
      if (totalKb === 0) continue;
      // Skip snap-specific mount bind points (each installed snap shows
      // up as a squashfs loopback under /snap/<name>/<rev>).
      if (mount.startsWith("/snap")) continue;
      // Skip the EFI boot partition — small, not user-actionable.
      if (mount.startsWith("/boot")) continue;

      // Allow-list filter: only real user-storage filesystem types pass.
      // Before 0.5.2 there was no type filter and /run (tmpfs), /dev/shm
      // (tmpfs), /run/lock (tmpfs), /run/user/1000 (tmpfs) all appeared
      // in the drive picker — useless entries taking up valuable UI
      // space. Virtual / pseudo filesystems (tmpfs, devtmpfs, proc,
      // sysfs, cgroup, overlay, squashfs, fusectl, etc.) are not
      // user-scannable storage, so we drop them here.
      if (fsType && !REAL_FILESYSTEM_TYPES.has(fsType)) continue;

      drives.push({
        drive: mount,
        totalBytes: totalKb * 1024,
        freeBytes: freeKb * 1024,
        usedBytes: usedKb * 1024,
        usedPercent: totalKb > 0 ? (usedKb / totalKb) * 100 : 0,
        timestamp: Date.now(),
      });
    }

    return drives;
  } catch {
    return [];
  }
}

async function getMacDiskSpace(): Promise<DiskSpaceInfo[]> {
  try {
    // macOS/BSD `df` does not support GNU `-T`, so keep this path
    // separate from Linux. `-P -k` gives stable POSIX columns:
    //   Filesystem  1024-blocks  Used  Available  Capacity  Mounted on
    const { stdout } = await execFileAsync("df", ["-P", "-k"], { timeout: 10_000 });
    return parseMacDfOutput(stdout, Date.now());
  } catch {
    return [];
  }
}

function diskSpaceFromKb(
  drive: string,
  totalKb: number,
  usedKb: number,
  freeKb: number,
  timestamp: number,
): DiskSpaceInfo | null {
  if (!drive || totalKb <= 0) return null;
  return {
    drive,
    totalBytes: totalKb * 1024,
    freeBytes: freeKb * 1024,
    usedBytes: usedKb * 1024,
    usedPercent: (usedKb / totalKb) * 100,
    timestamp,
  };
}

export function parseMacDfOutput(stdout: string, timestamp = Date.now()): DiskSpaceInfo[] {
  const lines = stdout.trim().split(/\r?\n/).slice(1);
  const drives: DiskSpaceInfo[] = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;

    const filesystem = parts[0] ?? "";
    const totalKb = parseInt(parts[1] ?? "0", 10);
    const freeKb = parseInt(parts[3] ?? "0", 10);
    const mount = parts.slice(5).join(" ");

    if (!isMacUserStorage(filesystem, mount)) continue;

    // `/` on macOS 10.15+ is the sealed, read-only System volume
    // snapshot, so its Used column is the OS alone (~12 GB). User data
    // lives on /System/Volumes/Data in the same APFS container. Every
    // volume in a container reports the container's size as its total
    // and the container's free space as its Available, so
    // total - available is the whole container's usage: System, Data,
    // VM (swap), Preboot, and the unmounted Recovery volume. That
    // matches "Capacity In Use By Volumes" in `diskutil apfs list`, and
    // it keeps used + free = total so the bar and the free figure
    // agree. The Data row's Used alone would leave out the OS, swap,
    // Preboot, and Recovery, space the user cannot write into either.
    // It also needs no Data row, so it holds for HFS+ and pre-Catalina
    // startup disks. Purgeable space counts as used, as it does in
    // df's Available.
    const usedKb = mount === "/"
      ? Math.max(0, totalKb - freeKb)
      : parseInt(parts[2] ?? "0", 10);

    const disk = diskSpaceFromKb(mount, totalKb, usedKb, freeKb, timestamp);
    if (disk) drives.push(disk);
  }

  return drives;
}

/**
 * Mount trees macOS manages itself. None of them is storage the user
 * can free space on, so none gets a drive card:
 *   - /System: the startup container's other volumes (Data, VM,
 *     Preboot, Update), which `/` already accounts for, and the
 *     iSCPreboot, xarts, and Hardware firmware volumes.
 *   - /Library/Developer/CoreSimulator: Xcode simulator runtime disk
 *     images, read-only and nearly full by design.
 *   - /private/var/run: cryptexd mounts (MetalToolchain and other
 *     MobileAsset cryptexes), also read-only images.
 *   - /private/var/folders: per-user temp and cache space, where
 *     installers and App Translocation mount disk images.
 *   - /private/var/vm: swap on pre-Catalina systems.
 * Most are /dev/disk* devices, so the fallback at the end of
 * isMacUserStorage would admit them without this list.
 */
const MAC_SYSTEM_MOUNT_ROOTS = [
  "/System",
  "/Library/Developer/CoreSimulator",
  "/private/var/run",
  "/private/var/folders",
  "/private/var/vm",
];

function isAtOrUnder(root: string, path: string): boolean {
  return path === root || (path.startsWith(root) && path.charCodeAt(root.length) === 0x2f);
}

function isMacUserStorage(filesystem: string, mount: string): boolean {
  if (!mount || mount === "/dev") return false;
  // Root is the correct scan target on modern APFS Macs; the paired
  // /System/Volumes/Data mount is deliberately hidden to avoid showing
  // users two cards for what Finder presents as one startup disk.
  if (mount === "/") return true;
  if (MAC_SYSTEM_MOUNT_ROOTS.some((root) => isAtOrUnder(root, mount))) return false;
  if (mount.includes("/.MobileBackups")) return false;
  // External disks, disk images the user opened, and SMB/NFS shares
  // are normally presented here.
  if (mount.startsWith("/Volumes/")) return true;
  // Conservative fallback for direct device mounts that do not follow
  // the /Volumes convention.
  return filesystem.startsWith("/dev/");
}
