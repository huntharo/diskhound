import type { Worker } from "node:worker_threads";

/**
 * Live worker_threads, so main-process diagnostics can read their heaps.
 *
 * Electron builds V8 with pointer compression, and the main isolate and
 * every worker share one 4 GB cage. A worker filling it aborts the whole
 * app, and a main-process heap snapshot needs room in that same cage, so
 * the heap gate counts worker heaps before it takes one. Main's own
 * inspector session can't see into a worker; `worker.getHeapStatistics()`
 * (Node 22.16+/24) asks the worker's isolate directly.
 */
const live = new Map<Worker, string>();

/** Register a worker until it exits. Returns it for chaining. */
export function trackWorker<T extends Worker>(worker: T, label: string): T {
  live.set(worker, label);
  worker.once("exit", () => {
    live.delete(worker);
  });
  return worker;
}

export function liveWorkerCount(): number {
  return live.size;
}

export interface WorkerHeapReading {
  label: string;
  threadId: number;
  /** Null when the worker didn't answer in time or the API is missing. */
  usedBytes: number | null;
  limitBytes: number | null;
  error?: string;
}

type HeapStatsWorker = Worker & {
  getHeapStatistics?: () => Promise<{ used_heap_size: number; heap_size_limit: number }>;
};

/**
 * One reading per live worker. The request interrupts the worker's JS,
 * so a busy loop still answers; a worker blocked in a native call
 * doesn't until it returns, hence the timeout.
 */
export async function readWorkerHeaps(timeoutMs = 1_000): Promise<WorkerHeapReading[]> {
  return Promise.all(
    [...live].map(async ([worker, label]): Promise<WorkerHeapReading> => {
      const base = { label, threadId: worker.threadId };
      const read = (worker as HeapStatsWorker).getHeapStatistics;
      if (typeof read !== "function") {
        return { ...base, usedBytes: null, limitBytes: null, error: "worker.getHeapStatistics is unavailable" };
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const stats = await Promise.race([
          read.call(worker),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs);
            timer.unref?.();
          }),
        ]);
        return { ...base, usedBytes: stats.used_heap_size, limitBytes: stats.heap_size_limit };
      } catch (error) {
        return {
          ...base,
          usedBytes: null,
          limitBytes: null,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
}
