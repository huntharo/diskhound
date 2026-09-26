import type { FullDiffResult, ScanSnapshot } from "./contracts";
import { readFullDiffCache, writeFullDiffCache } from "./fullDiffCacheStore";
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

export interface FullDiffLoader {
  load: (baselineId: string, currentId: string, limit?: number) => Promise<FullDiffResult | null>;
  /** Computes the latest pair's diff in the background, after a scan. */
  warmLatest: (rootPath: string) => Promise<FullDiffResult | null> | null;
  /** Memory-cache entries, for the memory diagnostics line. */
  memoryEntries: () => number;
}

const FULL_DIFF_CACHE_LIMIT = 8;

export function normalizeDiffLimit(limit?: number): number {
  return typeof limit === "number" && Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : 500;
}

export function createFullDiffLoader(deps: FullDiffLoaderDeps): FullDiffLoader {
  const fullDiffCache = new Map<string, FullDiffResult | null>();
  const fullDiffInflight = new Map<string, Promise<FullDiffResult | null>>();

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
  ): Promise<FullDiffResult | null> => {
    const normalizedLimit = normalizeDiffLimit(limit);
    const cacheKey = `${baselineId}::${currentId}::${normalizedLimit}`;
    const memoryCached = readFullDiffMemoryCache(cacheKey);
    if (memoryCached !== undefined) {
      return memoryCached;
    }

    const existing = fullDiffInflight.get(cacheKey);
    if (existing) {
      return existing;
    }

    const pending = (async () => {
      const diskCached = await readFullDiffCache(baselineId, currentId, normalizedLimit);
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

      // Only cache POSITIVE results. A null result typically means one of
      // the index files is missing or unreadable — caching that as null
      // would let a transient condition (file still being written, brief
      // permission hiccup) poison the cache and surface as the permanent
      // "Load full file diff" CTA loop the user reported.
      if (result) {
        writeFullDiffMemoryCache(cacheKey, result);
        await writeFullDiffCache(result, normalizedLimit);
      }
      return result;
    })().finally(() => {
      fullDiffInflight.delete(cacheKey);
    });

    fullDiffInflight.set(cacheKey, pending);
    return pending;
  };

  const warmLatest = (rootPath: string) => {
    const latestPair = getLatestPair(rootPath);
    if (!latestPair) return null;
    return load(latestPair.baseline.id, latestPair.current.id, 1000).catch(() => {
      // best effort background warmup
      return null;
    });
  };

  return { load, warmLatest, memoryEntries: () => fullDiffCache.size };
}
