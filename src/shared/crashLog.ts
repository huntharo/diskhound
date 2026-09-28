import * as FS from "node:fs";
import * as Path from "node:path";

/**
 * crash.log under Electron's userData: startup breadcrumbs, main-process
 * exceptions, renderer errors forwarded over IPC, native-scanner stderr,
 * and memory diagnostics. Settings has a "View crash logs" button so
 * users can send the file when asking for help.
 *
 * ## Write cost
 *
 * DiskHound runs for days in the tray, and every line used to cost a
 * sync mkdir, a sync append (open, write, close) and a stat for
 * rotation. Now:
 *
 * - Crash-class tags (`CRASH_LOG_SYNC_TAGS`) still append before
 *   `write` returns, so the breadcrumb is on disk before a dialog
 *   blocks the main thread or the process dies. Anything buffered goes
 *   out in the same append, ahead of it.
 * - Everything else is buffered and appended in one call
 *   `CRASH_LOG_FLUSH_DELAY_MS` after the first buffered line, or at once
 *   when the buffer passes `CRASH_LOG_MAX_BUFFERED_BYTES`. main.ts
 *   flushes at quit and before it reads the file for the viewer. A
 *   native crash loses at most the last flush delay of buffered lines.
 * - For `CRASH_LOG_REPEAT_TAGS`, a line identical to one already logged
 *   is counted instead of written, and the count is logged as one
 *   summary line per window. Windows start at a minute and double up
 *   to an hour, so a handler that rejects on every 2 s poll costs a
 *   handful of lines a day instead of 43,200.
 * - The directory is created only when an append fails with ENOENT,
 *   and the file is stat'ed once, then its size is tracked in memory.
 *
 * ## Rotation
 *
 * Once the tracked size passes `CRASH_LOG_MAX_BYTES`, the file is
 * stat'ed to confirm (another DiskHound process or the user may have
 * changed it) and renamed over crash.log.old. One archived copy is
 * kept, so the pair never grows past ~2 MiB.
 */

export const CRASH_LOG_FILENAME = "crash.log";
export const CRASH_LOG_MAX_BYTES = 1024 * 1024;
export const CRASH_LOG_FLUSH_DELAY_MS = 2_000;
export const CRASH_LOG_MAX_BUFFERED_BYTES = 64 * 1024;

/** Written before `write` returns. See the module comment. */
export const CRASH_LOG_SYNC_TAGS: ReadonlySet<string> = new Set([
  "main-uncaught",
  "main-rejection",
  "startup",
]);

/** Tags whose identical lines are counted instead of rewritten. */
export const CRASH_LOG_REPEAT_TAGS: ReadonlySet<string> = new Set([
  "renderer",
  "main-uncaught",
  "main-rejection",
  "dev-artifacts",
]);

const REPEAT_FIRST_WINDOW_MS = 60_000;
const REPEAT_MAX_WINDOW_MS = 60 * 60_000;
/** A line not seen for this long is logged in full again. */
const REPEAT_FORGET_MS = 60 * 60_000;
const REPEAT_MAX_TRACKED = 64;
const REPEAT_HEADLINE_CHARS = 200;

export type CrashLogFs = Pick<typeof FS, "appendFileSync" | "mkdirSync" | "renameSync" | "statSync">;

export interface CrashLogOptions {
  /** Resolved at each flush. */
  path: () => string;
  /** Clock for timestamps and repeat windows. Defaults to `Date.now`. */
  now?: () => number;
  /** How long a buffered line waits before the append. Defaults to `CRASH_LOG_FLUSH_DELAY_MS`. */
  flushDelayMs?: number;
  fs?: CrashLogFs;
  syncTags?: ReadonlySet<string>;
  repeatTags?: ReadonlySet<string>;
}

export interface CrashLog {
  /**
   * Adds a timestamped `[tag]` line. `sync` overrides the tag's default,
   * for a crash-class tag whose event this time is routine.
   */
  write(tag: string, message: string, options?: { sync?: boolean }): void;
  /** Appends the buffered lines now. */
  flush(): void;
  /** Also logs the counts of repeats not yet summarized. For quit and the viewer. */
  flushAll(): void;
  path(): string;
  archivePath(): string;
}

