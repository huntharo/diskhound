import type { FullDiffResult } from "./contracts";

export interface FullDiffWorkerInput {
  baselineId: string;
  currentId: string;
  baselinePath: string;
  currentPath: string;
  limit?: number;
  /**
   * Override path-case handling. Defaults to platform behavior:
   * case-insensitive on Windows, case-sensitive elsewhere.
   */
  caseSensitive?: boolean;
  /**
   * Records per sorted run the external sort spills. Defaults to
   * 120,000; tests lower it to get several runs from a small index.
   */
  sortChunkRecords?: number;
}

export interface FullDiffWorkerRequest {
  type: "compute";
  requestId: string;
  input: FullDiffWorkerInput;
}

export type FullDiffWorkerResponse =
  | {
      type: "result";
      requestId: string;
      result: FullDiffResult | null;
    }
  | {
      type: "error";
      requestId: string;
      message: string;
      stack?: string;
    };
