import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import * as OS from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect } from "vitest";

/**
 * Checked-in disk I/O budgets for DiskHound's persistence paths.
 *
 * DiskHound keeps its state in JSON and gzipped NDJSON files under
 * Electron's userData. Nothing counted those writes before this, so a
 * store that rewrites an unchanged file on every tick, or once per
 * streamed event, passed every test while wearing the user's SSD.
 *
 * A scenario wraps one feature in `measureFsIo` and asserts the counts
 * against `io-budgets.json` with `expectIoBudget`. Only the feature is
 * measured, not its setup, so a budget moves when the feature's I/O
 * pattern moves and stays put when a test grows more fixtures.
 *
 * ## Wiring a test file
 *
 * Counting uses a pass-through mock of `node:fs` and `node:fs/promises`.
 * DiskHound modules import those as namespaces, which a spy on
 * `fs.promises` alone would miss for the sync APIs. Put these two lines
 * at the top of the test file (the path is relative to the test):
 *
 *     vi.mock("node:fs", async (importOriginal) =>
 *       (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
 *     vi.mock("node:fs/promises", async (importOriginal) =>
 *       (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));
 *
 * ## What is counted
 *
 * Every call, sync, callback or promise, counts once under the name of
 * its async form: `writeFileSync` and `fs.promises.writeFile` both count
 * as `writeFile`. `bytesWritten` adds the data passed to writeFile and
 * appendFile, the size of each file copyFile copies, and the bytes a
 * write stream flushed.
 *
 * ## Counting processes and workers
 *
 * A poll that shells out to `df` or PowerShell, or a handler that
 * streams an index in a worker thread, does its I/O where the fs mock
 * cannot see it. `measureFsIo(fn, { countProcesses: true })` also
 * counts `spawn` (every child_process spawn, exec, execFile and fork,
 * sync or not) and `worker` (every `new Worker`). It needs two more
 * pass-through mocks in the test file:
 *
 *     vi.mock("node:child_process", async (importOriginal) =>
 *       (await import("../../test/ioBudget")).instrumentChildProcess(await importOriginal()));
 *     vi.mock("node:worker_threads", async (importOriginal) =>
 *       (await import("../../test/ioBudget")).instrumentWorkerThreads(await importOriginal()));
 *
 * Budgets recorded without `countProcesses` carry no process counts,
 * and a budget that has them fails a measurement that lacks them.
 *
 * ## Settling
 *
 * Stores often persist fire-and-forget (`void persist()`). When the
 * measured function returns, `measureFsIo` waits for every fs call in
 * flight to finish, and for any call those continuations start, before
 * it closes the window. It does the same before opening the window, so
 * setup's fire-and-forget writes land outside it. Streams count as
 * finished when they close. Fake timers do not stall this: the helper
 * keeps the real `setImmediate` and `setTimeout` it saw at load.
 *
 * ## Trusting a zero
 *
 * A zero is only a measurement if the counters are live. The first
 * `measureFsIo` in each test file first writes two known files, one
 * through each module, and throws if the counters did not see them.
 * That catches a test file that forgot the `vi.mock` lines. The first
 * `countProcesses` measurement likewise spawns a command that does not
 * exist and starts a one-line worker, and throws unless both counted.
 *
 * ## Budgets
 *
 * Counts are asserted exactly, in both directions: an increase is the
 * regression this exists to catch, and a decrease means the budget is
 * stale and would stop catching anything. Bytes depend on fixture
 * sizes, so they are recorded as `observedBytesWritten` for the
 * MB/day projection and never asserted.
 *
 * To record or change a budget, run
 * `UPDATE_IO_BUDGETS=1 bun run test <file>` and commit the diff, so the
 * write cost change shows up as a reviewable line in the PR. Add
 * `IO_BUDGET_TRACE=1` to print each counted call, its path and its
 * bytes, for the note's per-file breakdown. Parallel
 * test workers take turns on the JSON file through a lock file next to
 * it, so re-recording the whole suite at once is safe.
 */

