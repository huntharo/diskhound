import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Crash-safe writes for DiskHound's JSON state files.
 *
 * A write goes to a temp file next to the target, is flushed to disk,
 * and is then renamed over the target. A crash or power cut mid-write
 * leaves the old file or the new one, never a truncated one that the
 * store would read back as corrupt and replace with defaults.
 *
 * ## Overlapping saves
 *
 * Async writes to one path run one at a time, so two saves can no
 * longer interleave their bytes in the same file. A save requested
 * while another runs waits, and of the saves waiting only the newest
 * is written: it holds the latest state, and each caller's promise
 * resolves once its text or a newer one is on disk.
 *
 * The sync form is for quit paths that cannot await. It writes through
 * its own temp file and supersedes the queue: a waiting save is
 * dropped, and a running one skips its rename unless it has already
 * started it. A rename already under way can still land after the sync
 * write, which leaves an older complete file, never a partial one.
 *
 * ## Windows
 *
 * Antivirus or the search indexer can hold the target open without
 * delete sharing for a moment, and the rename fails with EPERM, EACCES
 * or EBUSY. The rename is retried with backoff. If the file is still
 * held, the text is written over the target in place, which such a
 * handle may still allow. That write is not atomic, but it is how
 * every save was written before, and the save is not lost.
 *
 * ## Cost
 *
 * One writeFile and one rename per write, plus a mkdir of the parent
 * directory for the async form. Temp names are fixed, so a temp file
 * a crash leaves behind is overwritten by the next save rather than
 * piling up.
 */

/** Waits between rename attempts on Windows, about 1 s in all. */
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 150, 300, 400];
/** The sync form blocks the main thread, so it waits about 150 ms at most. */
const RENAME_RETRY_DELAYS_SYNC_MS = [10, 20, 40, 80];

/** Flush the temp file before the rename, so a power cut cannot leave the rename pointing at unwritten data. */
const WRITE_OPTIONS = { encoding: "utf8", flush: true } as const;

interface WaitingSave {
  text: string;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface FileQueue {
  /** The newest save requested while one was running. */
  waiting: WaitingSave | null;
  /** Bumped by each sync write. A running save started under an older value skips its rename. */
  syncWrites: number;
  /** Resolves when the running save and any waiting one have finished. */
  drained: Promise<void>;
  markDrained: () => void;
}

/** One entry per path with a save running. */
const queues = new Map<string, FileQueue>();

/**
 * Writes `text` to `filePath` atomically, after any save to the same
 * path that is already running. Creates the parent directory.
 */
export function writeFileAtomic(filePath: string, text: string): Promise<void> {
  const key = Path.resolve(filePath);
  const queue = queues.get(key);
  if (!queue) {
    let markDrained = () => {};
    const drained = new Promise<void>((resolve) => { markDrained = resolve; });
    const started: FileQueue = { waiting: null, syncWrites: 0, drained, markDrained };
    queues.set(key, started);
    return run(key, started, text);
  }
  if (queue.waiting) {
    queue.waiting.text = text;
    return queue.waiting.promise;
  }
  let resolve = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  queue.waiting = { text, promise, resolve, reject };
  return promise;
}

function run(key: string, queue: FileQueue, text: string): Promise<void> {
  const syncWrites = queue.syncWrites;
  const save = writeViaTemp(key, text, () => queue.syncWrites !== syncWrites);
  const next = () => {
    const waiting = queue.waiting;
    queue.waiting = null;
    if (waiting) {
      run(key, queue, waiting.text).then(waiting.resolve, waiting.reject);
    } else {
      queues.delete(key);
      queue.markDrained();
    }
  };
  save.then(next, next);
  return save;
}

/**
 * Writes `text` to `filePath` atomically and synchronously, for quit
 * paths. Supersedes async saves to the same path; see the module
 * comment. The caller creates the parent directory.
 */
export function writeFileAtomicSync(filePath: string, text: string): void {
  const key = Path.resolve(filePath);
  writeViaTempSync(key, text);
  const queue = queues.get(key);
  if (!queue) return;
  queue.syncWrites += 1;
  const waiting = queue.waiting;
  queue.waiting = null;
  waiting?.resolve();
}

/** True while an async save to `filePath` is running or waiting. */
export function hasPendingAtomicWrite(filePath: string): boolean {
  return queues.has(Path.resolve(filePath));
}

/** Resolves once the async saves to `filePath` that are running or waiting now have finished. */
export function atomicWritesSettled(filePath: string): Promise<void> {
  return queues.get(Path.resolve(filePath))?.drained ?? Promise.resolve();
}

async function writeViaTemp(filePath: string, text: string, superseded: () => boolean): Promise<void> {
  const temp = `${filePath}.tmp`;
  await FSP.mkdir(Path.dirname(filePath), { recursive: true });
  try {
    await FSP.writeFile(temp, text, WRITE_OPTIONS);
    if (await renameOver(temp, filePath, superseded)) return;
    if (!superseded()) await FSP.writeFile(filePath, text, WRITE_OPTIONS);
  } catch (error) {
    await FSP.unlink(temp).catch(() => undefined);
    throw error;
  }
  await FSP.unlink(temp).catch(() => undefined);
}

/** False when a sync write superseded this save, or the target stayed held open. */
async function renameOver(temp: string, target: string, superseded: () => boolean): Promise<boolean> {
  for (let attempt = 0; !superseded(); attempt++) {
    try {
      await FSP.rename(temp, target);
      return true;
    } catch (error) {
      if (!isHeldOpenOnWindows(error)) throw error;
      if (attempt === RENAME_RETRY_DELAYS_MS.length) return false;
    }
    await sleep(RENAME_RETRY_DELAYS_MS[attempt]);
  }
  return false;
}

function writeViaTempSync(filePath: string, text: string): void {
  // Not the async temp name: a save may be writing that one right now.
  const temp = `${filePath}.sync.tmp`;
  try {
    FS.writeFileSync(temp, text, WRITE_OPTIONS);
    if (renameOverSync(temp, filePath)) return;
    FS.writeFileSync(filePath, text, WRITE_OPTIONS);
  } catch (error) {
    removeSync(temp);
    throw error;
  }
  removeSync(temp);
}

/** False when the target stayed held open. */
function renameOverSync(temp: string, target: string): boolean {
  for (let attempt = 0; ; attempt++) {
    try {
      FS.renameSync(temp, target);
      return true;
    } catch (error) {
      if (!isHeldOpenOnWindows(error)) throw error;
      if (attempt === RENAME_RETRY_DELAYS_SYNC_MS.length) return false;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_DELAYS_SYNC_MS[attempt]);
  }
}

function removeSync(path: string): void {
  try {
    FS.unlinkSync(path);
  } catch {
    // Already gone, or held open too; the next save overwrites it.
  }
}

function isHeldOpenOnWindows(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}
