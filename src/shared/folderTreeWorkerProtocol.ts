/**
 * Message shapes for the folder-tree build worker.
 *
 * The worker streams a completed scan index (NDJSON.gz) off disk and
 * produces the parent → children map that powers the Folders tab.
 * It lives in its own thread so the ~5-minute build on a drive-scale
 * scan (7M+ files) doesn't block the main thread's event loop —
 * specifically so setInterval heartbeats ([memory] logs) and IPC
 * handlers keep running while the tree builds.
 *
 * It also answers paged "query" requests: one folder read straight from
 * the sidecar, for scans too big to hold as a tree.
 */

import type {
  FolderTreeSidecarQueryInput,
  FolderTreeSidecarQueryResult,
} from "./folderTreeSidecarQuery";

export type CompactFolderFileRecord = {
  name: string;
  size: number;
  modifiedAt: number;
};

export type FolderNodeRecord = {
  dirs: { path: string; size: number; fileCount: number }[];
  files: CompactFolderFileRecord[];
};

/** Serialized folder tree — a plain array of [key, node] pairs so it
 *  survives postMessage without needing a Map transfer. Main thread
 *  reconstructs the Map on receipt. */
export type SerializedFolderTree = [string, FolderNodeRecord][];

export interface FolderTreeWorkerInput {
  indexPath: string;
}

export type FolderTreeWorkerRequest =
  | {
      type: "build";
      requestId: string;
      input: FolderTreeWorkerInput;
    }
  | {
      /** One folder and part of its subtree from the sidecar (paged mode). */
      type: "query";
      requestId: string;
      input: FolderTreeSidecarQueryInput;
    };

export type FolderTreeWorkerResponse =
  | {
      type: "result";
      requestId: string;
      tree: SerializedFolderTree;
    }
  | {
      type: "query-result";
      requestId: string;
      result: FolderTreeSidecarQueryResult;
    }
  | {
      type: "error";
      requestId: string;
      message: string;
      stack?: string;
    };
