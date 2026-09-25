import { execFile } from "node:child_process";
import * as FS from "node:fs";

import type {
  ApfsVolumeUsage,
  DiskhoundPlatform,
  LocalSnapshotInfo,
  LocalSnapshotKind,
  StorageAccountingReport,
} from "./contracts";
import {
  parsePlistDict,
  plistArray,
  plistBool,
  plistDicts,
  plistNumber,
  plistString,
  type PlistDict,
} from "./plist";

/**
 * Main-process storage accounting for copy-on-write volumes.
 *
 * The question DiskHound answers everywhere else is "how many blocks do
 * these files reference?". On APFS that stops being "how much space will
 * deleting them free?" for two reasons this module surfaces:
 *
 *   1. Local snapshots (Time Machine's hourly `com.apple.TimeMachine.*`
 *      snapshots, third-party backup tools, OS-update snapshots) keep
 *      every block they reference pinned. Delete 40 GB right after a
 *      snapshot and `df` does not move until the snapshot is thinned —
 *      Time Machine ages them out after ~24 h, or sooner under space
 *      pressure (`tmutil thinlocalsnapshots / <bytes> <urgency>`).
 *   2. Purgeable space: macOS reports those snapshot blocks plus
 *      evictable caches as "available for important usage" (Finder's
 *      "Available") but not as free (statfs / `df`).
 *
 * Clone accounting (pnpm stores cloned into every node_modules, etc.)
 * is per file, so it lives in the native scanner — see
 * `native/diskhound-native-scanner/src/clone_attrs.rs` — and the pure
 * display helpers in `storageSharing.ts`.
 *
 * Everything here shells out to tools that ship with macOS: `tmutil`,
 * `diskutil` and `osascript` (JXA → Foundation's NSURL volume keys;
 * there is no CLI that prints the important-usage capacity). Each call
 * has a short timeout and every parser tolerates missing/garbled output,
 * so a hung `tmutil` degrades the card instead of blocking the app.
 *
 * What no public CLI exposes: how many bytes each snapshot pins. Disk
 * Utility's "Show APFS Snapshots" size column comes from private APFS
 * ioctls. The report therefore lists snapshots with dates and pairs
 * them with the volume-wide purgeable number, and says so in `notes`.
 *
 * Linux (btrfs/ZFS snapshots, reflinks) and Windows (VSS shadow copies,
 * ReFS block clones) are the analogous concepts; they return
 * `supported: false` with a note until someone wires them up.
 */

// ── Parsers (pure; fixture-tested) ──────────────────────────

const TM_SNAPSHOT_RE = /^com\.apple\.TimeMachine\.(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:\.local)?$/;
const SNAPSHOT_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/;

function localDateMs(y: string, mo: string, d: string, h: string, mi: string, s: string): number | null {
  // tmutil prints wall-clock time in the machine's local zone.
  const ms = new Date(
    Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s),
  ).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function snapshotKindForName(name: string): LocalSnapshotKind {
  if (name.startsWith("com.apple.TimeMachine.")) return "time-machine";
  if (name.startsWith("com.apple.os.update-")) return "os-update";
  return "other";
}

/** Epoch ms from `com.apple.TimeMachine.YYYY-MM-DD-HHMMSS.local`, else null. */
export function snapshotCreatedAtFromName(name: string): number | null {
  const m = TM_SNAPSHOT_RE.exec(name.trim());
  return m ? localDateMs(m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, m[6]!) : null;
}

/**
 * `tmutil listlocalsnapshots <mount>`:
 *
 *   Snapshots for disk /:
 *   com.apple.TimeMachine.2026-09-24-003521.local
 *
 * Older releases omit the header. Anything that is not a snapshot name
 * (errors, "No snapshots") is skipped.
 */
export function parseTmutilLocalSnapshots(stdout: string): string[] {
  const names: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.endsWith(":")) continue;
    if (!/^[\w.-]+$/.test(line)) continue;
    names.push(line);
  }
  return names;
}

/** `tmutil listlocalsnapshotdates [<mount>]` → epoch ms per snapshot. */
export function parseTmutilSnapshotDates(stdout: string): number[] {
  const dates: number[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const m = SNAPSHOT_DATE_RE.exec(raw.trim());
    if (!m) continue;
    const ms = localDateMs(m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, m[6]!);
    if (ms !== null) dates.push(ms);
  }
  return dates;
}

