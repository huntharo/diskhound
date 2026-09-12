import type { DevArtifactReport } from "./contracts";
import type { DevArtifactsRescanProgress } from "./devArtifactSidecar";

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

export interface DevArtifactsLoadInput {
  destSidecarPath: string;
  scanRoot: string;
  pendingPaths: string[];
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
    }
  | {
      type: "load";
      requestId: string;
      input: DevArtifactsLoadInput;
    };

export type DevArtifactsWorkerResponse =
  | {
      type: "result";
      requestId: string;
      report: DevArtifactReport | null;
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