export const IO_WRITE_COUNTERS = [
  "writeFile",
  "appendFile",
  "rename",
  "copyFile",
  "link",
  "mkdir",
  "createWriteStream",
  "unlink",
] as const;

export const IO_READ_COUNTERS = [
  "readFile",
  "readdir",
  "stat",
  "lstat",
  "access",
  "existsSync",
  "createReadStream",
  "open",
] as const;

export const IO_PROCESS_COUNTERS = ["spawn", "worker"] as const;

export type IoCounter =
  | (typeof IO_WRITE_COUNTERS)[number]
  | (typeof IO_READ_COUNTERS)[number];

export type ProcessCounter = (typeof IO_PROCESS_COUNTERS)[number];

/** Process counts are present only when the measurement counted them. */
export type FsIo = Record<IoCounter, number>
  & Partial<Record<ProcessCounter, number>>
  & { bytesWritten: number };

const IO_COUNTERS: readonly IoCounter[] = [...IO_WRITE_COUNTERS, ...IO_READ_COUNTERS];

/** `node:fs` function name → counter. Streams are handled separately. */
const FS_FUNCTIONS: Record<string, IoCounter> = {
  writeFile: "writeFile",
  writeFileSync: "writeFile",
  appendFile: "appendFile",
  appendFileSync: "appendFile",
  rename: "rename",
  renameSync: "rename",
  copyFile: "copyFile",
  copyFileSync: "copyFile",
  link: "link",
  linkSync: "link",
  mkdir: "mkdir",
  mkdirSync: "mkdir",
  unlink: "unlink",
  unlinkSync: "unlink",
  readFile: "readFile",
  readFileSync: "readFile",
  readdir: "readdir",
  readdirSync: "readdir",
  stat: "stat",
  statSync: "stat",
  lstat: "lstat",
  lstatSync: "lstat",
  access: "access",
  accessSync: "access",
  existsSync: "existsSync",
  open: "open",
  openSync: "open",
};

/** `node:fs/promises` (and `fs.promises`) function name → counter. */
const FS_PROMISES_FUNCTIONS: Record<string, IoCounter> = {
  writeFile: "writeFile",
  appendFile: "appendFile",
  rename: "rename",
  copyFile: "copyFile",
  link: "link",
  mkdir: "mkdir",
  unlink: "unlink",
  readFile: "readFile",
  readdir: "readdir",
  stat: "stat",
  lstat: "lstat",
  access: "access",
  open: "open",
};

const BYTE_COUNTED = new Set<IoCounter>(["writeFile", "appendFile"]);

// Captured at load, before any test can install fake timers.
const realSetImmediate = globalThis.setImmediate;
const realSetTimeout = globalThis.setTimeout;
const realNow = performance.now.bind(performance);

/** Real fs for the helper's own files. `require` bypasses vi.mock. */
const realFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");

const SETTLE_TIMEOUT_MS = 3_000;

interface Window {
  io: FsIo;
  /** Limits the window to calls on these paths. The probe uses it. */
  accepts?: (target: string) => boolean;
}

/** Every measurement window currently open; each call counts in all. */
let openWindows: Window[] = [];
/** fs work that has not finished yet, whether or not a window saw it start. */
const inflight = new Map<Promise<unknown>, string>();
let instrumentationProven = false;

function emptyIo(countProcesses = false): FsIo {
  const io = { bytesWritten: 0 } as FsIo;
  for (const counter of IO_COUNTERS) io[counter] = 0;
  if (countProcesses) for (const counter of IO_PROCESS_COUNTERS) io[counter] = 0;
  return io;
}

function windowsFor(target: string): Window[] {
  return openWindows.filter((window) => !window.accepts || window.accepts(target));
}

function record(counter: IoCounter | ProcessCounter, bytes: number, target: string): void {
  let counted = false;
  for (const { io } of windowsFor(target)) {
    // A window that is not counting processes has no key for them.
    if (io[counter] === undefined) continue;
    io[counter] += 1;
    io.bytesWritten += bytes;
    counted = true;
  }
  if (counted) trace(counter, target, bytes);
}

