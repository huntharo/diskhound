import { parentPort } from "node:worker_threads";

import { permanentlyDeleteOnDisk } from "../shared/permanentDelete";
import type {
  PermanentDeleteWorkerRequest,
  PermanentDeleteWorkerResponse,
} from "../shared/permanentDeleteWorkerProtocol";

if (parentPort) {
  parentPort.on("message", (message: PermanentDeleteWorkerRequest) => {
    if (!message || message.type !== "delete") return;

    void permanentlyDeleteOnDisk(message.targetPath, (progress) => {
      const response: PermanentDeleteWorkerResponse = {
        type: "progress",
        requestId: message.requestId,
        progress,
      };
      parentPort?.postMessage(response);
    }, message.method)
      .then(() => {
        const response: PermanentDeleteWorkerResponse = {
          type: "result",
          requestId: message.requestId,
        };
        parentPort?.postMessage(response);
      })
      .catch((error) => {
        const response: PermanentDeleteWorkerResponse = {
          type: "error",
          requestId: message.requestId,
          message: error instanceof Error ? error.message : String(error),
          code: typeof error?.code === "string" ? error.code : undefined,
        };
        parentPort?.postMessage(response);
      });
  });
}
