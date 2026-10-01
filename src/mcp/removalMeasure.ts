import { spawn } from "node:child_process";
import * as Path from "node:path";
import * as Readline from "node:readline";

/**
 * What removing a set of paths together would free, measured on disk by
 * the native scanner's `--mode=measure-removal` (see
 * native/diskhound-native-scanner/src/measure.rs). It counts APFS clone
 * groups and hardlinked files once, and frees their blocks only when
 * every clone or name is in the set.
 */
export interface RemovalPathTotals {
  path: string;
  kind: "folder" | "file";
  files: number;
  sizeBytes: number;
  freesAloneBytes: number;
  sharedBytes: number;
  uncertainBytes: number;
}

export interface RemovalMeasurement {
  paths: RemovalPathTotals[];
  total: {
    files: number;
    sizeBytes: number;
    freesBytes: number;
    heldElsewhereBytes: number;
    uncertainBytes: number;
  };
  missing: string[];
  nested: { path: string; within: string }[];
  skippedEntries: number;
  /** False off APFS, where no clone data exists. */
  cloneMetadata: boolean;
  elapsedMs: number;
  /** When the walk finished (epoch ms). */
  measuredAt: number;
}

export type RemovalMeasurer = (paths: readonly string[], signal: AbortSignal) => Promise<RemovalMeasurement>;

/** Runs the scanner binary in measure mode; it reads metadata only. */
export function nativeRemovalMeasurer(
  binary: string,
  workers: () => number | undefined = () => undefined,
  now: () => number = Date.now,
): RemovalMeasurer {
  return (paths, signal) =>
    new Promise((resolve, reject) => {
      const args = ["--mode=measure-removal", ...paths.flatMap((path) => ["--path", path])];
      const count = workers();
      if (count) args.push("--workers", String(count));
      const child = spawn(binary, args, { cwd: Path.dirname(binary), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let result: RemovalMeasurement | null = null;
      let failure: string | null = null;
      let stderr = "";
      const abort = () => child.kill("SIGTERM");
      signal.addEventListener("abort", abort, { once: true });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-2_000);
      });
      Readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
        if (!line.startsWith("{")) return;
        try {
          const message = JSON.parse(line) as { type?: string; message?: string };
          if (message.type === "removal-measurement") result = { ...(message as unknown as RemovalMeasurement), measuredAt: now() };
          else if (message.type === "error") failure = message.message ?? "unknown error";
        } catch {
          // A partial line from a killed process.
        }
      });
      child.on("error", (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      });
      child.on("close", (code) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(new Error("The measurement was cancelled."));
        else if (result && code === 0) resolve(result);
        else reject(new Error(`DiskHound couldn't measure those paths: ${failure ?? (stderr.trim().split("\n").at(-1) || `scanner exited with ${code}`)}`));
      });
    });
}

interface Job {
  promise: Promise<RemovalMeasurement>;
  controller: AbortController;
  /** Set once the job succeeds. */
  doneAt: number | null;
}

/**
 * The measurements agents ask for. A big set (millions of files) can
 * outlast a client's tool timeout, so a measurement keeps going when the
 * caller gives up, and the same set asked again within `ttlMs` gets that
 * result instead of another walk. One walk runs at a time.
 */
export class RemovalMeasurements {
  private readonly jobs = new Map<string, Job>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly run: RemovalMeasurer,
    private readonly options: { ttlMs?: number; maxKept?: number; now?: () => number } = {},
  ) {}

  private get now() {
    return this.options.now ?? Date.now;
  }

  async measure(paths: readonly string[], signal?: AbortSignal): Promise<RemovalMeasurement> {
    const unique = [...new Set(paths)].sort();
    const key = unique.join("\0");
    this.expire();
    let job = this.jobs.get(key);
    if (!job) {
      const controller = new AbortController();
      const promise = this.tail.then(() => this.run(unique, controller.signal));
      job = { promise, controller, doneAt: null };
      const started = job;
      this.jobs.set(key, started);
      this.tail = promise.catch(() => undefined);
      promise.then(
        () => {
          started.doneAt = this.now();
        },
        () => {
          if (this.jobs.get(key) === started) this.jobs.delete(key);
        },
      );
    }
    if (!signal) return job.promise;
    if (signal.aborted) throw new Error("The agent stopped waiting.");
    return new Promise<RemovalMeasurement>((resolve, reject) => {
      const stop = () => reject(new Error("The agent stopped waiting."));
      signal.addEventListener("abort", stop, { once: true });
      job.promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });
  }

  /** Files changed (a removal went through): measure afresh next time. */
  invalidate(): void {
    for (const [key, job] of this.jobs) {
      if (job.doneAt !== null) this.jobs.delete(key);
    }
  }

  dispose(): void {
    for (const job of this.jobs.values()) job.controller.abort();
    this.jobs.clear();
  }

  private expire(): void {
    const ttl = this.options.ttlMs ?? 5 * 60_000;
    const done = [...this.jobs].filter(([, job]) => job.doneAt !== null);
    const cutoff = this.now() - ttl;
    for (const [key, job] of done) {
      if (job.doneAt! < cutoff) this.jobs.delete(key);
    }
    const keep = this.options.maxKept ?? 8;
    const fresh = done.filter(([, job]) => job.doneAt! >= cutoff).sort((a, b) => a[1].doneAt! - b[1].doneAt!);
    for (const [key] of fresh.slice(0, Math.max(0, fresh.length - keep))) this.jobs.delete(key);
  }
}
