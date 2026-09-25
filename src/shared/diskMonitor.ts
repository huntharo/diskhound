import { execFile } from "node:child_process";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { promisify } from "node:util";

import type { DiskDelta, DiskSpaceInfo, MonitoringSettings, MonitoringSnapshot } from "./contracts";

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
/**
 * The drives df last reported, returned when a df run gives no
 * table. Seeded from the last check saved before the app quit, so a
 * mount that is already hung at launch does not empty the list.
 */
let lastDfDrives: DiskSpaceInfo[] = [];
/**
 * A check moved the baseline in memory but did not write it. Every
 * check changes lastCheckedAt and the free-space readings, yet only a
 * delta past the noise floor or a drive coming or going is worth
 * rewriting the file, with its 500-entry history, right away. The
 * rest waits for flushDiskMonitor() at quit, so an idle machine does
 * not rewrite it on every check.
 */
let baselineDirty = false;

// ── Initialization (call once at startup) ───────────────────

export async function initDiskMonitor(dataDir: string): Promise<void> {
  persistDir = dataDir;
  try {
    const raw = await FS.readFile(Path.join(dataDir, BASELINE_FILE), "utf8");
    const state = JSON.parse(raw) as PersistedState;
    previousDriveMap = new Map(Object.entries(state.previousDrives ?? {}));
    lastFullScanAt = state.lastFullScanAt ?? null;
    lastDrives = Array.isArray(state.lastDrives) ? state.lastDrives : [];
    lastDfDrives = lastDrives;
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
  baselineDirty = false;
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
  const drives = process.platform === "darwin"
    ? await getMacDiskSpace()
    : await getLinuxDiskSpace();
  // df hung on a mount, was killed, or could not start. Until it
  // recovers, show the drives it last reported instead of none.
  if (drives === null) return lastDfDrives;
  lastDfDrives = drives;
  return drives;
}

/** `readDrives` is for tests. */
export async function checkDiskDeltas(
  readDrives: () => Promise<DiskSpaceInfo[]> = getDiskSpace,
): Promise<MonitoringSnapshot> {
  const drives = await readDrives();
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

  const drivesChanged =
    drives.length !== previousDriveMap.size
    || drives.some((d) => !previousDriveMap.has(d.drive));
  previousDriveMap = new Map(drives.map((d) => [d.drive, d]));
  lastDrives = drives;
  lastDeltas = deltas;
  lastCheckedAt = now;

  // Append any meaningful deltas from this check to the rolling timeline so
  // the UI can render drive-level events between full scans.
  if (deltas.length > 0) {
    deltaHistory = [...deltas, ...deltaHistory].slice(0, DELTA_HISTORY_CAP);
  }

  if (deltas.length > 0 || drivesChanged) {
    void persistState();
  } else {
    baselineDirty = true;
  }

  return {
    drives: lastDrives,
    deltas: lastDeltas,
    lastFullScanAt,
    lastCheckedAt,
  };
}

/**
 * Runs `check` (checkDiskDeltas by default) every
 * `checkIntervalMinutes` and hands each result to `onChecked`. With
 * `requireIdle`, a tick is skipped until the system has been idle for
 * `idleMinutes`. Returns null when monitoring is off.
 */
export function startDiskMonitoring(
  monitoring: Pick<MonitoringSettings, "enabled" | "checkIntervalMinutes" | "requireIdle" | "idleMinutes">,
  deps: {
    systemIdleSeconds: () => number;
    onChecked: (snapshot: MonitoringSnapshot) => void | Promise<void>;
    check?: () => Promise<MonitoringSnapshot>;
  },
): ReturnType<typeof setInterval> | null {
  if (!monitoring.enabled) return null;
  const check = deps.check ?? (() => checkDiskDeltas());
  return setInterval(async () => {
    if (monitoring.requireIdle && deps.systemIdleSeconds() < monitoring.idleMinutes * 60) {
      return; // System not idle long enough, skip this check
    }
    await deps.onChecked(await check());
  }, monitoring.checkIntervalMinutes * 60 * 1000);
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

/**
 * Writes the baseline if a check moved it since the last write. Call
 * at quit, so the next launch measures its first delta from the last
 * check rather than from the last change.
 */
export async function flushDiskMonitor(): Promise<void> {
  if (baselineDirty) await persistState();
}

export function getLastFullScanAt(): number | null {
  return lastFullScanAt;
}

/** Return the rolling drive-level delta timeline, newest first. */
export function getDiskDeltaHistory(): DiskDelta[] {
  return deltaHistory.slice();
}

/** Exported for tests — only use from test code. */
export function __resetDiskMonitorForTests(): void {
  previousDriveMap = new Map();
  lastFullScanAt = null;
  persistDir = null;
  lastDrives = [];
  lastDeltas = [];
  lastCheckedAt = 0;
  deltaHistory = [];
  lastDfDrives = [];
  baselineDirty = false;
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

async function getLinuxDiskSpace(): Promise<DiskSpaceInfo[] | null> {
  // GNU `df -P -k -T` includes the filesystem type
  // as an extra column. Adding -T upfront means we never need to
  // cross-reference /proc/mounts — one subprocess, one parse pass.
  // Column layout with -T:
  //   Filesystem  Type  1024-blocks  Used  Available  Capacity  Mounted on
  const stdout = await runDf(["-P", "-k", "-T"]);
  return stdout === null ? null : parseLinuxDfOutput(stdout, Date.now());
}

export function parseLinuxDfOutput(stdout: string, timestamp = Date.now()): DiskSpaceInfo[] {
  const drives: DiskSpaceInfo[] = [];

  for (const row of parseDfRows(stdout, DF_ROW_WITH_TYPE)) {
    const { fsType, totalKb, usedKb, freeKb, mount } = row;
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
    if (!REAL_FILESYSTEM_TYPES.has(fsType.toLowerCase())) continue;

    // Returns null for zero-sized rows (empty tmpfs instances, broken
    // mounts).
    const disk = diskSpaceFromKb(mount, totalKb, usedKb, freeKb, timestamp);
    if (disk) drives.push(disk);
  }

  return drives;
}

async function getMacDiskSpace(): Promise<DiskSpaceInfo[] | null> {
  // macOS/BSD `df` does not support GNU `-T`, so keep this path
  // separate from Linux. `-P -k` gives stable POSIX columns:
  //   Filesystem  1024-blocks  Used  Available  Capacity  Mounted on
  const stdout = await runDf(["-P", "-k"]);
  return stdout === null ? null : parseMacDfOutput(stdout, Date.now());
}

const DF_TIMEOUT_MS = 10_000;

/**
 * The df run in progress, shared by every caller until its process
 * exits. The renderer asks for drives every 10 s from several places,
 * and a df blocked on a hung mount can outlive the timeout's SIGTERM
 * (FUSE waits out a request its daemon has already read, even after
 * a fatal signal), so a new df per call would pile them up.
 */
let dfRun: Promise<string | null> | null = null;

/**
 * Runs `df` and returns its stdout, or null if it printed no table
 * to trust. Resolves within `timeoutMs` even if df never exits.
 *
 * GNU df exits 1 when statfs fails on any one mount for a reason
 * other than EACCES or ENOENT, such as an sshfs mount whose
 * connection dropped (ENOTCONN) or a stale NFS handle (ESTALE). It
 * still prints a row for every other mount, but execFile rejects on
 * the exit status, so those rows are read back from the error.
 *
 * `command` and `timeoutMs` are for tests.
 */
export function runDf(
  args: string[],
  command = "df",
  timeoutMs = DF_TIMEOUT_MS,
): Promise<string | null> {
  if (dfRun) return dfRun;
  const exited = execFileAsync(command, args, { timeout: timeoutMs }).then(
    ({ stdout }) => stdout,
    stdoutOfFailedDf,
  );
  const run = settleBy(exited, timeoutMs, null);
  dfRun = run;
  void exited.then(() => {
    dfRun = null;
  });
  return run;
}

/** Resolves with what `promise` resolves to, or with `fallback` after `ms`. */
function settleBy<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/**
 * Returns the table in an execFile error's stdout when df ran to
 * completion and exited non-zero, and null otherwise. The code is
 * the exit status only when it is a number. A df that the timeout
 * killed has a null code: GNU df prints its table only after it has
 * visited every mount, and anything BSD df wrote before a signal
 * could end partway through a row. A df that could not be started
 * (ENOENT) or overflowed maxBuffer has a string code.
 */
export function stdoutOfFailedDf(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const { code, killed, stdout } = error as {
    code?: unknown;
    killed?: unknown;
    stdout?: unknown;
  };
  if (typeof code !== "number" || killed === true) return null;
  return typeof stdout === "string" && stdout.trim() !== "" ? stdout : null;
}

function diskSpaceFromKb(
  drive: string,
  totalKb: number,
  usedKb: number,
  freeKb: number,
  timestamp: number,
): DiskSpaceInfo | null {
  if (!drive || totalKb <= 0) return null;
  // NaN slips past `<= 0`, and a NaN or Infinity byte count breaks
  // every bar, percentage, and delta computed from it.
  if (![totalKb, usedKb, freeKb].every(Number.isFinite)) return null;
  return {
    drive,
    totalBytes: totalKb * 1024,
    freeBytes: freeKb * 1024,
    usedBytes: usedKb * 1024,
    usedPercent: (usedKb / totalKb) * 100,
    timestamp,
  };
}

interface DfRow {
  filesystem: string;
  /** Empty unless the row came from GNU `df -T`. */
  fsType: string;
  totalKb: number;
  usedKb: number;
  freeKb: number;
  mount: string;
}

/**
 * `df -P` pads its columns with spaces but does not quote or escape
 * the Filesystem or Mounted on text. Linux CIFS shares
 * ("//nas/My Share"), NFS exports on either platform
 * ("nas:/export/Family Photos"), FUSE mounts, and the "map auto_home"
 * autofs row every Mac has all print their spaces as-is. (macOS
 * percent-encodes SMB and WebDAV sources, so those have none.)
 * Splitting on whitespace shifts every later column, so these
 * patterns anchor on the numeric columns instead: the filesystem is
 * the shortest prefix followed by (the type and) three block counts
 * and a capacity, and the mount point is everything after the
 * capacity, spaces included. GNU df prints Used or Available with a
 * minus sign when a filesystem has run into its root reserve, and
 * "-" as the capacity of a zero-sized one.
 */
const DF_ROW =
  /^(?<filesystem>.+?)\s+(?<total>\d+)\s+(?<used>-?\d+)\s+(?<available>-?\d+)\s+(?:\d+%|-)\s+(?<mount>\/.*)$/;
const DF_ROW_WITH_TYPE =
  /^(?<filesystem>.+?)\s+(?<type>\S+)\s+(?<total>\d+)\s+(?<used>-?\d+)\s+(?<available>-?\d+)\s+(?:\d+%|-)\s+(?<mount>\/.*)$/;

/** Parses the data rows of `df -P` output, skipping any that don't fit. */
function parseDfRows(stdout: string, pattern: RegExp): DfRow[] {
  const rows: DfRow[] = [];
  for (const line of stdout.trim().split(/\r?\n/).slice(1)) {
    const groups = pattern.exec(line.trim())?.groups;
    if (!groups) continue;
    rows.push({
      filesystem: groups.filesystem ?? "",
      fsType: groups.type ?? "",
      totalKb: Number(groups.total),
      usedKb: Number(groups.used),
      freeKb: Number(groups.available),
      mount: groups.mount ?? "",
    });
  }
  return rows;
}

export function parseMacDfOutput(stdout: string, timestamp = Date.now()): DiskSpaceInfo[] {
  const drives: DiskSpaceInfo[] = [];

  for (const row of parseDfRows(stdout, DF_ROW)) {
    const { filesystem, totalKb, freeKb, mount } = row;
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
      : row.usedKb;

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
