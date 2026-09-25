import { parentPort } from "node:worker_threads";

import { queryFolderTreeSidecar } from "../shared/folderTreeSidecarQuery";
import { buildFolderTreeFromIndex } from "../shared/folderTreeWorkerRuntime";
import type {
  FolderTreeWorkerRequest,
  FolderTreeWorkerResponse,
} from "../shared/folderTreeWorkerProtocol";

if (parentPort) {
  parentPort.on("message", (message: FolderTreeWorkerRequest) => {
    if (!message || (message.type !== "build" && message.type !== "query")) {
      return;
    }

    const work: Promise<FolderTreeWorkerResponse> = message.type === "build"
      ? buildFolderTreeFromIndex(message.input.indexPath).then((tree) => ({
          type: "result",
          requestId: message.requestId,
          tree,
        }))
      : queryFolderTreeSidecar(message.input).then((result) => ({
          type: "query-result",
          requestId: message.requestId,
          result,
        }));

    void work
      .then((response) => {
        parentPort?.postMessage(response);
      })
      .catch((error) => {
        const response: FolderTreeWorkerResponse = {
          type: "error",
          requestId: message.requestId,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        };
        parentPort?.postMessage(response);
      });
  });
}