/** `IO_BUDGET_TRACE=1` prints every counted call, for writing a budget's note. */
function trace(counter: string, target: string, bytes: number): void {
  if (!process.env.IO_BUDGET_TRACE) return;
  process.stderr.write(`[io] ${counter} ${target}${bytes ? ` ${bytes} B` : ""}\n`);
}

function track(work: Promise<unknown>, label: string): void {
  inflight.set(work, label);
  const done = () => {
    inflight.delete(work);
  };
  work.then(done, done);
}

function dataBytes(data: unknown, options: unknown): number {
  if (typeof data === "string") {
    const encoding =
      typeof options === "string"
        ? options
        : options && typeof options === "object"
          ? (options as { encoding?: string }).encoding
          : undefined;
    return Buffer.byteLength(data, (encoding ?? "utf8") as BufferEncoding);
  }
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
}

/** A copy writes the whole source file. Read before the copy starts. */
function copiedBytes(source: unknown): number {
  try {
    return realFs.statSync(source as string).size;
  } catch {
    return 0;
  }
}

function describeTarget(args: unknown[]): string {
  const target = args[0];
  return typeof target === "string" ? target : String(target);
}

function countedFunction(
  original: (...args: unknown[]) => unknown,
  counter: IoCounter,
  label: string,
): (...args: unknown[]) => unknown {
  return function counted(this: unknown, ...args: unknown[]) {
    const target = describeTarget(args);
    const bytes = BYTE_COUNTED.has(counter)
      ? dataBytes(args[1], args[2])
      : counter === "copyFile" ? copiedBytes(args[0]) : 0;
    record(counter, bytes, target);
    const last = args.length - 1;
    let finish: (() => void) | undefined;
    if (last >= 0 && typeof args[last] === "function") {
      // Callback form: finished when the callback runs.
      const callback = args[last] as (...cbArgs: unknown[]) => unknown;
      track(new Promise<void>((resolve) => { finish = resolve; }), `${label} ${target}`);
      args[last] = function tracked(this: unknown, ...cbArgs: unknown[]) {
        finish?.();
        return callback.apply(this, cbArgs);
      };
    }
    let result: unknown;
    try {
      result = original.apply(this, args);
    } catch (error) {
      // Thrown before the callback was scheduled: it will never run.
      finish?.();
      throw error;
    }
    if (result && typeof (result as Promise<unknown>).then === "function") {
      track(result as Promise<unknown>, `${label} ${target}`);
    }
    return result;
  };
}

type StreamFactory = (...args: unknown[]) => NodeJS.EventEmitter & { bytesWritten?: number };

function countedStream(original: StreamFactory, counter: IoCounter, label: string): StreamFactory {
  return function counted(this: unknown, ...args: unknown[]) {
    const target = describeTarget(args);
    const stream = original.apply(this, args);
    record(counter, 0, target);
    // Bytes land in the windows that saw the stream open.
    const windows = windowsFor(target);
    // No "error" listener: adding one would swallow errors the code
    // under test must see. fs streams emit "close" after an error too.
    // "finish" / "end" also count, for streams opened with
    // autoClose or emitClose off, which never close on their own.
    track(
      new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          if (counter === "createWriteStream") {
            for (const { io } of windows) io.bytesWritten += stream.bytesWritten ?? 0;
            if (windows.length > 0) trace("createWriteStream (closed)", target, stream.bytesWritten ?? 0);
          }
          resolve();
        };
        stream.once("close", done);
        stream.once(counter === "createWriteStream" ? "finish" : "end", done);
      }),
      `${label} ${target}`,
    );
    return stream;
  };
}

