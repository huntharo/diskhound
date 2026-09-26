import * as FS from "node:fs/promises";

import type { FullDiffResult, ScanSnapshot } from "./contracts";
import { hasFullDiffCache, readFullDiffCache, writeFullDiffCache } from "./fullDiffCacheStore";
import type { FullDiffWorkerInput } from "./fullDiffWorkerProtocol";
import { getLatestPair } from "./scanHistory";
import { indexFilePath } from "./scanIndex";

/**
 * Loads or computes the per-file diff between two scans: the memory
 * cache, then full-diff-cache/ on disk, then the worker's external sort
 * over both indexes, which spills every record to OS.tmpdir(). main.ts
 * owns the IPC handlers; this module owns the disk work, so the I/O
 * budget tests measure the same code the app runs.
 */

export interface FullDiffLoaderDeps {
  loadSnapshot: (id: string) => Promise<ScanSnapshot | null>;
  runWorker: (input: FullDiffWorkerInput) => Promise<FullDiffResult | null>;
  /** Main-thread fallback when the worker fails. */
  computeInline: (input: FullDiffWorkerInput) => Promise<FullDiffResult | null>;
  log: (tag: string, message: string) => void;
}

export interface FullDiffLoadOptions {
  /** Compute a pair that failed before, although its indexes did not change. */
  retryFailed?: boolean;
}

export interface FullDiffLoader {
  load: (
    baselineId: string,
    currentId: string,
    limit?: number,
    options?: FullDiffLoadOptions,
  ) => Promise<FullDiffResult | null>;
  /** Whether a full diff for this pair is on disk; asks the disk once per pair. */
  hasOnDisk: (baselineId: string, currentId: string, limit: number) => Promise<boolean>;
  /** Computes the latest pair's diff in the background, after a scan. */
  warmLatest: (rootPath: string) => Promise<FullDiffResult | null> | null;
  /** Drops what the loader holds for a scan that is pruned or cleared. */
  forgetScan: (id: string) => void;
  /** Memory-cache entries, for the memory diagnostics line. */
  memoryEntries: () => number;
}

// Full diffs are capped at the requested limit (1,000 changes from
// Changes, ~200 KB), so 32 of them hold a drive's whole 30-scan
// history at ~6 MB.
const FULL_DIFF_CACHE_LIMIT = 32;

