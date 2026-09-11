import type { DevArtifactReport } from "./contracts";

export interface DevArtifactsWorkerInput {
  rootPath: string;
  currentIndexPath: string;
  previousIndexPath?: string | null;
}

export interface DevArtifactsRescanInput {
  rootPath: string;
  sidecarPath: string;
  indexPath: string;
}

export type DevArtifactsWorkerRequest =
  | {
      type: "analyze";
      requestId: string;
      input: DevArtifactsWorkerInput;
    }
  | {
      type: "rescan";
      requestId: string;
      input: DevArtifactsRescanInput;
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
