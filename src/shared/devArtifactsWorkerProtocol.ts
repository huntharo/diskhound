import type { DevArtifactReport } from "./contracts";

export interface DevArtifactsWorkerInput {
  rootPath: string;
  currentIndexPath: string;
  previousIndexPath?: string | null;
}

export interface DevArtifactsWorkerRequest {
  type: "analyze";
  requestId: string;
  input: DevArtifactsWorkerInput;
}

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
