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
  expectedFiles?: number;
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
    expectedFiles: options.expectedFiles,
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let progressFailed = false;
    let progressError: unknown;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      void worker.terminate().then(callback, reject);
    };

    const onMessage = (message: PermanentDeleteWorkerResponse) => {
      if (!message || message.requestId !== request.requestId) return;
      if (message.type === "progress") {
        if (!progressFailed) {
          try { options.onProgress?.(message.progress); } catch (error) {
            // A UI listener must not escape the event emitter or terminate
            // active filesystem work. Let the worker finish, then reject.
            progressFailed = true;
            progressError = error;
          }
        }
        return;
      }
      if (message.type === "result") {
        settle(() => progressFailed ? reject(progressError) : resolve());
        return;
      }
      settle(() => reject(Object.assign(new Error(message.message), { code: message.code })));
    };

    const onError = (error: Error) => {
      settle(() => reject(error));
    };

    const onExit = (code: number) => {
      if (!settled) {
        settle(() => reject(new Error(`Permanent delete worker exited with code ${code} before reporting a result`)));
      }
    };

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    worker.postMessage(request);
  });
}
