import type {
  DevArtifact,
  LocalSnapshotInfo,
  ScanStorageAccounting,
  StorageAccountingReport,
} from "./contracts";

/**
 * Renderer-safe math for "how much would deleting this actually free?"
 * on copy-on-write volumes. No Node imports — the Dev and Overview views
 * import this directly. The process-running half lives in
 * `macStorageAccounting.ts`.
 *
 * Vocabulary (all byte counts are allocated sizes):
 *
 *   clone     a file APFS flags EF_MAY_SHARE_BLOCKS — some or all of
 *             its blocks are shared with another file (clonefile(2),
 *             `cp -c`, Finder duplicate, pnpm/bun installs on macOS).
 *   private   APFS's ATTR_CMNEXT_PRIVATESIZE for a clone: blocks it no
 *             longer shares (rewritten after cloning).
 *   internal  a group of full clones whose every member sits inside the
 *             same tree; deleting the whole tree frees the group.
 *   shared    clone bytes whose blocks are also referenced from outside
 *             the tree; deleting the tree alone frees none of it.
 *
 * Snapshots are deliberately *not* folded into per-tree numbers: the
 * scanner skips PRIVATESIZE on non-clone files (it cost 20–25 % scan
 * time), and whether a snapshot pins a tree changes hourly anyway. The
 * estimates below are "what this frees once no snapshot holds it"; the
 * Overview card and post-delete check report snapshots per volume.
 */

// ── Path heuristics (unmeasured trees) ──────────────────────

export type CloneHintKind = "pnpm-store" | "pnpm-virtual-store" | "bun-cache";

export interface CloneHint {
  kind: CloneHintKind;
  /** One line for a tooltip — says "likely" because nothing was measured. */
  detail: string;
}

function splitLower(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean).map((p) => p.toLowerCase());
}

