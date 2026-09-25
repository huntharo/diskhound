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
import { BinaryHeap, TopK } from "./topK";

interface FileIndexRecord {
  p: string;
  s: number;
}

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

export interface SortedRec {
  key: string;
  p: string;
  s: number;
}

export async function writeSortedChunk(records: SortedRec[], dest: string): Promise<void> {
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

/**
 * K-way merge of sorted chunk files. The chunk heads sit in a heap, so
 * each record costs O(log K) key comparisons rather than a scan of every
 * head. Equal keys come out in chunk order.
 */
export async function* mergeSortedChunks(chunkPaths: string[]): AsyncGenerator<SortedRec> {
  const iters = chunkPaths.map((p) => readSortedChunk(p));
  const heads = await Promise.all(iters.map((it) => it.next()));
  const heap = new BinaryHeap<{ rec: SortedRec; chunk: number }>((a, b) => (
    a.rec.key < b.rec.key || (a.rec.key === b.rec.key && a.chunk < b.chunk)
  ));
  heads.forEach((head, chunk) => {
    if (!head.done) heap.push({ rec: head.value, chunk });
  });
  while (heap.size > 0) {
    const { rec, chunk } = heap.peek()!;
    yield rec;
    const next = await iters[chunk]!.next();
    if (next.done) heap.pop();
    else heap.replaceTop({ rec: next.value, chunk });
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

/**
 * The `limit` changes with the largest |deltaBytes|. Equal deltas keep
 * the order they were added (merge order, i.e. by path), like the stable
 * sort in `diffIndexes`.
 */
export function createTopChangeAccumulator(limit: number): {
  add: (change: FullFileChange) => void;
  toSortedArray: () => FullFileChange[];
} {
  const top = new TopK<FullFileChange>(limit, (a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes));
  return {
    add(change) {
      top.offer(change);
    },
    toSortedArray() {
      return top.sorted();
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
  //   v0.5.39:           12 GB — one side loaded into a compact Map
  //   now:               2 GB  — external-sort streaming merge
  //
  // The merge sorts each index into SORT_CHUNK-record runs on disk,
  // then walks both sides in key order. It holds one chunk (~120k
  // records) while writing runs and one record per run while merging,
  // instead of a 7M-entry Map. 2 GB is a safety ceiling, not a working
  // set.
  const worker = new Worker(options.workerPath, {
    resourceLimits: {
      maxOldGenerationSizeMb: 2048,
      maxYoungGenerationSizeMb: 256,
    },
  });
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return await new Promise<FullDiffResult | null>((resolve, reject) => {
    let settled = false;

    // Mark settled and drop the listeners BEFORE terminate(). A
    // terminated worker exits with code 1, and Node emits 'exit' to
    // onExit before terminate()'s promise resolves. Settling afterwards
    // let onExit reject a finished diff as a crash, and main.ts then
    // recomputed it on the main thread.
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate().finally(callback);
    };

    const handleAbort = () => {
      settle(() => reject(new Error("Full diff worker aborted")));
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

      if (message.type === "result") {
        settle(() => resolve(message.result));
        return;
      }

      settle(() => reject(new Error(message.message)));
    };

    const onError = (error: Error) => {
      // A heap-limit kill arrives here as ERR_WORKER_OUT_OF_MEMORY,
      // then 'exit' with code 1. Tag it so the crash log line reads as
      // a diagnosis. Code 1 alone does not mean OOM: an uncaught throw
      // and terminate() exit with 1 too.
      if ((error as NodeJS.ErrnoException)?.code === "ERR_WORKER_OUT_OF_MEMORY") {
        const detail = `Full diff worker out of memory. The streaming merge still needs headroom for sort chunks — the fast top-N summary still works.`;
        settle(() => reject(new Error(detail, { cause: error })));
        return;
      }
      settle(() => reject(error));
    };

    const onExit = (code: number) => {
      if (code !== 0) {
        settle(() => reject(new Error(`Full diff worker exited with code ${code}`)));
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