function instrumentFunctions(
  original: Record<string, unknown>,
  functions: Record<string, IoCounter>,
  prefix: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...original };
  for (const [name, counter] of Object.entries(functions)) {
    const fn = original[name];
    if (typeof fn === "function") {
      out[name] = countedFunction(fn as (...args: unknown[]) => unknown, counter, `${prefix}${name}`);
    }
  }
  return out;
}

const instrumentedPromises = new WeakMap<object, Record<string, unknown>>();

function instrumentPromisesApi(original: Record<string, unknown>): Record<string, unknown> {
  const cached = instrumentedPromises.get(original);
  if (cached) return cached;
  const out = instrumentFunctions(original, FS_PROMISES_FUNCTIONS, "fs.promises.");
  instrumentedPromises.set(original, out);
  return out;
}

/**
 * The modules the factories handed to this test file. The probe writes
 * through these rather than importing `node:fs` itself: vitest gives a
 * module first loaded inside a mock factory the original of the module
 * being mocked, and this helper is loaded inside one.
 */
let instrumentedFs: typeof import("node:fs") | null = null;
let instrumentedFsPromises: typeof import("node:fs/promises") | null = null;

/** `vi.mock("node:fs")` factory body. See the module comment. */
export function instrumentFs<T>(original: T): T {
  const real = original as Record<string, unknown>;
  const out = instrumentFunctions(real, FS_FUNCTIONS, "fs.");
  out.createWriteStream = countedStream(real.createWriteStream as StreamFactory, "createWriteStream", "fs.createWriteStream");
  out.createReadStream = countedStream(real.createReadStream as StreamFactory, "createReadStream", "fs.createReadStream");
  const promises = real.promises as Record<string, unknown> | undefined;
  if (promises) out.promises = instrumentPromisesApi(promises);
  out.default = out;
  instrumentedFs = out as unknown as typeof import("node:fs");
  return out as T;
}

/** `vi.mock("node:fs/promises")` factory body. See the module comment. */
export function instrumentFsPromises<T>(original: T): T {
  const real = original as Record<string, unknown>;
  const underlying = (real.default ?? real) as Record<string, unknown>;
  const out = { ...real, ...instrumentPromisesApi(underlying) };
  out.default = out;
  instrumentedFsPromises = out as unknown as typeof import("node:fs/promises");
  return out as T;
}

const CHILD_PROCESS_FUNCTIONS = [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
] as const;

/** Tracks a child until it exits, so a window closes after the process it saw. */
function trackChild(child: ChildProcess, label: string): void {
  track(
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    }),
    label,
  );
}

function countedSpawn(
  original: (...args: unknown[]) => unknown,
  label: string,
): (...args: unknown[]) => unknown {
  return function counted(this: unknown, ...args: unknown[]) {
    const target = describeTarget(args);
    record("spawn", 0, target);
    const result = original.apply(this, args);
    if (result && typeof (result as ChildProcess).once === "function") {
      trackChild(result as ChildProcess, `${label} ${target}`);
    } else if (result && typeof (result as Promise<unknown>).then === "function") {
      // util.promisify(execFile) and friends.
      track(result as Promise<unknown>, `${label} ${target}`);
    }
    return result;
  };
}

let instrumentedChildProcess: typeof import("node:child_process") | null = null;
let instrumentedWorkerThreads: typeof import("node:worker_threads") | null = null;

/** `vi.mock("node:child_process")` factory body. See the module comment. */
export function instrumentChildProcess<T>(original: T): T {
  const real = original as Record<string, unknown>;
  const out: Record<string, unknown> = { ...real };
  for (const name of CHILD_PROCESS_FUNCTIONS) {
    const fn = real[name] as ((...args: unknown[]) => unknown) & { [promisify.custom]?: unknown };
    if (typeof fn !== "function") continue;
    const wrapped = countedSpawn(fn, `child_process.${name}`) as typeof fn;
    // promisify(execFile) resolves { stdout, stderr } only through the
    // original's custom form, which must count too.
    const custom = fn[promisify.custom];
    if (typeof custom === "function") {
      wrapped[promisify.custom] = countedSpawn(
        custom as (...args: unknown[]) => unknown,
        `child_process.${name}`,
      );
    }
    out[name] = wrapped;
  }
  out.default = out;
  instrumentedChildProcess = out as unknown as typeof import("node:child_process");
  return out as T;
}