/** `diskutil apfs listSnapshots -plist <mount>` → snapshot records. */
export function parseApfsSnapshotsPlist(xml: string): LocalSnapshotInfo[] | null {
  const root = parsePlistDict(xml);
  if (!root) return null;
  const out: LocalSnapshotInfo[] = [];
  for (const snap of plistDicts(root, "Snapshots")) {
    const name = plistString(snap, "SnapshotName");
    if (!name) continue;
    out.push({
      name,
      kind: snapshotKindForName(name),
      createdAt: snapshotCreatedAtFromName(name),
      purgeable: plistBool(snap, "Purgeable"),
      limitsContainerShrink: plistBool(snap, "LimitingContainerShrink"),
    });
  }
  return out;
}

export interface DiskutilVolumeInfo {
  device: string | null;
  containerDevice: string | null;
  filesystem: string | null;
  mountPoint: string | null;
  totalBytes: number | null;
  /** APFS reports `FreeSpace: 0` on the Data role; prefer container free. */
  freeBytes: number | null;
  containerTotalBytes: number | null;
  containerFreeBytes: number | null;
}

/** `diskutil info -plist <mount>`. */
export function parseDiskutilInfoPlist(xml: string): DiskutilVolumeInfo | null {
  const root = parsePlistDict(xml);
  if (!root) return null;
  const containerFree = plistNumber(root, "APFSContainerFree");
  const volumeFree = plistNumber(root, "FreeSpace");
  return {
    device: plistString(root, "DeviceIdentifier"),
    containerDevice: plistString(root, "APFSContainerReference"),
    filesystem: plistString(root, "FilesystemType")?.toLowerCase() ?? null,
    mountPoint: plistString(root, "MountPoint"),
    totalBytes: plistNumber(root, "TotalSize") ?? plistNumber(root, "Size"),
    // On APFS every volume in a container shares the container's free
    // pool; `FreeSpace` on macOS 26 reads 0 for the Data volume.
    freeBytes: containerFree ?? (volumeFree && volumeFree > 0 ? volumeFree : null),
    containerTotalBytes: plistNumber(root, "APFSContainerSize"),
    containerFreeBytes: containerFree,
  };
}

export interface ApfsContainerRecord {
  device: string;
  totalBytes: number | null;
  freeBytes: number | null;
  volumes: ApfsVolumeUsage[];
}

/** `diskutil apfs list -plist` → containers with their volumes. */
export function parseApfsListPlist(xml: string): ApfsContainerRecord[] | null {
  const root = parsePlistDict(xml);
  if (!root) return null;
  return plistDicts(root, "Containers").map((container: PlistDict) => ({
    device: plistString(container, "ContainerReference") ?? "",
    totalBytes: plistNumber(container, "CapacityCeiling"),
    freeBytes: plistNumber(container, "CapacityFree"),
    volumes: plistDicts(container, "Volumes").map((volume) => ({
      name: plistString(volume, "Name") ?? "",
      device: plistString(volume, "DeviceIdentifier") ?? "",
      roles: plistArray(volume, "Roles").filter((r): r is string => typeof r === "string"),
      usedBytes: plistNumber(volume, "CapacityInUse") ?? 0,
    })),
  })).filter((c) => c.device !== "");
}

export interface VolumeCapacity {
  totalBytes: number | null;
  availableBytes: number | null;
  importantUsageBytes: number | null;
  opportunisticUsageBytes: number | null;
}

/** JSON printed by `VOLUME_CAPACITY_JXA` below. */
export function parseVolumeCapacityJson(stdout: string): VolumeCapacity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as Record<string, unknown>;
  const num = (key: string): number | null => {
    const value = row[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  };
  return {
    totalBytes: num("NSURLVolumeTotalCapacityKey"),
    availableBytes: num("NSURLVolumeAvailableCapacityKey"),
    importantUsageBytes: num("NSURLVolumeAvailableCapacityForImportantUsageKey"),
    opportunisticUsageBytes: num("NSURLVolumeAvailableCapacityForOpportunisticUsageKey"),
  };
}

// ── Report assembly (pure) ──────────────────────────────────

export interface StorageAccountingInputs {
  platform: DiskhoundPlatform;
  volumePath: string;
  checkedAt: number;
  /** From `diskutil apfs listSnapshots -plist`; null if the call failed. */
  apfsSnapshots: LocalSnapshotInfo[] | null;
  /** From `tmutil listlocalsnapshots`; used when diskutil gave nothing. */
  tmutilSnapshotNames: string[] | null;
  info: DiskutilVolumeInfo | null;
  containers: ApfsContainerRecord[] | null;
  capacity: VolumeCapacity | null;
}

export const SNAPSHOT_SIZE_NOTE =
  "macOS does not expose how much each snapshot holds; purgeable space covers snapshots plus caches macOS can clear.";

