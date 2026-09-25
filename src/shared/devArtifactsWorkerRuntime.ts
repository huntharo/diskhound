import { Worker } from "node:worker_threads";

import { resolveBundledWorkerScript } from "./bundledWorkerPath";

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
      maxOldGenerationSizeMb: 4096,
      maxYoungGenerationSizeMb: 256,
    },
  });

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
        settle(() => reject(new Error("Dev artifacts worker out of memory.", { cause: error })));
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