interface Repeat {
  tag: string;
  message: string;
  /** Repeats since the last summary. */
  count: number;
  /** When the first of those repeats arrived. */
  countingSince: number;
  lastSeenAt: number;
  windowMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createCrashLog(options: CrashLogOptions): CrashLog {
  const fs = options.fs ?? FS;
  const now = options.now ?? (() => Date.now());
  const syncTags = options.syncTags ?? CRASH_LOG_SYNC_TAGS;
  const repeatTags = options.repeatTags ?? CRASH_LOG_REPEAT_TAGS;
  const flushDelayMs = options.flushDelayMs ?? CRASH_LOG_FLUSH_DELAY_MS;
  const archivePath = () => `${options.path()}.old`;

  let pending: string[] = [];
  let pendingBytes = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bytes in the file, or null before the first flush stats it. */
  let knownSize: number | null = null;
  const repeats = new Map<string, Repeat>();

  const fileSize = (): number => {
    try {
      return fs.statSync(options.path()).size;
    } catch {
      return 0;
    }
  };

  const append = (data: string): void => {
    const logPath = options.path();
    try {
      fs.appendFileSync(logPath, data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(Path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, data);
    }
  };

  const flush = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pending.length === 0) return;
    const data = pending.join("");
    const bytes = pendingBytes;
    pending = [];
    pendingBytes = 0;
    try {
      knownSize ??= fileSize();
      append(data);
      knownSize += bytes;
      if (knownSize > CRASH_LOG_MAX_BYTES) {
        const actual = fileSize();
        // Counted as empty whether or not the rename works: a file held
        // open elsewhere is retried after another CRASH_LOG_MAX_BYTES,
        // not with a stat and a rename on every flush.
        knownSize = 0;
        if (actual > CRASH_LOG_MAX_BYTES) fs.renameSync(options.path(), archivePath());
        else knownSize = actual;
      }
    } catch {
      // Best effort: disk full, read-only userData. The lines are dropped
      // rather than held, so a broken disk can't grow the buffer forever.
    }
  };

  const enqueue = (tag: string, message: string, sync: boolean): void => {
    const line = `[${new Date(now()).toISOString()}] [${tag}] ${message}\n`;
    pending.push(line);
    pendingBytes += Buffer.byteLength(line);
    if (sync || pendingBytes >= CRASH_LOG_MAX_BUFFERED_BYTES) {
      flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flush, flushDelayMs);
      flushTimer.unref?.();
    }
  };

  const summarize = (repeat: Repeat): void => {
    if (repeat.timer) {
      clearTimeout(repeat.timer);
      repeat.timer = null;
    }
    if (repeat.count === 0) return;
    const headline = repeat.message.split("\n", 1)[0].slice(0, REPEAT_HEADLINE_CHARS);
    const times = repeat.count === 1 ? "1 more time" : `${repeat.count} more times`;
    const span = describeSpan(now() - repeat.countingSince);
    enqueue(repeat.tag, `repeated ${times} in the last ${span}: ${headline}`, false);
    repeat.count = 0;
  };

  /** True when the line is a repeat and was counted instead of logged. */
  const countRepeat = (tag: string, message: string): boolean => {
    const key = `${tag}\u0000${message}`;
    const at = now();
    const seen = repeats.get(key);
    if (seen && at - seen.lastSeenAt < REPEAT_FORGET_MS) {
      if (seen.count === 0) seen.countingSince = at;
      seen.count += 1;
      seen.lastSeenAt = at;
      if (!seen.timer) {
        seen.timer = setTimeout(() => {
          summarize(seen);
          seen.windowMs = Math.min(seen.windowMs * 2, REPEAT_MAX_WINDOW_MS);
        }, seen.windowMs);
        seen.timer.unref?.();
      }
      return true;
    }
    if (seen) {
      summarize(seen);
      repeats.delete(key);
    }
    if (repeats.size >= REPEAT_MAX_TRACKED) {
      const [oldestKey, oldest] = repeats.entries().next().value as [string, Repeat];
      summarize(oldest);
      repeats.delete(oldestKey);
    }
    repeats.set(key, {
      tag,
      message,
      count: 0,
      countingSince: at,
      lastSeenAt: at,
      windowMs: REPEAT_FIRST_WINDOW_MS,
      timer: null,
    });
    return false;
  };

  return {
    write(tag, message, writeOptions) {
      if (repeatTags.has(tag) && countRepeat(tag, message)) return;
      enqueue(tag, message, writeOptions?.sync ?? syncTags.has(tag));
    },
    flush,
    flushAll() {
      for (const repeat of repeats.values()) summarize(repeat);
      flush();
    },
    path: options.path,
    archivePath,
  };
}

function describeSpan(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

/** The crash.log message for an error the renderer forwarded. */
export function formatRendererError(payload: { message: string; stack?: string; source?: string }): string {
  const loc = payload.source ? ` @ ${payload.source}` : "";
  return `${payload.message}${loc}\n${payload.stack ?? ""}`;
}
