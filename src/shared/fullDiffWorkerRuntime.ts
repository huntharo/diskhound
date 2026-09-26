import * as FSP from "node:fs/promises";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { createReadStream } from "node:fs";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { createGunzip, deflateRaw, inflateRawSync } from "node:zlib";

import { resolveBundledWorkerScript } from "./bundledWorkerPath";
import type { FullDiffResult, FullFileChange } from "./contracts";
import type {
  FullDiffSortJob,
  FullDiffWorkerInput,
  FullDiffWorkerRequest,
  FullDiffWorkerResponse,
  SortedIndex,
} from "./fullDiffWorkerProtocol";

// The full diff compares two scan indexes, each a gzipped NDJSON file
// of every file on the drive (20M lines on a full 2 TB disk), without
// holding either in memory:
//
// 1. Sort. Each index is read, cut into runs of `sortChunkRecords`
//    records, and each run is sorted by key and written to the temp
//    dir. The two indexes sort at once: in the diff worker, the
//    baseline goes to a second worker thread (`sortElsewhere`).
// 2. Merge. Both sides' runs are read back through a heap, in key
//    order, and walked side by side.
//
// A run is a series of blocks: a u32 LE deflated length, a u32 LE
// inflated length, then up to RUN_BLOCK_RECORDS records deflated at
// level 1. A record is a u32 LE
// path byte length (the top bit set when the path is UTF-16LE rather
// than UTF-8), the size as a f64 LE, then the path. The key isn't
// stored; it is derived from the path again on read. Sorted paths share
// long prefixes, so a run takes ~17 B per file where the JSONL runs this
// replaces took ~300 B: 0.43 GB of temp files instead of 12.7 GB for a
// 20M-file pair.

interface FileIndexRecord {
  p: string;
  s: number;
}

const DEFAULT_LIMIT = 500;
const WINDOWS_PLATFORM = "win32";
const SORT_CHUNK = 120_000;
const RUN_BLOCK_RECORDS = 1024;
const RECORD_HEADER_BYTES = 12;
const BLOCK_HEADER_BYTES = 8;
const UTF16_PATH = 0x8000_0000;

const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const CLOSE_BRACE = 0x7d;
const ZERO = 0x30;
const NINE = 0x39;
/** Longer sizes take JSON.parse, so their rounding stays JSON.parse's. */
const MAX_FAST_SIZE_DIGITS = 15;
/**
 * The merge is synchronous between these. When the worker fails,
 * main.ts runs the diff on the main process, whose windows would
 * otherwise freeze for the whole merge (10-25 s on a 20M-file pair).
 */
const MERGE_STEPS_PER_YIELD = 65_536;

const deflateRawAsync = promisify(deflateRaw);

/**
 * Work the diff does, for the scaling test: index lines read, sort
 * comparisons (as n·log2 n per run), heap levels walked, and records
 * merged. It counts operations, not time.
 */
export const fullDiffWork = { steps: 0 };

function defaultCaseSensitivity(): boolean {
  return process.platform !== WINDOWS_PLATFORM;
}

