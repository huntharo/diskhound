import { once } from "node:events";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import { liveWorkerCount, readWorkerHeaps, trackWorker } from "../workerHeapRegistry";

const hasWorkerHeapStats = typeof (Worker.prototype as { getHeapStatistics?: unknown }).getHeapStatistics === "function";

/** A worker that holds ~`mb` MB of strings until told to exit. */
function spawnHolder(mb: number): Worker {
  return new Worker(
    `
      const { parentPort } = require("node:worker_threads");
      const held = [];
      // 64 KB of doubles each, on the worker's own heap.
      for (let i = 0; i < ${mb} * 16; i += 1) held.push(new Array(8192).fill(i + 0.5));
      parentPort.postMessage("ready");
      parentPort.on("message", () => process.exit(0));
    `,
    { eval: true },
  );
}

describe("workerHeapRegistry", () => {
  it.skipIf(!hasWorkerHeapStats)("reads each live worker's own heap and forgets it on exit", async () => {
    const before = liveWorkerCount();
    const worker = trackWorker(spawnHolder(64), "holder");
    await once(worker, "message");
    expect(liveWorkerCount()).toBe(before + 1);

    const readings = await readWorkerHeaps(5_000);
    const reading = readings.find((entry) => entry.threadId === worker.threadId);
    expect(reading).toMatchObject({ label: "holder" });
    expect(reading!.error).toBeUndefined();
    // Its heap, not main's: it holds ~64 MB of strings.
    expect(reading!.usedBytes!).toBeGreaterThan(48 * 1024 * 1024);
    expect(reading!.limitBytes!).toBeGreaterThan(reading!.usedBytes!);

    worker.postMessage("exit");
    await once(worker, "exit");
    expect(liveWorkerCount()).toBe(before);
  });

  it("reports a worker that doesn't answer in time as unknown, not as zero", async () => {
    const worker = trackWorker(spawnHolder(1), "stuck");
    await once(worker, "message");
    // Under Electron's Node, a worker blocked in native code (spawnSync,
    // say) answers only once the call returns.
    (worker as unknown as { getHeapStatistics: () => Promise<never> }).getHeapStatistics = () => new Promise<never>(() => {});
    try {
      const reading = (await readWorkerHeaps(50)).find((entry) => entry.threadId === worker.threadId);
      expect(reading).toMatchObject({ label: "stuck", usedBytes: null, limitBytes: null, error: "no answer in 50 ms" });
    } finally {
      await worker.terminate();
    }
  });
});
