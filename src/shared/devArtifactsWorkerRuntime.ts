import { Worker } from "node:worker_threads";

import { resolveBundledWorkerScript } from "./bundledWorkerPath";
import { trackWorker } from "./workerHeapRegistry";

import type { DevArtifactReport } from "./contracts";
import type { DevArtifactsRescanProgress } from "./devArtifactSidecar";
import type {
  DevArtifactsClassifyInput,
  DevArtifactsRescanInput,
  DevArtifactsWorkerRequest,
  DevArtifactsWorkerResponse,
} from "./devArtifactsWorkerProtocol";

export function resolveBundledDevArtifactsWorkerPath(baseDir: string): string {
  return resolveBundledWorkerScript(baseDir, "devArtifactsWorker.cjs");
}

/**
 * Electron builds V8 with pointer compression, so the main isolate and
 * every worker_thread share one 4 GB heap cage. A bigger resourceLimit is
 * silently capped at 4 GB, and a worker that fills the cage aborts the
 * whole app ("young object promotion failed", exit 134), not just itself.
 * A worker that reaches its own, lower limit fails with
 * ERR_WORKER_OUT_OF_MEMORY instead, which main survives. Neither job
 * needs much: classify streams the folder tree and holds only artifact
 * roots and projects; rescan holds DEV_SIDECAR_ROOT_CAP roots and one
 * walk's folder stack.
 */
const DEV_ARTIFACTS_WORKER_HEAP_MB = 1024;
const DEV_ARTIFACTS_WORKER_YOUNG_HEAP_MB = 64;

export interface RunDevArtifactsWorkerOptions {
  workerPath: string;
  signal?: AbortSignal;
  onProgress?: (progress: DevArtifactsRescanProgress) => void;
}

function runDevArtifactsRequest(
  request: DevArtifactsWorkerRequest,
  options: RunDevArtifactsWorkerOptions,
): Promise<DevArtifactReport> {
  const worker = new Worker(options.workerPath, {
    resourceLimits: {
      maxOldGenerationSizeMb: DEV_ARTIFACTS_WORKER_HEAP_MB,
      maxYoungGenerationSizeMb: DEV_ARTIFACTS_WORKER_YOUNG_HEAP_MB,
    },
  });
  trackWorker(worker, "dev-artifacts");

  return new Promise<DevArtifactReport>((resolve, reject) => {
    let settled = false;

    // Mark settled and drop the listeners BEFORE terminate(). A
    // terminated worker exits with code 1, and Node emits 'exit' to
    // onExit before terminate()'s promise resolves. Settling afterwards
    // let onExit reject a finished report as a crash.
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate().finally(callback);
    };

    const handleAbort = () => {
      settle(() => reject(new Error("Dev artifacts worker aborted")));
    };

    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      options.signal?.removeEventListener("abort", handleAbort);
    };

    const onMessage = (message: DevArtifactsWorkerResponse) => {
      if (!message || message.requestId !== request.requestId) return;
      if (message.type === "progress") {
        options.onProgress?.(message.progress);
        return;
      }
      if (message.type === "result") {
        settle(() => resolve(message.report));
        return;
      }
      settle(() => reject(new Error(message.message)));
    };

    // A heap-limit kill arrives here as ERR_WORKER_OUT_OF_MEMORY, then
    // 'exit' with code 1. Code 1 alone does not mean OOM: an uncaught
    // throw and terminate() exit with 1 too.
    const onError = (error: Error) => {
      if ((error as NodeJS.ErrnoException)?.code === "ERR_WORKER_OUT_OF_MEMORY") {
        settle(() => reject(new Error(
          `Dev artifacts worker out of memory (its heap is capped at ${DEV_ARTIFACTS_WORKER_HEAP_MB} MB).`,
          { cause: error },
        )));
        return;
      }
      settle(() => reject(error));
    };

    const onExit = (code: number) => {
      if (code !== 0) {
        settle(() => reject(new Error(`Dev artifacts worker exited with code ${code}`)));
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

function nextRequestId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function runDevArtifactsRescanWorker(
  input: DevArtifactsRescanInput,
  options: RunDevArtifactsWorkerOptions,
): Promise<DevArtifactReport> {
  return runDevArtifactsRequest({ type: "rescan", requestId: nextRequestId(), input }, options);
}

export async function runDevArtifactsClassifyWorker(
  input: DevArtifactsClassifyInput,
  options: RunDevArtifactsWorkerOptions,
): Promise<DevArtifactReport> {
  return runDevArtifactsRequest({ type: "classify", requestId: nextRequestId(), input }, options);
}
