import type { DuplicateFileEntry, DuplicateGroup, DuplicateSharing } from "./contracts";

/**
 * "How much would deleting these duplicates free?" once storage can be
 * shared. Renderer-safe (no Node imports): the Duplicates scan computes
 * group totals with it, and the view uses it for results from older
 * builds that predate `reclaimableBytes`.
 *
 * Two kinds of copy free less than their size:
 *
 *   hardlink  one file with several names. Deleting a name frees nothing
 *             while any other name remains, inside the folder or not.
 *             The scan index gives every name the same `i` (dev:ino);
 *             Duplicates lists only the first name per id.
 *   clone     an APFS clone (`k`) shares blocks with another file.
 *             Deleting it frees only its private bytes (`v`), the blocks
 *             it no longer shares.
 *
 * Both are read from the index the scan wrote, never re-checked per run:
 * they are true as of that scan, like every other number in the index.
 */

/** Per-file facts the index knows. */
export interface ReclaimFacts {
  size: number;
  /** `dev:ino` when the file has more than one name. */
  linkId?: string;
  /** APFS private bytes (`v`); only set for clones sharing blocks. */
  privateBytes?: number;
}

/** What deleting just this file frees, and why it's below its size. */
export function fileReclaim(facts: ReclaimFacts): { bytes: number; sharing?: DuplicateSharing } {
  const size = Math.max(0, facts.size);
  if (facts.linkId) return { bytes: 0, sharing: "hardlink" };
  if (typeof facts.privateBytes === "number" && facts.privateBytes < size) {
    return { bytes: Math.max(0, facts.privateBytes), sharing: "clone" };
  }
  return { bytes: size };
}

/**
 * Bytes freed by keeping one copy and deleting the rest, keeping the copy
 * whose deletion would free least. Deleting two clones of each other can
 * free more than their private bytes (their shared blocks go too), so
 * this is a floor for groups made only of clones.
 */
export function groupReclaim(files: ReadonlyArray<{ reclaimableBytes?: number }>, size: number): number {
  if (files.length < 2) return 0;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  for (const file of files) {
    const bytes = entryReclaimable(file, size);
    sum += bytes;
    if (bytes < min) min = bytes;
  }
  return sum - min;
}

/** `reclaimableBytes` of a listed file, defaulting to its full size. */
export function entryReclaimable(file: Pick<DuplicateFileEntry, "reclaimableBytes">, size: number): number {
  return typeof file.reclaimableBytes === "number" ? Math.min(size, Math.max(0, file.reclaimableBytes)) : size;
}

/** A group's reclaimable bytes, falling back for pre-sharing results. */
export function duplicateGroupReclaimable(group: DuplicateGroup): number {
  return typeof group.reclaimableBytes === "number"
    ? group.reclaimableBytes
    : Math.max(0, group.files.length - 1) * group.size;
}

/** Group members whose storage is shared, by kind, for labels. */
export function groupSharing(group: DuplicateGroup): { hardlinks: number; clones: number } {
  let hardlinks = 0;
  let clones = 0;
  for (const file of group.files) {
    if (file.sharing === "hardlink") hardlinks += 1;
    else if (file.sharing === "clone") clones += 1;
  }
  return { hardlinks, clones };
}
