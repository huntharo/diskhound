import * as FSP from "node:fs/promises";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import { createGunzip } from "node:zlib";

import { resolveBundledWorkerScript } from "./bundledWorkerPath";
import type { FullDiffResult, FullFileChange } from "./contracts";
import type {
  FullDiffWorkerInput,
  FullDiffWorkerRequest,
  FullDiffWorkerResponse,
} from "./fullDiffWorkerProtocol";

interface FileIndexRecord {
  p: string;
  s: number;
}

/**
 * Compact map entry used for the loaded-fully side of the diff.
 * v0.5.39 collapses the previous `Map<string, FileIndexRecord>` into
 * `Map<string, CompactMapValue>` to shave memory on 7M+ file drives.
 *
 *   Was: Map<key, {p: string, s: number}>
 *        ~ 200B key + 32B object header + 200B p ref + 8B s = ~440B/entry
 *
 *   Now: Map<key, [origPath: string | null, size: number]>
 *        ~ 200B key + 24B array + 200B p ref + 8B s = ~432B/entry
 *        AND we set origPath = null when key === origPath (POSIX
 *        case-sensitive volumes always; Windows when no case-folding
 *        happened) — which on POSIX saves the entire 200B duplicate
 *        path string.
 *
 * For a 7M-file POSIX scan that's ~1.4 GB freed. On Windows the
 * saving is smaller (the lowercased key differs from the original
 * path) but still meaningful for ASCII-only paths where some
 * segments are already lowercase.
 *
 * Tuple chosen over an object because V8 optimises small in-bounds
 * arrays as packed elements — no per-property descriptors.
 */
const DEFAULT_LIMIT = 500;
const WINDOWS_PLATFORM = "win32";

function defaultCaseSensitivity(): boolean {
  return process.platform !== WINDOWS_PLATFORM;
}

function normalizeIndexPath(inputPath: string, caseSensitive: boolean): string {
  const trimmed = inputPath.replace(/[\\/]+$/, "");
  return caseSensitive ? trimmed : trimmed.toLowerCase();
}

function isFileIndexRecord(value: unknown): value is FileIndexRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { p?: unknown; s?: unknown; t?: unknown; h?: unknown };
  return typeof candidate.p === "string"
    && typeof candidate.s === "number"
    && candidate.t !== "d"
    && candidate.h !== 1;
}

async function streamFileIndexRecords(
  filePath: string,
  onRecord: (record: FileIndexRecord, key: string) => void | Promise<void>,
  caseSensitive: boolean,
): Promise<void> {
  if (!FS.existsSync(filePath)) {
    return;
  }

  const gunzip = createGunzip();
  const source = createReadStream(filePath);
  // Worker threads with unhandled stream errors crash the whole
  // worker, which the parent surfaces as a generic "worker exited
  // unexpectedly" error. Attach listeners so the for-await loop
  // surfaces the error as a normal rejection instead.
  source.on("error", () => { /* swallowed */ });
  gunzip.on("error", () => { /* swallowed */ });
  source.pipe(gunzip);

  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isFileIndexRecord(record)) {
      continue;
    }

    await onRecord(record, normalizeIndexPath(record.p, caseSensitive));
  }
}

const SORT_CHUNK = 120_000;

interface SortedRec {
  key: string;
  p: string;
  s: number;
}

async function writeSortedChunk(records: SortedRec[], dest: string): Promise<void> {
  records.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  await FSP.mkdir(Path.dirname(dest), { recursive: true });
  const lines = records.map((rec) => JSON.stringify(rec)).join("\n") + "\n";
  await FSP.writeFile(dest, lines, "utf8");
}

async function* readSortedChunk(filePath: string): AsyncGenerator<SortedRec> {
  if (!FS.existsSync(filePath)) return;
  const source = createReadStream(filePath, { encoding: "utf8" });
  source.on("error", () => { /* swallowed */ });
  const rl = createInterface({ input: source, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as SortedRec;
      if (rec && typeof rec.key === "string") yield rec;
    } catch { /* skip */ }
  }
}

async function* mergeSortedChunks(chunkPaths: string[]): AsyncGenerator<SortedRec> {
  const iters = chunkPaths.map((p) => readSortedChunk(p));
  const heads: Array<IteratorResult<SortedRec> | null> = await Promise.all(
    iters.map((it) => it.next()),
  );
  while (true) {
    let best = -1;
    for (let i = 0; i < heads.length; i++) {
      const head = heads[i];
      if (!head || head.done) continue;
      if (best < 0 || head.value.key < heads[best]!.value.key) best = i;
    }
    if (best < 0) break;
    yield heads[best]!.value;
    heads[best] = await iters[best]!.next();
  }
}