export function buildStorageAccountingReport(input: StorageAccountingInputs): StorageAccountingReport {
  const notes: string[] = [];

  // diskutil knows every snapshot (Time Machine, backup tools, OS
  // update) plus the purgeable flag; tmutil only knows Time Machine's.
  let snapshots: LocalSnapshotInfo[] = input.apfsSnapshots ?? [];
  if (snapshots.length === 0 && input.tmutilSnapshotNames?.length) {
    snapshots = input.tmutilSnapshotNames.map((name) => ({
      name,
      kind: snapshotKindForName(name),
      createdAt: snapshotCreatedAtFromName(name),
      purgeable: null,
      limitsContainerShrink: null,
    }));
  } else if (input.tmutilSnapshotNames?.length) {
    const known = new Set(snapshots.map((s) => s.name));
    for (const name of input.tmutilSnapshotNames) {
      if (known.has(name)) continue;
      snapshots.push({
        name,
        kind: snapshotKindForName(name),
        createdAt: snapshotCreatedAtFromName(name),
        purgeable: null,
        limitsContainerShrink: null,
      });
    }
  }
  snapshots = [...snapshots].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  const container = input.info?.containerDevice
    ? input.containers?.find((c) => c.device === input.info!.containerDevice) ?? null
    : null;

  const free = input.capacity?.availableBytes ?? input.info?.freeBytes ?? null;
  const important = input.capacity?.importantUsageBytes ?? null;
  const purgeable = free !== null && important !== null ? Math.max(0, important - free) : null;

  const filesystem = input.info?.filesystem ?? null;
  const supported = filesystem === "apfs";
  if (!supported && filesystem) {
    notes.push(`${filesystem.toUpperCase()} volumes have no APFS snapshots or clones to account for.`);
  }
  if (supported && snapshots.length > 0) notes.push(SNAPSHOT_SIZE_NOTE);
  if (input.apfsSnapshots === null && input.tmutilSnapshotNames === null) {
    notes.push("Could not list local snapshots (tmutil and diskutil both failed).");
  }

  return {
    platform: input.platform,
    volumePath: input.volumePath,
    supported,
    filesystem,
    checkedAt: input.checkedAt,
    totalBytes: input.capacity?.totalBytes ?? input.info?.containerTotalBytes ?? input.info?.totalBytes ?? null,
    freeBytes: free,
    availableForImportantUsageBytes: important,
    purgeableBytes: purgeable,
    container: container
      ? {
        device: container.device,
        totalBytes: container.totalBytes ?? input.info?.containerTotalBytes ?? null,
        freeBytes: container.freeBytes ?? input.info?.containerFreeBytes ?? null,
        volumes: [...container.volumes].sort((a, b) => b.usedBytes - a.usedBytes),
      }
      : null,
    snapshots,
    notes,
  };
}

export function unsupportedStorageAccountingReport(
  platform: DiskhoundPlatform,
  volumePath: string,
  checkedAt = Date.now(),
): StorageAccountingReport {
  const note = platform === "linux"
    ? "btrfs / ZFS snapshots and reflinked (cloned) files are not detected yet."
    : platform === "win32"
      ? "Volume Shadow Copies and ReFS block clones are not measured yet."
      : "Storage accounting is not available for this volume.";
  return {
    platform,
    volumePath,
    supported: false,
    filesystem: null,
    checkedAt,
    totalBytes: null,
    freeBytes: null,
    availableForImportantUsageBytes: null,
    purgeableBytes: null,
    container: null,
    snapshots: [],
    notes: [note],
  };
}

/**
 * The mount to ask about for a path on macOS. External disks live under
 * `/Volumes/<name>`; everything else (including firmlinked `/Users`) is
 * the startup disk, which Time Machine and diskutil address as `/`.
 */
export function macVolumeForPath(targetPath: string): string {
  const m = /^\/Volumes\/([^/]+)/.exec(targetPath);
  return m ? `/Volumes/${m[1]}` : "/";
}

/**
 * On the startup disk, user data and its snapshots live on the Data
 * role volume; `/` itself is the sealed system snapshot.
 */
export function macDataVolumeFor(volumePath: string, exists: (p: string) => boolean): string {
  if (volumePath === "/" && exists("/System/Volumes/Data")) return "/System/Volumes/Data";
  return volumePath;
}

// ── Runner ──────────────────────────────────────────────────

