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
   * Records per sorted run the external sort writes. Defaults to
   * 120,000; tests lower it to get several runs from a small index.
   */
  sortChunkRecords?: number;
}

/** One index to sort into runs, for the full diff's first pass. */
export interface FullDiffSortJob {
  indexPath: string;
  caseSensitive: boolean;
  /** Where the runs go. Created on the first run. */
  runDir: string;
  sortChunkRecords: number;
}

export interface SortedIndex {
  /** False when the index file doesn't exist; it diffs as empty. */
  exists: boolean;
  /** Run files in the order they were written. */
  runs: string[];
}

export type FullDiffWorkerRequest =
  | {
      type: "compute";
      requestId: string;
      input: FullDiffWorkerInput;
    }
  | {
      /** Sort one side, for a diff worker that sorts the other. */
      type: "sort";
      requestId: string;
      job: FullDiffSortJob;
    };

export type FullDiffWorkerResponse =
  | {
      type: "result";
      requestId: string;
      result: FullDiffResult | null;
    }
  | {
      type: "sorted";
      requestId: string;
      sorted: SortedIndex;
    }
  | {
      type: "error";
      requestId: string;
      message: string;
      stack?: string;
    };
