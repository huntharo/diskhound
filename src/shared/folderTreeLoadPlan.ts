/**
 * Decide how the Folders tab may load a scan's folder tree without
 * running the Electron main process out of V8 heap.
 *
 * Electron builds V8 with pointer compression, and the main isolate and
 * every worker_thread share one 4 GB heap cage. `heap_size_limit` reads
 * 4096 MB, a worker's `resourceLimits` can't raise it, and a worker that
 * fills the cage aborts the whole process, not just itself. So moving a
 * big tree into a worker doesn't make it safe.
 *
 * A 42M-file `/` scan wrote a 995 MB sidecar with 8.7M parent entries.
 * As a Map<string, FolderNode> that needs about 8.9 GB. The boot
 * pre-warm tried to load it and the app died ~20 s after every launch.
 *
 * Measured on that sidecar (Electron 40, macOS): ~8.9 heap bytes per
 * gzipped sidecar byte, ~2.4 per uncompressed byte, ~1 KB per parent
 * entry. The constants below round those up.
 */

/** Heap for the in-memory tree per byte of gzipped sidecar. */
export const HEAP_BYTES_PER_SIDECAR_BYTE = 10;
/** Heap per uncompressed sidecar line byte once parsed into nodes. */
export const HEAP_BYTES_PER_SIDECAR_LINE_BYTE = 2.5;
/** Heap per file record when the tree is rebuilt from the scan index. */
export const HEAP_BYTES_PER_FILE = 130;
/** Heap per directory: its Map key and node plus its row in the parent. */
export const HEAP_BYTES_PER_DIRECTORY = 400;
/**
 * Rebuilding from the index holds the worker's maps and the main
 * process's copy of the tree at the same time, in the same heap cage.
 */
export const INDEX_BUILD_PEAK_MULTIPLIER = 2;
/** Most heap one in-memory tree may take. */
export const MAX_TREE_HEAP_BYTES = 1024 * 1024 * 1024;
/** One in-memory tree may also take at most this share of the heap limit. */
export const MAX_TREE_HEAP_FRACTION = 0.25;
/** Heap in use plus the new tree must stay under this share of the limit. */
export const MAX_HEAP_FRACTION_AFTER_LOAD = 0.6;
/**
 * Backstop while a sidecar streams into memory: stop if the heap passes
 * this share of the limit, whatever the estimate said.
 */
export const MAX_HEAP_FRACTION_DURING_LOAD = 0.7;

export type FolderTreeLoadMode = "memory" | "paged" | "unavailable";

export interface FolderTreeLoadInputs {
  /** Size of `<id>.folder-tree.ndjson.gz`, or null when it's missing. */
  sidecarBytes: number | null;
  /** Whether `<id>.ndjson.gz` exists to rebuild the tree from. */
  hasIndex: boolean;
  /** From the scan's history entry. */
  filesVisited?: number;
  directoriesVisited?: number;
  /** `v8.getHeapStatistics().heap_size_limit` */
  heapLimitBytes: number;
  /** `v8.getHeapStatistics().used_heap_size` */
  heapUsedBytes: number;
  /** Replaces MAX_TREE_HEAP_BYTES (env override and tests). */
  maxTreeHeapBytes?: number;
}

export interface FolderTreeLoadPlan {
  mode: FolderTreeLoadMode;
  /** Estimated heap for the whole tree in memory. */
  estimatedHeapBytes: number;
  /** Heap this load may take right now. */
  allowedHeapBytes: number;
  /** One line for crash.log. */
  reason: string;
}

const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024)).toLocaleString("en-US")} MB`;

/**
 * - "memory": load the whole tree into the main-process cache (the
 *   original fast path).
 * - "paged": too big to hold, but a sidecar exists, so read one folder
 *   at a time from it.
 * - "unavailable": too big to hold and there's no sidecar to page from,
 *   or there's nothing on disk at all.
 */
export function planFolderTreeLoad(inputs: FolderTreeLoadInputs): FolderTreeLoadPlan {
  const budget = Math.min(
    inputs.maxTreeHeapBytes ?? MAX_TREE_HEAP_BYTES,
    inputs.heapLimitBytes * MAX_TREE_HEAP_FRACTION,
  );
  const headroom = inputs.heapLimitBytes * MAX_HEAP_FRACTION_AFTER_LOAD - inputs.heapUsedBytes;
  const allowed = Math.max(0, Math.min(budget, headroom));
  const limitedBy = headroom < budget
    ? `${mb(inputs.heapUsedBytes)} of ${mb(inputs.heapLimitBytes)} heap already in use`
    : `tree budget ${mb(budget)}`;

  if (inputs.sidecarBytes !== null) {
    const estimate = inputs.sidecarBytes * HEAP_BYTES_PER_SIDECAR_BYTE;
    if (estimate <= allowed) {
      return {
        mode: "memory",
        estimatedHeapBytes: estimate,
        allowedHeapBytes: allowed,
        reason: `sidecar ${mb(inputs.sidecarBytes)} needs ~${mb(estimate)} heap; ${mb(allowed)} allowed`,
      };
    }
    return {
      mode: "paged",
      estimatedHeapBytes: estimate,
      allowedHeapBytes: allowed,
      reason: `sidecar ${mb(inputs.sidecarBytes)} needs ~${mb(estimate)} heap; ${limitedBy} allows ${mb(allowed)}`,
    };
  }

  if (!inputs.hasIndex) {
    return {
      mode: "unavailable",
      estimatedHeapBytes: 0,
      allowedHeapBytes: allowed,
      reason: "no folder-tree sidecar and no scan index on disk",
    };
  }

  const estimate =
    (inputs.filesVisited ?? 0) * HEAP_BYTES_PER_FILE +
    (inputs.directoriesVisited ?? 0) * HEAP_BYTES_PER_DIRECTORY;
  const peak = estimate * INDEX_BUILD_PEAK_MULTIPLIER;
  if (peak <= allowed) {
    return {
      mode: "memory",
      estimatedHeapBytes: estimate,
      allowedHeapBytes: allowed,
      reason: `no sidecar; index rebuild peaks at ~${mb(peak)} heap; ${mb(allowed)} allowed`,
    };
  }
  return {
    mode: "unavailable",
    estimatedHeapBytes: estimate,
    allowedHeapBytes: allowed,
    reason: `no sidecar; index rebuild peaks at ~${mb(peak)} heap; ${limitedBy} allows ${mb(allowed)}`,
  };
}