/**
 * JXA: read Foundation's volume capacity keys and print them as JSON.
 * `osascript -l JavaScript` ships with every macOS; the ObjC bridge
 * calls NSURL directly, so no Apple Events / automation prompt fires.
 * ~80 ms per call on an M-series Mac.
 */
export const VOLUME_CAPACITY_JXA = [
  "ObjC.import('Foundation');",
  "function run(argv) {",
  "  var url = $.NSURL.fileURLWithPath(argv[0]);",
  "  var keys = ['NSURLVolumeTotalCapacityKey', 'NSURLVolumeAvailableCapacityKey',",
  "    'NSURLVolumeAvailableCapacityForImportantUsageKey', 'NSURLVolumeAvailableCapacityForOpportunisticUsageKey'];",
  "  var values = url.resourceValuesForKeysError($(keys), null);",
  "  var out = {};",
  "  keys.forEach(function (k) { var v = values ? values.objectForKey(k) : null; out[k] = v ? v.js : null; });",
  "  return JSON.stringify(out);",
  "}",
].join("\n");

export type CommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<string | null>;

const defaultRunner: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        // tmutil exits non-zero when Time Machine was never configured;
        // treat any failure as "no data" rather than an exception.
        resolve(error ? null : String(stdout));
      },
    );
  });

export interface StorageAccountingDeps {
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  now?: () => number;
  exists?: (p: string) => boolean;
}

const COMMAND_TIMEOUT_MS = 8_000;

function normalizePlatform(platform: NodeJS.Platform): DiskhoundPlatform {
  return platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux";
}

export async function collectStorageAccounting(
  targetPath: string,
  deps: StorageAccountingDeps = {},
): Promise<StorageAccountingReport> {
  const platform = normalizePlatform(deps.platform ?? process.platform);
  const now = deps.now ?? Date.now;
  if (platform !== "darwin") {
    return unsupportedStorageAccountingReport(platform, targetPath, now());
  }
  const run = deps.run ?? defaultRunner;
  const exists = deps.exists ?? FS.existsSync;
  const volumePath = macVolumeForPath(targetPath);
  const dataPath = macDataVolumeFor(volumePath, exists);

  const [tmutil, apfsSnaps, info, apfsList, capacity] = await Promise.all([
    run("/usr/bin/tmutil", ["listlocalsnapshots", volumePath], COMMAND_TIMEOUT_MS),
    run("/usr/sbin/diskutil", ["apfs", "listSnapshots", "-plist", dataPath], COMMAND_TIMEOUT_MS),
    run("/usr/sbin/diskutil", ["info", "-plist", dataPath], COMMAND_TIMEOUT_MS),
    run("/usr/sbin/diskutil", ["apfs", "list", "-plist"], COMMAND_TIMEOUT_MS),
    run("/usr/bin/osascript", ["-l", "JavaScript", "-e", VOLUME_CAPACITY_JXA, volumePath], COMMAND_TIMEOUT_MS),
  ]);

  return buildStorageAccountingReport({
    platform,
    volumePath,
    checkedAt: now(),
    apfsSnapshots: apfsSnaps !== null ? parseApfsSnapshotsPlist(apfsSnaps) : null,
    tmutilSnapshotNames: tmutil !== null ? parseTmutilLocalSnapshots(tmutil) : null,
    info: info !== null ? parseDiskutilInfoPlist(info) : null,
    containers: apfsList !== null ? parseApfsListPlist(apfsList) : null,
    capacity: capacity !== null ? parseVolumeCapacityJson(capacity) : null,
  });
}

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { at: number; report: Promise<StorageAccountingReport> }>();

/**
 * Cached entry point for IPC. Concurrent callers for the same volume
 * share one in-flight collection; `fresh` bypasses the cache (used right
 * after a delete, when the snapshot list and free space just changed).
 */
export function getStorageAccounting(
  targetPath: string,
  opts: { fresh?: boolean } = {},
): Promise<StorageAccountingReport> {
  const key = process.platform === "darwin" ? macVolumeForPath(targetPath) : targetPath;
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.report;
  const report = collectStorageAccounting(targetPath).catch(() =>
    unsupportedStorageAccountingReport(normalizePlatform(process.platform), key),
  );
  cache.set(key, { at: Date.now(), report });
  return report;
}

// TODO(mcp): the MCP server + agent skills on
// codex/diskhound-mcp-patterns-* document these caveats in their
// "free up space" skill. Once that branch lands, expose this report
// (plus ScanSnapshot.storageAccounting and DevArtifact.clone) as a
// `diskhound_storage_accounting` tool so agents can say "this frees
// ≈X now, Y once snapshots expire" instead of quoting allocated size.
