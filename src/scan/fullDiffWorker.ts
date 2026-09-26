import { parentPort } from "node:worker_threads";

import {
  computeFullDiffFromIndexFiles,
  runFullDiffSortWorker,
  sortIndexIntoRuns,
} from "../shared/fullDiffWorkerRuntime";
import type {
  FullDiffWorkerRequest,
  FullDiffWorkerResponse,
} from "../shared/fullDiffWorkerProtocol";

function respond(requestId: string, work: Promise<FullDiffWorkerResponse>): void {
  void work
    .catch((error): FullDiffWorkerResponse => ({
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }))
    .then((response) => parentPort?.postMessage(response));
}

if (parentPort) {
  parentPort.on("message", (message: FullDiffWorkerRequest) => {
    if (message?.type === "compute") {
      const { requestId } = message;
      respond(
        requestId,
        computeFullDiffFromIndexFiles(message.input, {
          // The baseline sorts on a second thread, running this script,
          // while this thread sorts the current index. Sorting is
          // CPU-bound: two threads take it from ~70 s to ~35 s on a
          // 20M-file pair.
          sortElsewhere: (job, signal) => runFullDiffSortWorker(job, { workerPath: __filename, signal }),
        }).then((result) => ({ type: "result", requestId, result })),
      );
    } else if (message?.type === "sort") {
      const { requestId } = message;
      respond(
        requestId,
        sortIndexIntoRuns(message.job).then((sorted) => ({ type: "sorted", requestId, sorted })),
      );
    }
  });
}
