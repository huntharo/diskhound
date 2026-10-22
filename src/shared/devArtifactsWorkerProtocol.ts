import type { DevArtifactReport } from "./contracts";

export interface DevArtifactsClassifyInput {
  rootPath: string;
  folderTreePath: string;
  destSidecarPath: string;
  previousSidecarPath?: string | null;
}

export type DevArtifactsWorkerRequest = {
  type: "classify";
  requestId: string;
  input: DevArtifactsClassifyInput;
};

export type DevArtifactsWorkerResponse =
  | {
      type: "result";
      requestId: string;
      report: DevArtifactReport;
    }
  | {
      type: "error";
      requestId: string;
      message: string;
      stack?: string;
    };
