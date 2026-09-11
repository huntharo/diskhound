import { parentPort } from "node:worker_threads";

import { analyzeDevArtifacts } from "../shared/devArtifactsIndex";
import {
  readDevArtifactSidecar,
  reportFromSidecar,
  rescanDevArtifactSidecar,
  resolveDevArtifactSidecar,
  sidecarFromFolderTreeFile,
  writeDevArtifactSidecar,
} from "../shared/devArtifactSidecar";
import type {
  DevArtifactsClassifyInput,
  DevArtifactsLoadInput,
  DevArtifactsRescanInput,
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

async function loadSidecarReport(input: DevArtifactsLoadInput) {
  const sidecar = await resolveDevArtifactSidecar(
    input.destSidecarPath,
    input.scanRoot,
    input.pendingPaths,
  );
  if (!sidecar) return null;
  const previous = input.previousSidecarPath
    ? await readDevArtifactSidecar(input.previousSidecarPath)
    : null;
  return reportFromSidecar(sidecar, previous);
}

async function rescanKnownTrees(input: DevArtifactsRescanInput, requestId: string) {
  const sidecar = await readDevArtifactSidecar(input.sidecarPath);
  if (!sidecar) {
    throw new Error(
      "No Dev Artifacts sidecar to refresh. Run a full scan, or open Dev Artifacts after Folders has loaded.",
    );
  }
  const next = await rescanDevArtifactSidecar(sidecar, (progress) => {
    const response: DevArtifactsWorkerResponse = {
      type: "progress",
      requestId,
      progress,
    };
    parentPort?.postMessage(response);
  });
  await writeDevArtifactSidecar(input.sidecarPath, next);
  return reportFromSidecar(next, sidecar);
}

if (parentPort) {
  parentPort.on("message", (message: DevArtifactsWorkerRequest) => {
    if (
      !message
      || (message.type !== "analyze"
        && message.type !== "rescan"
        && message.type !== "classify"
        && message.type !== "load")
    ) return;

    const work = message.type === "classify"
      ? classifyFromFolderTree(message.input)
      : message.type === "rescan"
        ? rescanKnownTrees(message.input, message.requestId)
        : message.type === "load"
          ? loadSidecarReport(message.input)
          : analyzeDevArtifacts(
              message.input.rootPath,
              message.input.currentIndexPath,
              message.input.previousIndexPath,
            );

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