/** `vi.mock("node:worker_threads")` factory body. See the module comment. */
export function instrumentWorkerThreads<T>(original: T): T {
  const real = original as Record<string, unknown> & { Worker: typeof import("node:worker_threads").Worker };
  const RealWorker = real.Worker;
  class CountedWorker extends RealWorker {
    constructor(...args: ConstructorParameters<typeof RealWorker>) {
      const target = String(args[0]);
      record("worker", 0, target);
      super(...args);
      // Workers emit "exit" after an "error" too.
      track(new Promise<void>((resolve) => this.once("exit", () => resolve())), `worker ${target}`);
    }
  }
  const out: Record<string, unknown> = { ...real, Worker: CountedWorker };
  out.default = out;
  instrumentedWorkerThreads = out as unknown as typeof import("node:worker_threads");
  return out as T;
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => realSetImmediate(resolve));
}

function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

const settleHooks = new Set<() => void>();

/**
 * Runs `hook` each time a measurement settles, once no fs work is in
 * flight: before its window opens and again before it closes. It is
 * for writes the app defers on a timer, such as main's buffered
 * crash.log lines. Flushed here, they land in the window that caused
 * them, not in whichever window is open when the timer fires. Returns
 * a function that removes the hook.
 */
export function onSettle(hook: () => void): () => void {
  settleHooks.add(hook);
  return () => settleHooks.delete(hook);
}

async function settle(): Promise<void> {
  const startedAt = realNow();
  while (true) {
    await nextMacrotask();
    if (inflight.size === 0) {
      // Only now, so lines logged as that work finished go out in
      // the same flush.
      for (const hook of settleHooks) hook();
      if (inflight.size === 0) return;
    }
    if (realNow() - startedAt > SETTLE_TIMEOUT_MS) {
      throw new Error(
        `measureFsIo waited ${SETTLE_TIMEOUT_MS} ms for fs work that is still running:\n  `
          + [...inflight.values()].join("\n  ")
          + "\nA stream that is never read or closed never finishes.",
      );
    }
    await Promise.race([Promise.allSettled([...inflight.keys()]), realDelay(50)]);
  }
}

/**
 * Waits, outside any measurement, for fs work still in flight, such as
 * a fire-and-forget save a test's setup started and now wants to read.
 */
export function settleFsIo(): Promise<void> {
  return settle();
}

/**
 * Writes one known file through each fs module and checks the counters
 * saw both. Runs once per test file, before its first measurement. The
 * probe's window counts only its own directory, and other windows are
 * hidden, so neither side sees the other's calls.
 */
export async function expectFsInstrumentationLive(): Promise<void> {
  if (instrumentationProven) return;
  const fs = instrumentedFs;
  const fsPromises = instrumentedFsPromises;
  if (!fs || !fsPromises) {
    throw new Error(
      `fs I/O counting is not live in this test file: ${fs ? "node:fs/promises" : "node:fs"} `
        + "was never instrumented.\nAdd the vi.mock(\"node:fs\") and vi.mock(\"node:fs/promises\") "
        + "lines from src/test/ioBudget.ts to the top of the test file, and import both "
        + "modules there so their factories run.",
    );
  }
  const dir = realFs.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-io-probe-"));
  const hidden = openWindows;
  const probe = emptyIo();
  openWindows = [{ io: probe, accepts: (target) => target.startsWith(dir) }];
  try {
    fs.writeFileSync(Path.join(dir, "sync.txt"), "1");
    await fsPromises.writeFile(Path.join(dir, "promises.txt"), "22");
  } finally {
    openWindows = hidden;
    realFs.rmSync(dir, { recursive: true, force: true });
  }
  if (probe.writeFile !== 2 || probe.bytesWritten !== 3) {
    throw new Error(
      "fs I/O counting is not live in this test file: two known writes "
        + `counted as ${probe.writeFile} (${probe.bytesWritten} bytes).\n`
        + "Add the vi.mock(\"node:fs\") and vi.mock(\"node:fs/promises\") lines "
        + "from src/test/ioBudget.ts to the top of the test file.",
    );
  }
  instrumentationProven = true;
}

