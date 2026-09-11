import { parentPort } from "node:worker_threads";

import { analyzeDevArtifacts } from "../shared/devArtifactsIndex";
import type {
  DevArtifactsWorkerRequest,
  DevArtifactsWorkerResponse,
} from "../shared/devArtifactsWorkerProtocol";

if (parentPort) {
  parentPort.on("message", (message: DevArtifactsWorkerRequest) => {
    if (!message || message.type !== "analyze") return;

    void analyzeDevArtifacts(
      message.input.rootPath,
      message.input.currentIndexPath,
      message.input.previousIndexPath,
    )
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
