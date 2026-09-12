import { Worker } from "node:worker_threads";

import { resolveBundledWorkerScript } from "./bundledWorkerPath";
import type { PermanentDeleteProgress } from "./contracts";
import type {
  PermanentDeleteWorkerRequest,
  PermanentDeleteWorkerResponse,
} from "./permanentDeleteWorkerProtocol";

export function resolveBundledPermanentDeleteWorkerPath(baseDir: string): string {
  return resolveBundledWorkerScript(baseDir, "permanentDeleteWorker.cjs");
}

export interface RunPermanentDeleteWorkerOptions {
  workerPath: string;
  onProgress?: (progress: PermanentDeleteProgress) => void;
}

export async function runPermanentDeleteWorker(
  targetPath: string,
  options: RunPermanentDeleteWorkerOptions,
): Promise<void> {
  const worker = new Worker(options.workerPath);
  const request: PermanentDeleteWorkerRequest = {
    type: "delete",
    requestId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    targetPath,
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      void worker.terminate().finally(() => callback());
    };

    const onMessage = (message: PermanentDeleteWorkerResponse) => {
      if (!message || message.requestId !== request.requestId) return;
      if (message.type === "progress") {
        options.onProgress?.(message.progress);
        return;
      }
      if (message.type === "result") {
        settle(() => resolve());
        return;
      }
      settle(() => reject(new Error(message.message)));
    };

    const onError = (error: Error) => {
      settle(() => reject(error));
    };

    const onExit = (code: number) => {
      if (!settled && code !== 0) {
        settle(() => reject(new Error(`Permanent delete worker exited with code ${code}`)));
      }
    };

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    worker.postMessage(request);
  });
}
