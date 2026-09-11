import { parentPort } from "node:worker_threads";

import { analyzeDevArtifacts } from "../shared/devArtifactsIndex";
import {
  readDevArtifactSidecar,
  reportFromSidecar,
  rescanDevArtifactSidecar,
  writeDevArtifactSidecar,
} from "../shared/devArtifactSidecar";
import type {
  DevArtifactsWorkerRequest,
  DevArtifactsWorkerResponse,
} from "../shared/devArtifactsWorkerProtocol";

if (parentPort) {
  parentPort.on("message", (message: DevArtifactsWorkerRequest) => {
    if (!message || (message.type !== "analyze" && message.type !== "rescan")) return;

    const work = message.type === "analyze"
      ? analyzeDevArtifacts(
          message.input.rootPath,
          message.input.currentIndexPath,
          message.input.previousIndexPath,
        )
      : (async () => {
          const sidecar = await readDevArtifactSidecar(message.input.sidecarPath);
          if (!sidecar) {
            throw new Error(
              "No Dev Artifacts sidecar to refresh. Run a full scan, or open Dev Artifacts after Folders has loaded.",
            );
          }
          const next = await rescanDevArtifactSidecar(sidecar);
          await writeDevArtifactSidecar(message.input.sidecarPath, next);
          return reportFromSidecar(next, sidecar);
        })();

    void work
      .then((report) => {
        const response: DevArtifactsWorkerResponse = {
          type: "result",
          requestId: message.requestId,
          report,
        };
        parentPort?.postMessage(response);
      })
      .catch((error) => {
        const response: DevArtifactsWorkerResponse = {
          type: "error",
          requestId: message.requestId,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        };
        parentPort?.postMessage(response);
      });
  });
}