async function* iterateSortedRecords(
  filePath: string,
  caseSensitive: boolean,
  tmpDir: string,
): AsyncGenerator<SortedRec> {
  const chunks: string[] = [];
  let buffer: SortedRec[] = [];
  let chunkIndex = 0;

  const flush = async () => {
    if (buffer.length === 0) return;
    const dest = Path.join(tmpDir, `chunk-${chunkIndex++}.jsonl`);
    await writeSortedChunk(buffer, dest);
    chunks.push(dest);
    buffer = [];
  };

  await streamFileIndexRecords(
    filePath,
    async (record, key) => {
      buffer.push({ key, p: record.p, s: record.s });
      if (buffer.length >= SORT_CHUNK) await flush();
    },
    caseSensitive,
  );
  await flush();

  if (chunks.length === 0) return;
  if (chunks.length === 1) {
    yield* readSortedChunk(chunks[0]!);
    return;
  }
  yield* mergeSortedChunks(chunks);
}

async function safeFileSize(filePath: string): Promise<number | null> {
  try {
    const stat = await FSP.stat(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function createTopChangeAccumulator(limit: number): {
  add: (change: FullFileChange) => void;
  toSortedArray: () => FullFileChange[];
} {
  const cappedLimit = Math.max(0, Math.floor(limit));
  // Kept sorted ASCENDING by |deltaBytes| — index 0 is the smallest,
  // so dropping the loser after overflow is O(1) at the head via shift
  // (Array shift is O(n) in theory but V8 tiny-array shifts stay cheap).
  //
  // Using a sorted-insertion strategy instead of Array.sort() on every
  // add: a full sort is O(n log n) and was the dominant cost on diffs
  // with millions of changes; a binary insert is O(log n) compare +
  // O(n) splice, so asymptotically the same per-insert in the worst
  // case but with far lower constants and no wasted comparisons over
  // the already-sorted prefix.
  const changes: FullFileChange[] = [];

  const absDelta = (c: FullFileChange) => Math.abs(c.deltaBytes);

  return {
    add(change) {
      if (cappedLimit === 0) {
        return;
      }

      const target = absDelta(change);

      // Fast reject: once we're at capacity, anything smaller than the
      // current smallest top-K entry can be dropped without any work.
      if (changes.length === cappedLimit && target <= absDelta(changes[0]!)) {
        return;
      }

      // Binary search for insertion point (ascending by |delta|).
      let lo = 0;
      let hi = changes.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (absDelta(changes[mid]!) <= target) lo = mid + 1;
        else hi = mid;
      }
      changes.splice(lo, 0, change);
      if (changes.length > cappedLimit) {
        changes.shift();
      }
    },
    toSortedArray() {
      // Caller wants descending by |delta|. Clone + reverse beats
      // re-sorting because the internal array is already sorted
      // ascending.
      const out = changes.slice();
      out.reverse();
      return out;
    },
  };
}

interface DiffAccumulator {
  addChange: (change: FullFileChange) => void;
  finalize: () => FullDiffResult;
}

function createDiffAccumulator(
  baselineId: string,
  currentId: string,
  limit: number,
): DiffAccumulator {
  let totalChanges = 0;
  let totalAdded = 0;
  let totalRemoved = 0;
  let totalGrew = 0;
  let totalShrank = 0;
  let totalBytesAdded = 0;
  let totalBytesRemoved = 0;

  const topChanges = createTopChangeAccumulator(limit);

  return {
    addChange(change) {
      totalChanges += 1;
      topChanges.add(change);

      switch (change.kind) {
        case "added":
          totalAdded += 1;
          totalBytesAdded += change.size;
          break;
        case "removed":
          totalRemoved += 1;
          totalBytesRemoved += change.previousSize;
          break;
        case "grew":
          totalGrew += 1;
          totalBytesAdded += change.deltaBytes;
          break;
        case "shrank":
          totalShrank += 1;
          totalBytesRemoved += Math.abs(change.deltaBytes);
          break;
      }
    },
    finalize() {
      return {
        baselineId,
        currentId,
        totalChanges,
        totalAdded,
        totalRemoved,
        totalGrew,
        totalShrank,
        totalBytesAdded,
        totalBytesRemoved,
        changes: topChanges.toSortedArray(),
        truncated: totalChanges > Math.max(0, Math.floor(limit)),
      };
    },
  };
}

function defaultChangeLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }

  return Math.max(0, Math.floor(limit));
}

