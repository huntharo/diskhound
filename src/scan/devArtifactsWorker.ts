import { parentPort } from "node:worker_threads";

import { sidecarFromFolderTreeFile } from "../shared/devArtifactFolderTree";
import {
  readDevArtifactSidecar,
  reportFromSidecar,
  writeDevArtifactSidecar,
} from "../shared/devArtifactSidecar";
import type {
  DevArtifactsClassifyInput,
  DevArtifactsWorkerRequest,
  DevArtifactsWorkerResponse,
} from "../shared/devArtifactsWorkerProtocol";

async function classifyFromFolderTree(input: DevArtifactsClassifyInput) {
  const sidecar = await sidecarFromFolderTreeFile(input.folderTreePath, input.rootPath);
  if (!sidecar) {
    throw new Error("Folder tree sidecar had no directory rollups");
  }
  await writeDevArtifactSidecar(input.destSidecarPath, sidecar);
  const previous = input.previousSidecarPath
    ? await readDevArtifactSidecar(input.previousSidecarPath)
    : null;
  return reportFromSidecar(sidecar, previous);
}

if (parentPort) {
  parentPort.on("message", (message: DevArtifactsWorkerRequest) => {
    if (!message || message.type !== "classify") return;

    void classifyFromFolderTree(message.input)
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
