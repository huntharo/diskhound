/**
 * Periodic main-process memory lines in crash.log, for "why is DiskHound
 * holding 800 MB?" and for the peak before an out-of-memory crash.
 *
 * Memory is sampled every minute while a scan runs and every 5 minutes
 * otherwise. A sample is logged only when it moved since the last
 * logged one: RSS or V8 heap by `MEMORY_DIAG_MIN_MOVE_RATIO` (at least
 * `MEMORY_DIAG_MIN_MOVE_BYTES`), or a cache changed size. An hourly
 * heartbeat is logged either way, so a flat stretch still shows the
 * app was up. Logging every sample cost 288 lines a day in the tray
 * with nothing changing.
 */

export const MEMORY_DIAG_SCANNING_MS = 60_000;
export const MEMORY_DIAG_IDLE_MS = 5 * 60_000;
export const MEMORY_DIAG_HEARTBEAT_MS = 60 * 60_000;
export const MEMORY_DIAG_MIN_MOVE_BYTES = 32 * 1024 * 1024;
export const MEMORY_DIAG_MIN_MOVE_RATIO = 0.1;

export interface MemorySample {
  rssBytes: number;
  heapUsedBytes: number;
  /** Cache sizes, compared as a whole: any change is logged. */
  caches: string;
  /** The line to log. */
  text: string;
}

export interface MemoryDiagnosticsOptions {
  sample: () => MemorySample;
  isScanning: () => boolean;
  write: (tag: string, message: string) => void;
  now?: () => number;
}

export interface MemoryDiagnostics {
  /** Logs the boot line and starts the idle cadence. */
  start(): void;
  /** Switches cadence when a scan starts or the last one ends. */
  retune(): void;
  stop(): void;
}

function moved(last: number, next: number): boolean {
  return Math.abs(next - last) >= Math.max(MEMORY_DIAG_MIN_MOVE_BYTES, last * MEMORY_DIAG_MIN_MOVE_RATIO);
}

export function memorySampleChanged(last: MemorySample, next: MemorySample): boolean {
  return moved(last.rssBytes, next.rssBytes)
    || moved(last.heapUsedBytes, next.heapUsedBytes)
    || last.caches !== next.caches;
}

export function createMemoryDiagnostics(options: MemoryDiagnosticsOptions): MemoryDiagnostics {
  const now = options.now ?? (() => Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;
  let cadence: "scanning" | "idle" = "idle";
  let last: { sample: MemorySample; at: number } | null = null;

  const log = (tag: string, sample: MemorySample, prefix = "") => {
    options.write(tag, `${prefix}${sample.text}`);
    last = { sample, at: now() };
  };

  const tick = () => {
    const sample = options.sample();
    const due = !last
      || now() - last.at >= MEMORY_DIAG_HEARTBEAT_MS
      || memorySampleChanged(last.sample, sample);
    if (due) log(options.isScanning() ? "memory-scanning" : "memory", sample);
  };

  const run = (next: "scanning" | "idle") => {
    if (timer) clearInterval(timer);
    timer = setInterval(tick, next === "scanning" ? MEMORY_DIAG_SCANNING_MS : MEMORY_DIAG_IDLE_MS);
    timer.unref?.();
    cadence = next;
  };

  return {
    start() {
      run("idle");
      log("memory", options.sample(), "boot: ");
    },
    retune() {
      const desired = options.isScanning() ? "scanning" : "idle";
      if (desired !== cadence) run(desired);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