export async function computeFullDiffFromIndexFiles(
  input: FullDiffWorkerInput,
): Promise<FullDiffResult | null> {
  const caseSensitive = input.caseSensitive ?? defaultCaseSensitivity();
  const limit = defaultChangeLimit(input.limit);

  const [baselineSize, currentSize] = await Promise.all([
    safeFileSize(input.baselinePath),
    safeFileSize(input.currentPath),
  ]);

  if (baselineSize === null && currentSize === null) {
    return null;
  }

  const accumulator = createDiffAccumulator(input.baselineId, input.currentId, limit);
  const tmpDir = Path.join(OS.tmpdir(), `diskhound-diff-${input.baselineId}-${input.currentId}-${process.pid}`);
  await FSP.mkdir(tmpDir, { recursive: true });

  try {
    const baselineIter = iterateSortedRecords(input.baselinePath, caseSensitive, Path.join(tmpDir, "b"));
    const currentIter = iterateSortedRecords(input.currentPath, caseSensitive, Path.join(tmpDir, "c"));
    let baseline = await baselineIter.next();
    let current = await currentIter.next();

    while (!baseline.done || !current.done) {
      if (baseline.done) {
        const rec = current.value;
        accumulator.addChange({
          path: rec.p,
          kind: "added",
          size: rec.s,
          previousSize: 0,
          deltaBytes: rec.s,
        });
        current = await currentIter.next();
        continue;
      }
      if (current.done) {
        const rec = baseline.value;
        accumulator.addChange({
          path: rec.p,
          kind: "removed",
          size: 0,
          previousSize: rec.s,
          deltaBytes: -rec.s,
        });
        baseline = await baselineIter.next();
        continue;
      }

      const left = baseline.value;
      const right = current.value;
      if (left.key < right.key) {
        accumulator.addChange({
          path: left.p,
          kind: "removed",
          size: 0,
          previousSize: left.s,
          deltaBytes: -left.s,
        });
        baseline = await baselineIter.next();
      } else if (left.key > right.key) {
        accumulator.addChange({
          path: right.p,
          kind: "added",
          size: right.s,
          previousSize: 0,
          deltaBytes: right.s,
        });
        current = await currentIter.next();
      } else {
        if (left.s !== right.s) {
          const deltaBytes = right.s - left.s;
          accumulator.addChange({
            path: right.p,
            kind: deltaBytes > 0 ? "grew" : "shrank",
            size: right.s,
            previousSize: left.s,
            deltaBytes,
          });
        }
        baseline = await baselineIter.next();
        current = await currentIter.next();
      }
    }
  } finally {
    await FSP.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return accumulator.finalize();
}

export function resolveBundledFullDiffWorkerPath(baseDir: string): string {
  return resolveBundledWorkerScript(baseDir, "fullDiffWorker.cjs");
}

export interface RunFullDiffWorkerOptions {
  workerPath: string;
  signal?: AbortSignal;
}

export async function runFullDiffWorker(
  input: FullDiffWorkerInput,
  options: RunFullDiffWorkerOptions,
): Promise<FullDiffResult | null> {
  // Worker old-gen heap evolution:
  //   Default Node:      ~2 GB — OOMed on 4M-file drives
  //   v0.5.x:            4 GB  — OOMed on 7M-file drives
  //   v0.5.20-ish:       8 GB  — held until a 7.8M-file drive hit it
  //   v0.5.39:           12 GB — paired with the compact-value map
  //                              encoding below
  //
  // Reserved pages don't commit until touched, so small diffs still
  // pay zero extra cost. The 12 GB ceiling means the worker is safe
  // up to roughly 10M-file index pairs on a box with 16+ GB RAM.
  // Beyond that we'd need an external-sort-style streaming merge,
  // which is a much bigger architectural change (tracked separately).
  const worker = new Worker(options.workerPath, {
    resourceLimits: {
      // Streaming merge keeps one sort-chunk (~120k records) in memory,
      // not a 7M-entry Map. 2 GB is a safety ceiling, not a working set.
      maxOldGenerationSizeMb: 2048,
      maxYoungGenerationSizeMb: 256,
    },
  });
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return await new Promise<FullDiffResult | null>((resolve, reject) => {
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const handleAbort = () => {
      void worker.terminate().finally(() => {
        settle(() => reject(new Error("Full diff worker aborted")));
      });
    };

    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      options.signal?.removeEventListener("abort", handleAbort);
    };

    const onMessage = (message: FullDiffWorkerResponse) => {
      if (!message || message.requestId !== requestId) {
        return;
      }

      void worker.terminate().finally(() => {
        if (message.type === "result") {
          settle(() => resolve(message.result));
          return;
        }

        settle(() => reject(new Error(message.message)));
      });
    };

    const onError = (error: Error) => {
      settle(() => reject(error));
    };

    const onExit = (code: number) => {
      if (!settled && code !== 0) {
        // Code 1 on a worker thread is almost always the V8 heap
        // running out of room (ERR_WORKER_OUT_OF_MEMORY surfaces as
        // exit code 1 in node:worker_threads). Tag it explicitly so
        // the crash log line reads as a diagnosis rather than a
        // generic "exited with code 1."
        const detail = code === 1
          ? `Full diff worker out of memory (exit code 1). The streaming merge still needs headroom for sort chunks — the fast top-N summary still works.`
          : `Full diff worker exited with code ${code}`;
        settle(() => reject(new Error(detail)));
      }
    };

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);

    if (options.signal) {
      if (options.signal.aborted) {
        handleAbort();
        return;
      }
      options.signal.addEventListener("abort", handleAbort, { once: true });
    }

    const request: FullDiffWorkerRequest = {
      type: "compute",
      requestId,
      input,
    };
    worker.postMessage(request);
  });
}
