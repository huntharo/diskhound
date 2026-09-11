import * as Path from "node:path";
import { Worker } from "node:worker_threads";

import type { DevArtifactReport } from "./contracts";
import type { DevArtifactsRescanProgress } from "./devArtifactSidecar";
import type {
  DevArtifactsClassifyInput,
  DevArtifactsLoadInput,
  DevArtifactsRescanInput,
  DevArtifactsWorkerInput,
  DevArtifactsWorkerRequest,
  DevArtifactsWorkerResponse,
} from "./devArtifactsWorkerProtocol";

export function resolveBundledDevArtifactsWorkerPath(baseDir: string): string {
  return Path.join(baseDir, "scan", "devArtifactsWorker.cjs");
}

export interface RunDevArtifactsWorkerOptions {
  workerPath: string;
  signal?: AbortSignal;
  onProgress?: (progress: DevArtifactsRescanProgress) => void;
}

function runDevArtifactsRequest(
  request: DevArtifactsWorkerRequest,
  options: RunDevArtifactsWorkerOptions,
): Promise<DevArtifactReport | null> {
  const worker = new Worker(options.workerPath, {
    resourceLimits: {
      maxOldGenerationSizeMb: 4096,
      maxYoungGenerationSizeMb: 256,
    },
  });

  return new Promise<DevArtifactReport | null>((resolve, reject) => {
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const handleAbort = () => {
      void worker.terminate().finally(() => {
        settle(() => reject(new Error("Dev artifacts worker aborted")));
      });
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
      void worker.terminate().finally(() => {
        if (message.type === "result") {
          settle(() => resolve(message.report));
          return;
        }
        settle(() => reject(new Error(message.message)));
      });
    };

    const onError = (error: Error) => {
      settle(() => reject(error));
    };

    const onExit = (code: number) => {
      if (!settled && code !== 0) {
        const detail = code === 1
          ? "Dev artifacts worker out of memory (exit code 1)."
          : `Dev artifacts worker exited with code ${code}`;
        settle(() => reject(new Error(detail)));
      }
    };

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    worker.postMessage(request);
  });
}

async function requireReport(
  request: DevArtifactsWorkerRequest,
  options: RunDevArtifactsWorkerOptions,
): Promise<DevArtifactReport> {
  const report = await runDevArtifactsRequest(request, options);
  if (!report) throw new Error("Dev artifacts worker returned no report");
  return report;
}

function nextRequestId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function runDevArtifactsWorker(
  input: DevArtifactsWorkerInput,
  options: RunDevArtifactsWorkerOptions,
): Promise<DevArtifactReport> {
  return requireReport({ type: "analyze", requestId: nextRequestId(), input }, options);
}

export async function runDevArtifactsRescanWorker(
  input: DevArtifactsRescanInput,
  options: RunDevArtifactsWorkerOptions,
): Promise<DevArtifactReport> {
  return requireReport({ type: "rescan", requestId: nextRequestId(), input }, options);
}

export async function runDevArtifactsClassifyWorker(
  input: DevArtifactsClassifyInput,
  options: RunDevArtifactsWorkerOptions,
): Promise<DevArtifactReport> {
  return requireReport({ type: "classify", requestId: nextRequestId(), input }, options);
}

export async function runDevArtifactsLoadWorker(
  input: DevArtifactsLoadInput,
  options: RunDevArtifactsWorkerOptions,
): Promise<DevArtifactReport | null> {
  return runDevArtifactsRequest(
    { type: "load", requestId: nextRequestId(), input },
    options,
  );
}
