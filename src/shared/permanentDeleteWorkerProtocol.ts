import type { PermanentDeleteProgress } from "./contracts";

export interface PermanentDeleteWorkerRequest {
  type: "delete";
  requestId: string;
  targetPath: string;
}

export type PermanentDeleteWorkerResponse =
  | {
      type: "progress";
      requestId: string;
      progress: PermanentDeleteProgress;
    }
  | {
      type: "result";
      requestId: string;
    }
  | {
      type: "error";
      requestId: string;
      message: string;
    };