function normalizeIndexPath(inputPath: string, caseSensitive: boolean): string {
  // Most paths have no trailing separator; skip the regex for them.
  const last = inputPath.charCodeAt(inputPath.length - 1);
  const trimmed = last === SLASH || last === BACKSLASH ? inputPath.replace(/[\\/]+$/, "") : inputPath;
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

/**
 * Reads the line shape the native scanner writes, `{"p":"…","s":N,…}`,
 * without JSON.parse, which was a third of reading a 20M-line index.
 * Returns the record, null for a line of that shape that isn't a file
 * (a folder, an extra hardlink), or undefined for anything else, which
 * the caller hands to JSON.parse: other key orders, escapes other than
 * `\\`, sizes past 15 digits, and malformed lines.
 */
function parseCanonicalIndexLine(line: string): FileIndexRecord | null | undefined {
  if (!line.startsWith("{\"p\":\"") || line.charCodeAt(line.length - 1) !== CLOSE_BRACE) {
    return undefined;
  }

  const start = 6;
  const end = line.indexOf("\"", start);
  if (end === -1) return undefined;
  // Every escape before the closing quote must be `\\`: Windows paths
  // are full of them. Any other escape, `\"` included, takes JSON.parse.
  let escaped = false;
  for (let slash = line.indexOf("\\", start); slash !== -1 && slash < end; slash = line.indexOf("\\", slash + 2)) {
    if (line.charCodeAt(slash + 1) !== BACKSLASH) return undefined;
    escaped = true;
  }

  const rest = end + 1;
  if (line.startsWith(",\"t\":\"d\"", rest)) return null;
  if (!line.startsWith(",\"s\":", rest)) return undefined;

  let at = rest + 5;
  const firstDigit = at;
  let size = 0;
  let code = line.charCodeAt(at);
  while (code >= ZERO && code <= NINE) {
    size = size * 10 + (code - ZERO);
    code = line.charCodeAt(++at);
  }
  const digits = at - firstDigit;
  if (digits === 0 || digits > MAX_FAST_SIZE_DIGITS) return undefined;
  // JSON has no leading zeros; leave "007" to JSON.parse to reject.
  if (digits > 1 && line.charCodeAt(firstDigit) === ZERO) return undefined;
  if (code !== COMMA && code !== CLOSE_BRACE) return undefined;
  // The fields after the size are numbers ("m", and "v"/"k" on some
  // scans). An extra hardlink adds "h":1; anything with "t" is left to
  // JSON.parse.
  if (line.indexOf(",\"h\":1,", at) !== -1 || line.endsWith(",\"h\":1}")) return null;
  if (line.indexOf("\"t\":", at) !== -1) return undefined;

  const path = line.slice(start, end);
  return { p: escaped ? path.replaceAll("\\\\", "\\") : path, s: size };
}

function parseIndexLine(line: string): FileIndexRecord | null {
  const canonical = parseCanonicalIndexLine(line);
  if (canonical !== undefined) return canonical;

  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  return isFileIndexRecord(record) ? record : null;
}

/**
 * Streams the file records of a gzipped NDJSON index. Returns false,
 * without calling back, when the file doesn't exist. `onRecord` returns
 * a promise only when the reader should wait for it.
 */
async function readFileIndexRecords(
  filePath: string,
  caseSensitive: boolean,
  onRecord: (path: string, size: number, key: string) => void | Promise<void>,
): Promise<boolean> {
  if (!FS.existsSync(filePath)) {
    return false;
  }

  const source = createReadStream(filePath, { highWaterMark: 1 << 20 });
  const gunzip = createGunzip({ chunkSize: 1 << 20 });
  // A read error ends the loop below with a rejection. Worker threads
  // with unhandled stream errors crash the whole worker, which the
  // parent sees only as "worker exited unexpectedly".
  source.on("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  gunzip.setEncoding("utf8");

  const handle = (line: string): void | Promise<void> => {
    fullDiffWork.steps += 1;
    const record = parseIndexLine(line);
    if (!record) return;
    return onRecord(record.p, record.s, normalizeIndexPath(record.p, caseSensitive));
  };

  // Split lines by hand: readline and a per-line await cost more than
  // parsing them.
  let rest = "";
  try {
    for await (const chunk of gunzip as AsyncIterable<string>) {
      const text = rest + chunk;
      let start = 0;
      for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", start)) {
        const line = text.slice(start, newline);
        start = newline + 1;
        if (!line) continue;
        const pending = handle(line);
        if (pending) await pending;
      }
      rest = text.slice(start);
    }
    if (rest) {
      const pending = handle(rest);
      if (pending) await pending;
    }
    return true;
  } finally {
    // A sort that stops early leaves the file open until GC otherwise.
    source.destroy();
  }
}

interface SortedRecord {
  key: string;
  p: string;
  s: number;
}

const compareKeys = (a: SortedRecord, b: SortedRecord) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** ES2024. V8 answers at once for one-byte strings, which most paths are. */
const isWellFormed = (text: string): boolean => (text as string & { isWellFormed(): boolean }).isWellFormed();

function encodeBlock(records: SortedRecord[], from: number, to: number): Buffer {
  let capacity = 0;
  for (let i = from; i < to; i += 1) capacity += RECORD_HEADER_BYTES + records[i]!.p.length * 3;
  const block = Buffer.allocUnsafe(capacity);
  let offset = 0;
  for (let i = from; i < to; i += 1) {
    const { p, s } = records[i]!;
    // UTF-8 would turn a lone surrogate (a Windows name JSON wrote as
    // \ud800) into U+FFFD, so such a path keeps its UTF-16 code units.
    const utf8 = isWellFormed(p);
    const length = block.write(p, offset + RECORD_HEADER_BYTES, utf8 ? "utf8" : "utf16le");
    block.writeUInt32LE(utf8 ? length : (length | UTF16_PATH) >>> 0, offset);
    block.writeDoubleLE(s, offset + 4);
    offset += RECORD_HEADER_BYTES + length;
  }
  return block.subarray(0, offset);
}

async function writeRun(records: SortedRecord[], runPath: string): Promise<void> {
  // Blocks deflate on libuv's thread pool, in parallel with each other
  // and with this thread reading the next run.
  const blocks: Array<Promise<Buffer[]>> = [];
  for (let from = 0; from < records.length; from += RUN_BLOCK_RECORDS) {
    const to = Math.min(from + RUN_BLOCK_RECORDS, records.length);
    const raw = encodeBlock(records, from, to);
    blocks.push(deflateRawAsync(raw, { level: 1 }).then((deflated) => {
      const header = Buffer.allocUnsafe(BLOCK_HEADER_BYTES);
      header.writeUInt32LE(deflated.length, 0);
      header.writeUInt32LE(raw.length, 4);
      return [header, deflated];
    }));
  }
  const parts = (await Promise.all(blocks)).flat();
  await FSP.writeFile(runPath, Buffer.concat(parts));
}

/**
 * Sorts one index into runs under `job.runDir`. When it settles, it has
 * nothing left writing there, so the caller can delete the directory.
 */
export async function sortIndexIntoRuns(job: FullDiffSortJob, signal?: AbortSignal): Promise<SortedIndex> {
  const runs: string[] = [];
  let buffer: SortedRecord[] = [];
  let writing: Promise<void> | undefined;
  let madeRunDir = false;

  // One run is compressed and written while the next one fills.
  const flush = async () => {
    signal?.throwIfAborted();
    if (buffer.length === 0) return;
    const records = buffer;
    buffer = [];
    records.sort(compareKeys);
    fullDiffWork.steps += records.length * Math.ceil(Math.log2(records.length + 1));
    if (writing) await writing;
    if (!madeRunDir) {
      await FSP.mkdir(job.runDir, { recursive: true });
      madeRunDir = true;
    }
    const runPath = Path.join(job.runDir, `run-${runs.length}.bin`);
    runs.push(runPath);
    writing = writeRun(records, runPath);
    // Awaited at the next flush. Until then a failure isn't unhandled.
    writing.catch(() => undefined);
  };

  try {
    const exists = await readFileIndexRecords(job.indexPath, job.caseSensitive, (p, s, key) => {
      buffer.push({ key, p, s });
      if (buffer.length >= job.sortChunkRecords) return flush();
    });
    await flush();
    await writing;
    return { exists, runs };
  } catch (error) {
    await writing?.catch(() => undefined);
    throw error;
  }
}

/**
 * Deflated blocks are read into this and inflated at once, so a block
 * costs one buffer allocation, the inflated one. Under Electron's V8
 * each allocation cost ~35 µs in the merge, and zlib's default 16 KB
 * output chunks and their concat made ~10 per block: 12 s of a 20M-file
 * diff. The merge is synchronous, so one scratch buffer serves every run.
 */
let deflatedScratch = Buffer.alloc(0);

/** Reads a run back one block at a time, synchronously. */
class RunReader {
  keys: string[] = [];
  paths: string[] = [];
  sizes: number[] = [];
  index = 0;
  done = false;
  private readonly fd: number;
  private position = 0;
  private closed = false;
  private readonly header = Buffer.allocUnsafe(BLOCK_HEADER_BYTES);

  constructor(
    private readonly runPath: string,
    /** Where the run was written; equal keys come out in this order. */
    readonly order: number,
    private readonly caseSensitive: boolean,
  ) {
    this.fd = FS.openSync(runPath, "r");
    this.loadBlock();
  }

  get key(): string {
    return this.keys[this.index]!;
  }

  get path(): string {
    return this.paths[this.index]!;
  }

  get size(): number {
    return this.sizes[this.index]!;
  }

  advance(): void {
    this.index += 1;
    if (this.index >= this.keys.length) this.loadBlock();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    FS.closeSync(this.fd);
  }

  private readExactly(target: Buffer, position: number): number {
    let read = 0;
    while (read < target.length) {
      const bytes = FS.readSync(this.fd, target, read, target.length - read, position + read);
      if (bytes === 0) break;
      read += bytes;
    }
    return read;
  }

  private loadBlock(): void {
    const headerBytes = this.readExactly(this.header, this.position);
    if (headerBytes === 0) {
      this.done = true;
      this.close();
      return;
    }
    const complete = headerBytes === BLOCK_HEADER_BYTES;
    const deflatedLength = complete ? this.header.readUInt32LE(0) : 0;
    const inflatedLength = complete ? this.header.readUInt32LE(4) : 0;
    if (deflatedScratch.length < deflatedLength) deflatedScratch = Buffer.allocUnsafe(deflatedLength * 2);
    const deflated = deflatedScratch.subarray(0, deflatedLength);
    if (!complete || this.readExactly(deflated, this.position + BLOCK_HEADER_BYTES) !== deflatedLength) {
      throw new Error(`Sorted run ${this.runPath} is truncated at byte ${this.position}`);
    }
    this.position += BLOCK_HEADER_BYTES + deflatedLength;

    // Room to spare: an output buffer that fills exactly makes zlib
    // allocate another.
    const block = inflateRawSync(deflated, { chunkSize: Math.max(64, inflatedLength + 64) });
    if (block.length !== inflatedLength) {
      throw new Error(`Sorted run ${this.runPath} has a bad block at byte ${this.position}`);
    }
    const keys: string[] = [];
    const paths: string[] = [];
    const sizes: number[] = [];
    let offset = 0;
    while (offset < block.length) {
      const header = block.readUInt32LE(offset);
      const size = block.readDoubleLE(offset + 4);
      const start = offset + RECORD_HEADER_BYTES;
      const end = start + (header & ~UTF16_PATH);
      const path = block.toString(header & UTF16_PATH ? "utf16le" : "utf8", start, end);
      keys.push(normalizeIndexPath(path, this.caseSensitive));
      paths.push(path);
      sizes.push(size);
      offset = end;
    }
    this.keys = keys;
    this.paths = paths;
    this.sizes = sizes;
    this.index = 0;
  }
}

/** Whether `a`'s record comes out before `b`'s: by key, then by run. */
function precedes(a: RunReader, b: RunReader): boolean {
  const aKey = a.key;
  const bKey = b.key;
  return aKey < bKey || (aKey === bKey && a.order < b.order);
}

/**
 * One side's runs read as one sorted stream, through a binary heap.
 * Replaces a scan of every run's head for each record, which grew with
 * runs × records: ~170 runs per side on a 20M-file index.
 */
class RunMerge {
  private readonly heap: RunReader[];

  constructor(readers: RunReader[]) {
    this.heap = readers.filter((reader) => !reader.done);
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i -= 1) this.siftDown(i);
  }

  get head(): RunReader | undefined {
    return this.heap[0];
  }

  advance(): void {
    const head = this.heap[0]!;
    head.advance();
    if (head.done) {
      const last = this.heap.pop()!;
      if (this.heap.length === 0) return;
      this.heap[0] = last;
    }
    this.siftDown(0);
  }

  private siftDown(start: number): void {
    const heap = this.heap;
    const count = heap.length;
    let i = start;
    while (true) {
      fullDiffWork.steps += 1;
      const left = 2 * i + 1;
      if (left >= count) return;
      const right = left + 1;
      const child = right < count && precedes(heap[right]!, heap[left]!) ? right : left;
      if (!precedes(heap[child]!, heap[i]!)) return;
      const swap = heap[i]!;
      heap[i] = heap[child]!;
      heap[child] = swap;
      i = child;
    }
  }
}