/** Size and mtime of a scan's index, or "missing". */
async function indexSignature(id: string): Promise<string> {
  try {
    const stat = await FS.stat(indexFilePath(id));
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

export function normalizeDiffLimit(limit?: number): number {
  return typeof limit === "number" && Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : 500;
}

export function createFullDiffLoader(deps: FullDiffLoaderDeps): FullDiffLoader {
  const fullDiffCache = new Map<string, FullDiffResult | null>();
  const fullDiffInflight = new Map<string, Promise<FullDiffResult | null>>();
  /**
   * Pairs whose diff came back null, with both indexes' signatures at
   * the time. An automatic retry of the same files (a warm, the Changes
   * tab's auto-load) would write both indexes to the temp dir again
   * (~3.7 GB at 7M files) only to fail the same way, so it waits until
   * an index changes (still being written, or rewritten), the app
   * restarts, or the user asks again (`retryFailed`).
   */
  const failedDiffs = new Map<string, string>();
  /**
   * get-full-diff-status answers: which pairs have a full diff in
   * full-diff-cache/. Only this loader writes there, and main calls
   * forgetScan when it deletes a scan's diffs, so an answer holds until
   * the loader writes that pair.
   */
  const fullDiffOnDisk = new Map<string, boolean>();
  const cacheKeyFor = (baselineId: string, currentId: string, limit: number) =>
    `${baselineId}::${currentId}::${limit}`;

  const readFullDiffMemoryCache = (key: string) => {
    const cached = fullDiffCache.get(key);
    if (cached !== undefined) {
      fullDiffCache.delete(key);
      fullDiffCache.set(key, cached);
      return cached;
    }
    return undefined;
  };
  const writeFullDiffMemoryCache = (key: string, value: FullDiffResult | null) => {
    fullDiffCache.delete(key);
    fullDiffCache.set(key, value);
    while (fullDiffCache.size > FULL_DIFF_CACHE_LIMIT) {
      const oldest = fullDiffCache.keys().next().value;
      if (oldest) fullDiffCache.delete(oldest);
      else break;
    }
  };

  const load = async (
    baselineId: string,
    currentId: string,
    limit?: number,
    options?: FullDiffLoadOptions,
  ): Promise<FullDiffResult | null> => {
    const normalizedLimit = normalizeDiffLimit(limit);
    const cacheKey = cacheKeyFor(baselineId, currentId, normalizedLimit);
    const memoryCached = readFullDiffMemoryCache(cacheKey);
    if (memoryCached !== undefined) {
      return memoryCached;
    }

    const existing = fullDiffInflight.get(cacheKey);
    if (existing) {
      return existing;
    }

    const pending = (async () => {
      const signature = `${await indexSignature(baselineId)}|${await indexSignature(currentId)}`;
      if (!options?.retryFailed && failedDiffs.get(cacheKey) === signature) {
        return null;
      }

      // A miss the status check just saw is still a miss: don't look
      // for the file twice.
      const diskCached = fullDiffOnDisk.get(cacheKey) === false
        ? null
        : await readFullDiffCache(baselineId, currentId, normalizedLimit);
      fullDiffOnDisk.set(cacheKey, diskCached !== null);
      if (diskCached !== null) {
        writeFullDiffMemoryCache(cacheKey, diskCached);
        return diskCached;
      }

      // Fast path: if the snapshot aggregates match exactly (bytes,
      // files, dirs), the per-file diff is guaranteed empty. Short-
      // circuit so we don't spawn the 4 GB worker just to prove that
      // — on a 7.27M-file C:\ scan the worker otherwise OOMs even
      // when nothing changed (building two full path→size maps to
      // compare them is what costs the heap, not emitting deltas).
      const [baseSnap, currSnap] = await Promise.all([
        deps.loadSnapshot(baselineId),
        deps.loadSnapshot(currentId),
      ]);
      if (
        baseSnap && currSnap &&
        baseSnap.bytesSeen === currSnap.bytesSeen &&
        baseSnap.filesVisited === currSnap.filesVisited &&
        baseSnap.directoriesVisited === currSnap.directoriesVisited
      ) {
        const emptyResult: FullDiffResult = {
          baselineId,
          currentId,
          totalChanges: 0,
          totalAdded: 0,
          totalRemoved: 0,
          totalGrew: 0,
          totalShrank: 0,
          totalBytesAdded: 0,
          totalBytesRemoved: 0,
          changes: [],
          truncated: false,
        };
        writeFullDiffMemoryCache(cacheKey, emptyResult);
        await writeFullDiffCache(emptyResult, normalizedLimit);
        fullDiffOnDisk.delete(cacheKey);
        return emptyResult;
      }

      const input: FullDiffWorkerInput = {
        baselineId,
        currentId,
        baselinePath: indexFilePath(baselineId),
        currentPath: indexFilePath(currentId),
        limit: normalizedLimit,
      };

      let result: FullDiffResult | null = null;
      try {
        result = await deps.runWorker(input);
      } catch (err) {
        deps.log("full-diff-worker", err instanceof Error ? (err.stack ?? err.message) : String(err));
        // Fallback: run inline on the main thread. Still slow for big
        // indexes but at least produces a result rather than leaving
        // the user stuck on "preparing…" forever.
        try {
          result = await deps.computeInline(input);
        } catch (fallbackErr) {
          deps.log(
            "full-diff-inline",
            fallbackErr instanceof Error ? (fallbackErr.stack ?? fallbackErr.message) : String(fallbackErr),
          );
          result = null;
        }
      }

      // Only persist POSITIVE results. A null result typically means one
      // of the index files is missing or unreadable — caching that on
      // disk would let a transient condition (file still being written,
      // brief permission hiccup) poison the cache and surface as the
      // permanent "Load full file diff" CTA loop the user reported. A
      // null is remembered in memory only, against the indexes' current
      // signatures, so a changed index or a restart retries it.
      if (result) {
        failedDiffs.delete(cacheKey);
        writeFullDiffMemoryCache(cacheKey, result);
        await writeFullDiffCache(result, normalizedLimit);
        fullDiffOnDisk.delete(cacheKey);
      } else {
        failedDiffs.delete(cacheKey);
        failedDiffs.set(cacheKey, signature);
        while (failedDiffs.size > FULL_DIFF_CACHE_LIMIT) {
          const oldest = failedDiffs.keys().next().value;
          if (oldest) failedDiffs.delete(oldest);
          else break;
        }
      }
      return result;
    })().finally(() => {
      fullDiffInflight.delete(cacheKey);
    });

    fullDiffInflight.set(cacheKey, pending);
    return pending;
  };

  const hasOnDisk = async (baselineId: string, currentId: string, limit: number): Promise<boolean> => {
    const key = cacheKeyFor(baselineId, currentId, limit);
    if (fullDiffCache.get(key)) return true;
    const known = fullDiffOnDisk.get(key);
    if (known !== undefined) return known;
    const onDisk = await hasFullDiffCache(baselineId, currentId, limit);
    fullDiffOnDisk.set(key, onDisk);
    return onDisk;
  };

  const forgetScan = (id: string) => {
    for (const key of [...fullDiffCache.keys(), ...fullDiffOnDisk.keys(), ...failedDiffs.keys()]) {
      const [baselineId, currentId] = key.split("::");
      if (baselineId === id || currentId === id) {
        fullDiffCache.delete(key);
        fullDiffOnDisk.delete(key);
        failedDiffs.delete(key);
      }
    }
  };

  const warmLatest = (rootPath: string) => {
    const latestPair = getLatestPair(rootPath);
    if (!latestPair) return null;
    return load(latestPair.baseline.id, latestPair.current.id, 1000).catch(() => {
      // best effort background warmup
      return null;
    });
  };

  return { load, hasOnDisk, warmLatest, forgetScan, memoryEntries: () => fullDiffCache.size };
}
