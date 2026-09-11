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

export interface DevArtifactsClassifyInput {
  rootPath: string;
  folderTreePath: string;
  destSidecarPath: string;
  previousSidecarPath?: string | null;
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
    }
  | {
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