async function mergeSortedRuns(
  baselineRuns: string[],
  currentRuns: string[],
  caseSensitive: boolean,
  accumulator: DiffAccumulator,
): Promise<void> {
  const readers: RunReader[] = [];
  const open = (runs: string[]) => runs.map((runPath, order) => {
    const reader = new RunReader(runPath, order, caseSensitive);
    readers.push(reader);
    return reader;
  });

  try {
    const baseline = new RunMerge(open(baselineRuns));
    const current = new RunMerge(open(currentRuns));
    for (let step = 1; ; step += 1) {
      const left = baseline.head;
      const right = current.head;
      if (!left && !right) return;
      fullDiffWork.steps += 1;
      if (step % MERGE_STEPS_PER_YIELD === 0) await yieldToEventLoop();

      if (!right || (left && left.key < right.key)) {
        const previousSize = left!.size;
        accumulator.addChange({
          path: left!.path,
          kind: "removed",
          size: 0,
          previousSize,
          deltaBytes: -previousSize,
        });
        baseline.advance();
      } else if (!left || left.key > right.key) {
        const size = right.size;
        accumulator.addChange({
          path: right.path,
          kind: "added",
          size,
          previousSize: 0,
          deltaBytes: size,
        });
        current.advance();
      } else {
        const previousSize = left.size;
        const size = right.size;
        if (previousSize !== size) {
          const deltaBytes = size - previousSize;
          accumulator.addChange({
            path: right.path,
            kind: deltaBytes > 0 ? "grew" : "shrank",
            size,
            previousSize,
            deltaBytes,
          });
        }
        baseline.advance();
        current.advance();
      }
    }
  } finally {
    for (const reader of readers) reader.close();
  }
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


export interface ComputeFullDiffOptions {
  /**
   * Sorts the baseline index somewhere else, such as a second worker
   * thread, while this thread sorts the current one. Without it, both
   * sort on this thread, interleaved.
   */
  sortElsewhere?: (job: FullDiffSortJob, signal: AbortSignal) => Promise<SortedIndex>;
}

/**
 * Sorts both indexes at once. It settles only once neither side is
 * still writing runs, so the caller can delete the temp dir; the first
 * side to fail stops the other.
 */
async function sortBothIndexes(
  baselineJob: FullDiffSortJob,
  currentJob: FullDiffSortJob,
  sortElsewhere: ComputeFullDiffOptions["sortElsewhere"],
): Promise<[SortedIndex, SortedIndex]> {
  const controller = new AbortController();
  let failure: { error: unknown } | undefined;
  const stopTheOther = (error: unknown): never => {
    failure ??= { error };
    controller.abort();
    throw error;
  };

  const [baseline, current] = await Promise.allSettled([
    (sortElsewhere
      ? sortElsewhere(baselineJob, controller.signal)
      : sortIndexIntoRuns(baselineJob, controller.signal)
    ).catch(stopTheOther),
    sortIndexIntoRuns(currentJob, controller.signal).catch(stopTheOther),
  ]);
  if (failure) throw failure.error;
  return [
    (baseline as PromiseFulfilledResult<SortedIndex>).value,
    (current as PromiseFulfilledResult<SortedIndex>).value,
  ];
}

export async function computeFullDiffFromIndexFiles(
  input: FullDiffWorkerInput,
  options: ComputeFullDiffOptions = {},
): Promise<FullDiffResult | null> {
  const caseSensitive = input.caseSensitive ?? defaultCaseSensitivity();
  const limit = defaultChangeLimit(input.limit);
  const sortChunkRecords = Math.max(1, Math.floor(input.sortChunkRecords ?? SORT_CHUNK));

  const [baselineSize, currentSize] = await Promise.all([
    safeFileSize(input.baselinePath),
    safeFileSize(input.currentPath),
  ]);

  if (baselineSize === null && currentSize === null) {
    return null;
  }

  const tmpDir = Path.join(OS.tmpdir(), `diskhound-diff-${input.baselineId}-${input.currentId}-${process.pid}`);
  await FSP.mkdir(tmpDir, { recursive: true });

  try {
    const job = (indexPath: string, side: string): FullDiffSortJob => ({
      indexPath,
      caseSensitive,
      runDir: Path.join(tmpDir, side),
      sortChunkRecords,
    });
    const [baseline, current] = await sortBothIndexes(
      job(input.baselinePath, "b"),
      job(input.currentPath, "c"),
      options.sortElsewhere,
    );
    const accumulator = createDiffAccumulator(input.baselineId, input.currentId, limit);
    await mergeSortedRuns(baseline.runs, current.runs, caseSensitive, accumulator);
    return accumulator.finalize();
  } finally {
    await FSP.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function resolveBundledFullDiffWorkerPath(baseDir: string): string {
  return resolveBundledWorkerScript(baseDir, "fullDiffWorker.cjs");
}

export interface RunFullDiffWorkerOptions {
  workerPath: string;
  signal?: AbortSignal;
}

function newRequestId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function runFullDiffWorker(
  input: FullDiffWorkerInput,
  options: RunFullDiffWorkerOptions,
): Promise<FullDiffResult | null> {
  const response = await runWorkerRequest({ type: "compute", requestId: newRequestId(), input }, options);
  if (response.type !== "result") throw new Error(`Full diff worker answered ${response.type} to compute`);
  return response.result;
}

/** Sorts one index into runs on a worker thread of its own. */
export async function runFullDiffSortWorker(
  job: FullDiffSortJob,
  options: RunFullDiffWorkerOptions,
): Promise<SortedIndex> {
  const response = await runWorkerRequest({ type: "sort", requestId: newRequestId(), job }, options);
  if (response.type !== "sorted") throw new Error(`Full diff worker answered ${response.type} to sort`);
  return response.sorted;
}

type FullDiffWorkerSuccess = Exclude<FullDiffWorkerResponse, { type: "error" }>;

async function runWorkerRequest(
  request: FullDiffWorkerRequest,
  options: RunFullDiffWorkerOptions,
): Promise<FullDiffWorkerSuccess> {
  // Worker old-gen heap evolution:
  //   Default Node:      ~2 GB — OOMed on 4M-file drives
  //   v0.5.x:            4 GB  — OOMed on 7M-file drives
  //   v0.5.20-ish:       8 GB  — held until a 7.8M-file drive hit it
  //   v0.5.39:           12 GB — one side loaded into a compact Map
  //   now:               2 GB  — external-sort streaming merge
  //
  // The merge sorts each index into SORT_CHUNK-record runs on disk,
  // then walks both sides in key order. It holds two chunks (~120k
  // records each, one filling while the other is written) while
  // sorting, and one decoded block (~1k records) per run while merging,
  // instead of a 7M-entry Map. The worker that sorts the baseline for
  // the diff worker gets the same limit. 2 GB is a safety ceiling, not
  // a working set.
  const worker = new Worker(options.workerPath, {
    resourceLimits: {
      maxOldGenerationSizeMb: 2048,
      maxYoungGenerationSizeMb: 256,
    },
  });
  const { requestId } = request;

  return await new Promise<FullDiffWorkerSuccess>((resolve, reject) => {
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

      if (message.type === "error") {
        settle(() => reject(new Error(message.message)));
        return;
      }

      settle(() => resolve(message));
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

    worker.postMessage(request);
  });
}