function hasSequence(parts: string[], seq: string[]): boolean {
  outer: for (let i = 0; i + seq.length <= parts.length; i++) {
    for (let j = 0; j < seq.length; j++) {
      if (parts[i + j] !== seq[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Package-manager stores whose files are cloned (APFS) or hard-linked
 * (ext4/NTFS) into project node_modules. Used when a tree has no scanner
 * clone data — older scans, Linux, Windows — so the Dev view can still
 * warn that deleting one side frees little.
 */
export function cloneHintForPath(path: string): CloneHint | null {
  const parts = splitLower(path);
  if (
    parts.includes(".pnpm-store")
    || hasSequence(parts, ["library", "pnpm", "store"])
    || hasSequence(parts, [".local", "share", "pnpm", "store"])
    || hasSequence(parts, ["appdata", "local", "pnpm", "store"])
  ) {
    return {
      kind: "pnpm-store",
      detail: "pnpm store — each project's node_modules/.pnpm is likely a clone or hard link of these files, so deleting only the store (or only a project) frees little.",
    };
  }
  // A bare `node_modules` root can't be told apart from an npm install
  // by path alone; the scanner's clone data answers that case.
  if (hasSequence(parts, ["node_modules", ".pnpm"])) {
    return {
      kind: "pnpm-virtual-store",
      detail: "pnpm install — these files are likely clones or hard links of the shared pnpm store, so deleting this tree alone frees little.",
    };
  }
  if (hasSequence(parts, [".bun", "install", "cache"]) || parts[parts.length - 1] === ".bun") {
    return {
      kind: "bun-cache",
      detail: "bun cache — on macOS bun clones these files into node_modules, so deleting only one side frees little.",
    };
  }
  return null;
}

// ── Per-tree sharing (Dev Artifacts rows) ───────────────────

export interface DevArtifactSharing {
  /** True when the scanner measured clones for this tree. */
  measured: boolean;
  /**
   * Deleting just this tree frees about this much (once no snapshot
   * holds it). Null when unmeasured — assume `size`.
   */
  freesBytes: number | null;
  /** Bytes whose blocks are shared with files outside this tree. */
  sharedBytes: number;
  /** Other Dev trees sharing clone groups with this one. */
  sharedRoots: number;
  sharedWith: string[];
  /** Path heuristic for unmeasured trees. */
  hint: CloneHint | null;
}

const MiB = 1024 * 1024;

export function devArtifactSharing(artifact: Pick<DevArtifact, "path" | "size" | "clone">): DevArtifactSharing {
  const clone = artifact.clone;
  if (!clone) {
    return {
      measured: false,
      freesBytes: null,
      sharedBytes: 0,
      sharedRoots: 0,
      sharedWith: [],
      hint: cloneHintForPath(artifact.path),
    };
  }
  const size = Math.max(0, artifact.size);
  const cloneSize = clamp(clone.cloneSize, 0, size);
  const nonClone = size - cloneSize;
  const clonePrivate = clamp(clone.clonePrivateSize, 0, cloneSize);
  // Ordinary files + the unshared part of clones + clone groups this
  // tree fully owns (counted once). Equivalently: size minus bytes
  // shared outside, minus the extra copies inside owned groups.
  const frees = clamp(nonClone + clonePrivate + Math.max(0, clone.cloneInternalSize), 0, size);
  return {
    measured: true,
    freesBytes: frees,
    sharedBytes: clamp(clone.cloneSharedSize, 0, cloneSize),
    sharedRoots: Math.max(0, clone.sharedRoots),
    sharedWith: clone.sharedWith ?? [],
    hint: null,
  };
}

/** Worth a "Shared" badge: enough bytes that the row's size misleads. */
export function isMeaningfullyShared(sharing: DevArtifactSharing, size: number): boolean {
  if (!sharing.measured) return sharing.hint !== null;
  return sharing.sharedBytes >= Math.max(MiB, size * 0.05);
}

/** Sum what deleting a set of trees would free, for the Dev summary. */
export function summarizeDevSharing(artifacts: ReadonlyArray<Pick<DevArtifact, "path" | "size" | "clone">>): {
  measuredTrees: number;
  totalBytes: number;
  freesBytes: number;
  sharedBytes: number;
} {
  let measuredTrees = 0;
  let totalBytes = 0;
  let freesBytes = 0;
  let sharedBytes = 0;
  for (const artifact of artifacts) {
    totalBytes += artifact.size;
    const sharing = devArtifactSharing(artifact);
    if (!sharing.measured) {
      freesBytes += artifact.size;
      continue;
    }
    measuredTrees += 1;
    freesBytes += sharing.freesBytes ?? artifact.size;
    sharedBytes += sharing.sharedBytes;
  }
  // Two trees that share a clone group each report the other's side as
  // "shared". Deleting both frees the group once; this sum stays a
  // conservative (low) estimate for multi-select deletes.
  return { measuredTrees, totalBytes, freesBytes, sharedBytes };
}

// ── Snapshots ───────────────────────────────────────────────

/**
 * Snapshots that can hold deleted user data. OS-update snapshots sit on
 * the sealed system volume and never pin user files.
 */
export function userDataSnapshots(report: StorageAccountingReport | null | undefined): LocalSnapshotInfo[] {
  return (report?.snapshots ?? []).filter((s) => s.kind !== "os-update");
}

export function ageLabel(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Commands shown (never run) in the Overview card's guidance. */
export const THIN_SNAPSHOTS_COMMAND = "tmutil thinlocalsnapshots / 999999999999 4";
export function deleteSnapshotCommand(snapshot: LocalSnapshotInfo): string | null {
  const m = /^com\.apple\.TimeMachine\.(\d{4}-\d{2}-\d{2}-\d{6})/.exec(snapshot.name);
  return m ? `tmutil deletelocalsnapshots ${m[1]}` : null;
}

// ── Scan totals (Overview card) ─────────────────────────────

export interface ScanSharingSummary {
  /** Allocated bytes the scan measured clone attributes for. */
  measuredBytes: number;
  cloneBytes: number;
  cloneFiles: number;
  /** Blocks clones no longer share (freed with the clone). */
  clonePrivateBytes: number;
  /** bytesSeen over-count from full clones seen more than once. */
  duplicateBytes: number | null;
  /** Clone bytes whose blocks something else still references. */
  sharedBytes: number;
  approximate: boolean;
}

export function summarizeScanSharing(acc: ScanStorageAccounting | null | undefined): ScanSharingSummary | null {
  if (!acc || acc.measuredFiles <= 0) return null;
  const cloneBytes = clamp(acc.cloneBytes, 0, acc.measuredBytes);
  const clonePrivateBytes = clamp(acc.clonePrivateBytes, 0, cloneBytes);
  return {
    measuredBytes: acc.measuredBytes,
    cloneBytes,
    cloneFiles: acc.cloneFiles,
    clonePrivateBytes,
    duplicateBytes: acc.cloneDuplicateBytes === null
      ? null
      : clamp(acc.cloneDuplicateBytes, 0, cloneBytes),
    sharedBytes: cloneBytes - clonePrivateBytes,
    approximate: acc.approximate === true,
  };
}

// ── Post-delete check ───────────────────────────────────────

export interface FreedSpaceCheck {
  /** Allocated bytes the UI believed it was deleting. */
  expectedBytes: number;
  freeBefore: number | null;
  freeAfter: number | null;
  /** Fetched after the delete (fresh). */
  report: StorageAccountingReport | null;
  /**
   * Bytes among the deleted items the scanner measured as not freeing
   * (Dev rows: size minus "frees ≈", i.e. clone blocks shared outside
   * the tree plus extra copies inside it). The check judges only
   * `expectedBytes - sharedBytes`. Undefined = unknown, e.g. a single
   * file delete.
   */
  sharedBytes?: number;
  now?: number;
}

export interface FreedSpaceExplanation {
  freedBytes: number;
  title: string;
  body: string;
}

/** Below this, other apps' writes drown the signal. */
export const FREED_CHECK_MIN_BYTES = 128 * MiB;

/**
 * After a delete: did free space move roughly as much as the rows said?
 * Returns copy for a warning toast when it clearly did not, naming the
 * likely holder (local snapshot, clone sharing) — or null when the
 * delete behaved or the numbers are too small / unknown to judge.
 */
export function explainFreedShortfall(
  check: FreedSpaceCheck,
  fmt: (bytes: number) => string = formatBytesPlain,
): FreedSpaceExplanation | null {
  const { expectedBytes, freeBefore, freeAfter } = check;
  if (freeBefore === null || freeAfter === null) return null;
  if (!Number.isFinite(expectedBytes) || expectedBytes < FREED_CHECK_MIN_BYTES) return null;
  const freed = freeAfter - freeBefore;
  // Clone bytes the caller already measured as not coming back (the Dev
  // confirm said "Frees ≈ X") are not a surprise; judge only the rest.
  const shared = clamp(check.sharedBytes ?? 0, 0, expectedBytes);
  const expectedFree = expectedBytes - shared;
  if (freed >= expectedFree * 0.5) return null;
  if (expectedFree - Math.max(0, freed) < FREED_CHECK_MIN_BYTES) return null;

  const now = check.now ?? Date.now();
  const title = freed <= 0
    ? `Free space didn't go up after deleting ${fmt(expectedBytes)}`
    : `Only ${fmt(freed)} of ${fmt(expectedBytes)} came back as free space`;

  const reasons: string[] = [];
  const snapshots = userDataSnapshots(check.report);
  if (snapshots.length > 0) {
    const newest = snapshots.find((s) => s.createdAt !== null);
    const tm = snapshots.filter((s) => s.kind === "time-machine").length;
    const what = tm === snapshots.length
      ? `${snapshots.length === 1 ? "A local Time Machine snapshot" : `${snapshots.length} local Time Machine snapshots`}`
      : `${snapshots.length} local snapshot${snapshots.length === 1 ? "" : "s"}`;
    const when = newest?.createdAt ? ` (newest ${ageLabel(now - newest.createdAt)})` : "";
    // "may": free space alone can't prove the snapshot is the holder —
    // a clone of old blocks looks the same from here.
    reasons.push(
      `${what}${when} may still reference the deleted files. macOS frees that space when the snapshot expires — Time Machine keeps local snapshots about 24 hours — or sooner if the disk runs low. Overview shows how to thin them now.`,
    );
  }
  if (shared >= FREED_CHECK_MIN_BYTES / 2) {
    reasons.push(
      `${fmt(shared)} of it was APFS clone copies whose blocks other copies still use, so that part was never going to come back.`,
    );
  } else if (check.sharedBytes === undefined && reasons.length > 0) {
    // Nothing measured about clones for these paths — name it as the
    // other common cause instead of pinning everything on the snapshot.
    reasons.push(
      "Or the files were APFS clones (pnpm/bun installs, Finder duplicates) of copies that still exist — that space returns only when every copy is gone.",
    );
  }
  if (reasons.length === 0) {
    reasons.push(
      "Another copy is still holding those blocks — usually an APFS clone of the deleted files, or a snapshot DiskHound can't list. Another app writing at the same time can also mask the change.",
    );
  }
  return { freedBytes: freed, title, body: reasons.join(" ") };
}

// ── Helpers ─────────────────────────────────────────────────

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
}

/** Default byte formatter; the renderer passes its own `formatBytes`. */
export function formatBytesPlain(bytes: number): string {
  const abs = Math.abs(bytes);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = abs;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${bytes < 0 ? "-" : ""}${value.toFixed(digits)} ${units[unit]}`;
}