let processInstrumentationProven = false;
const PROBE_COMMAND = "diskhound-io-probe-no-such-command";
const PROBE_WORKER_SOURCE = "/* diskhound-io-probe */ void 0";

/**
 * Spawns a command that does not exist and starts a one-line worker
 * through the modules the factories returned, and checks both counted.
 * Runs once per test file, before its first `countProcesses` window.
 */
export async function expectProcessInstrumentationLive(): Promise<void> {
  if (processInstrumentationProven) return;
  const childProcess = instrumentedChildProcess;
  const workerThreads = instrumentedWorkerThreads;
  if (!childProcess || !workerThreads) {
    throw new Error(
      `Process counting is not live in this test file: ${childProcess ? "node:worker_threads" : "node:child_process"} `
        + "was never instrumented.\nAdd the vi.mock(\"node:child_process\") and "
        + "vi.mock(\"node:worker_threads\") lines from src/test/ioBudget.ts to the top of "
        + "the test file, and import both modules there so their factories run.",
    );
  }
  const hidden = openWindows;
  const probe = emptyIo(true);
  openWindows = [{ io: probe, accepts: (target) => target === PROBE_COMMAND || target === PROBE_WORKER_SOURCE }];
  try {
    await new Promise<void>((resolve) => {
      const child = childProcess.spawn(PROBE_COMMAND, [], { stdio: "ignore" });
      child.once("error", () => resolve());
      child.once("exit", () => resolve());
    });
    await new Promise<void>((resolve) => {
      const worker = new workerThreads.Worker(PROBE_WORKER_SOURCE, { eval: true });
      worker.once("exit", () => resolve());
    });
  } finally {
    openWindows = hidden;
  }
  if (probe.spawn !== 1 || probe.worker !== 1) {
    throw new Error(
      `Process counting is not live in this test file: one spawn and one worker counted as ${probe.spawn} and ${probe.worker}.`,
    );
  }
  processInstrumentationProven = true;
}

export interface MeasureOptions {
  /** Also count child processes and worker threads. See the module comment. */
  countProcesses?: boolean;
}

/**
 * Runs `fn` and counts the fs calls it makes, including the ones its
 * fire-and-forget work makes before it settles. Setup is not counted:
 * fs work still in flight from before the call, such as a store's
 * startup save, finishes before the window opens.
 */
export async function measureFsIo<T>(
  fn: () => T | Promise<T>,
  options: MeasureOptions = {},
): Promise<{ result: T; io: FsIo }> {
  await expectFsInstrumentationLive();
  if (options.countProcesses) await expectProcessInstrumentationLive();
  // After the probes, so what the app logged while they ran flushes
  // before the window opens.
  await settle();
  const window: Window = { io: emptyIo(options.countProcesses) };
  openWindows = [...openWindows, window];
  try {
    const result = await fn();
    await settle();
    return { result, io: window.io };
  } finally {
    openWindows = openWindows.filter((open) => open !== window);
  }
}

const BUDGETS_PATH = Path.join(Path.dirname(fileURLToPath(import.meta.url)), "io-budgets.json");

type Budget = { note: string }
  & Record<IoCounter, number>
  & Partial<Record<ProcessCounter, number>>
  & { observedBytesWritten: number };
type BudgetFile = Record<string, Budget>;

/**
 * Asserts a measurement against its checked-in budget. With
 * `UPDATE_IO_BUDGETS=1` it records the measurement instead.
 */
