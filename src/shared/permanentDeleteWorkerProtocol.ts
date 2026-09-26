import type { PermanentDeleteProgress } from "./contracts";
import type { PermanentDeleteMethod } from "./permanentDelete";

export interface PermanentDeleteWorkerRequest {
  type: "delete";
  requestId: string;
  targetPath: string;
  method?: PermanentDeleteMethod;
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
      code?: string;
    };
