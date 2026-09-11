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
          let sidecar = await readDevArtifactSidecar(message.input.sidecarPath);
          if (!sidecar) {
            const report = await analyzeDevArtifacts(message.input.rootPath, message.input.indexPath);
            sidecar = {
              version: 1,
              rootPath: report.rootPath,
              generatedAt: report.generatedAt,
              roots: report.artifacts.map((a) => ({
                path: a.path,
                kind: a.kind,
                size: a.size,
                files: a.fileCount,
              })),
              projects: [...new Set(report.artifacts.map((a) => a.projectPath).filter((p): p is string => Boolean(p)))],
            };
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