export function expectIoBudget(params: { scenario: string; note: string; io: FsIo }): void {
  const measured = toBudget(params.note, params.io);

  if (process.env.UPDATE_IO_BUDGETS) {
    withBudgetsLock(() => {
      const budgets = readBudgets();
      budgets[params.scenario] = measured;
      realFs.writeFileSync(BUDGETS_PATH, `${JSON.stringify(sortScenarios(budgets), null, 2)}\n`);
    });
    return;
  }

  const budget = readBudgets()[params.scenario];
  if (!budget) {
    throw new Error(
      `No I/O budget recorded for "${params.scenario}".\n`
        + `Measured ${describeBudget(measured)}.\n`
        + "Record it with UPDATE_IO_BUDGETS=1 bun run test <file> and commit the result.",
    );
  }

  expect(
    counts(measured),
    `I/O budget "${params.scenario}" changed.\n`
      + `  budget:   ${describeBudget(budget)}\n`
      + `  measured: ${describeBudget(measured)}\n`
      + "If this is intended, re-record with UPDATE_IO_BUDGETS=1 and explain\n"
      + "the change in the commit message. If it is not, you have added disk\n"
      + "I/O to a path that is measured for a reason.",
  ).toEqual(counts(budget));
}

function toBudget(note: string, io: FsIo): Budget {
  const budget = { note } as Budget;
  for (const counter of IO_COUNTERS) budget[counter] = io[counter];
  for (const counter of IO_PROCESS_COUNTERS) {
    if (io[counter] !== undefined) budget[counter] = io[counter];
  }
  budget.observedBytesWritten = io.bytesWritten;
  return budget;
}

/** Process counts appear only when counted, so either side lacking them is a mismatch. */
function counts(budget: Budget): Partial<Record<IoCounter | ProcessCounter, number>> {
  const out: Partial<Record<IoCounter | ProcessCounter, number>> = {};
  for (const counter of IO_COUNTERS) out[counter] = budget[counter] ?? 0;
  for (const counter of IO_PROCESS_COUNTERS) {
    if (budget[counter] !== undefined) out[counter] = budget[counter];
  }
  return out;
}

/** "1 writeFile, 1 mkdir; reads: 2 readFile; processes: 1 spawn (~12.3 KB written)" */
export function describeBudget(budget: Budget): string {
  const list = (names: readonly (IoCounter | ProcessCounter)[]) =>
    names.filter((name) => budget[name]).map((name) => `${budget[name]} ${name}`).join(", ");
  const writes = list(IO_WRITE_COUNTERS) || "no writes";
  const reads = list(IO_READ_COUNTERS);
  const counted = IO_PROCESS_COUNTERS.some((name) => budget[name] !== undefined);
  const processes = counted ? list(IO_PROCESS_COUNTERS) || "no processes" : "";
  const kb = (budget.observedBytesWritten / 1024).toFixed(1);
  return `${writes}${reads ? `; reads: ${reads}` : ""}${processes ? `; ${processes}` : ""} (~${kb} KB written)`;
}

/** Each test file runs in its own worker, and each re-record rewrites the whole file. */
function withBudgetsLock(update: () => void): void {
  const lockPath = `${BUDGETS_PATH}.lock`;
  const startedAt = realNow();
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      realFs.closeSync(realFs.openSync(lockPath, "wx"));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (realNow() - startedAt > 10_000) {
        throw new Error(`${lockPath} has been held for 10 s. If no test run is recording, delete it.`);
      }
      Atomics.wait(pause, 0, 0, 5);
    }
  }
  try {
    update();
  } finally {
    realFs.rmSync(lockPath, { force: true });
  }
}

function readBudgets(): BudgetFile {
  let text: string;
  try {
    text = realFs.readFileSync(BUDGETS_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  // A parse error throws: re-recording over it would keep only the
  // scenarios that ran and drop every other budget.
  return JSON.parse(text) as BudgetFile;
}

function sortScenarios(budgets: BudgetFile): BudgetFile {
  return Object.fromEntries(
    Object.entries(budgets).sort(([left], [right]) => left.localeCompare(right)),
  );
}
