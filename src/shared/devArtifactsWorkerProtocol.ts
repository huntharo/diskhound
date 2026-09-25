import type { DevArtifactReport } from "./contracts";
import type { DevArtifactsRescanProgress } from "./devArtifactSidecar";

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
      type: "progress";
      requestId: string;
      progress: DevArtifactsRescanProgress;
    }
  | {
      type: "error";
      requestId: string;
      message: string;
      stack?: string;
    };
