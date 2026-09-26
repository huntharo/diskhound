import * as Path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import { createGunzip } from "node:zlib";

import { resolveBundledWorkerScript } from "./bundledWorkerPath";
import { unescapeJsonPath } from "./jsonPathUnescape";
import { normPath } from "./pathUtils";
import { trackWorker } from "./workerHeapRegistry";
import type {
  FolderTreeSidecarQueryInput,
  FolderTreeSidecarQueryResult,
} from "./folderTreeSidecarQuery";
import type {
  CompactFolderFileRecord,
  FolderTreeWorkerInput,
  FolderTreeWorkerRequest,
  FolderTreeWorkerResponse,
  SerializedFolderTree,
} from "./folderTreeWorkerProtocol";

const FILES_PER_FOLDER = 200;
const DIRS_PER_FOLDER = 500;
/** Index rebuilds only run for trees folderTreeLoadPlan sized at ≤ 512 MB. */
const FOLDER_TREE_BUILD_WORKER_HEAP_MB = 2048;
/** A paged query keeps at most a few MB of lines; parsing them needs little more. */
const FOLDER_TREE_QUERY_WORKER_HEAP_MB = 256;

/**
 * Build a full parent → children map by streaming the completed scan
 * index once. Moved out of main.ts so it can run inside a Node worker
 * thread — on drive-scale scans (7M+ files) the per-line JSON.parse +
 * Map churn saturates the event loop for ~5 minutes and blocks every
 * setInterval / IPC handler on the main thread.
 *
 * Logic is intentionally identical to the prior inline implementation;
 * see main.ts history for design notes on the bounded-heap trim + key
 * normalization (normalized, no trailing separator).
 */
export async function buildFolderTreeFromIndex(
  indexPathStr: string,
): Promise<SerializedFolderTree> {
  type DirTotals = Map<string, { size: number; fileCount: number }>;
  const childDirTotalsByParent = new Map<string, DirTotals>();
  const filesByParent = new Map<string, CompactFolderFileRecord[]>();

  const toKey = (p: string): string => normPath(p).replace(/[\\/]+$/, "");

  const gunzip = createGunzip();
  const source = createReadStream(indexPathStr);
  // Don't let an EPERM/ENOENT on the index file (e.g. the file was
  // rotated mid-read by a parallel scan finishing) take down the
  // whole worker thread. Errors become a normal for-await rejection
  // that the outer caller handles.
  source.on("error", () => { /* swallowed */ });
  gunzip.on("error", () => { /* swallowed */ });
  source.pipe(gunzip);
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });

  // Fast-path regex for file entries: the scanner always emits exactly
  // this shape, so pattern-matching it bypasses serde_json's object
  // allocation and the two .indexOf() calls JSON.parse does internally.
  // Format: {"p":"<escapedPath>","s":<size>,"m":<mtime>}
  // (dir entries use "t":"d" and are skipped cheaply below.)
  const FILE_LINE_RE = /^\{"p":"((?:\\.|[^"\\])*)","s":(\d+),"m":(\d+)\}$/;

  for await (const line of rl) {
    if (!line) continue;
    // Dir entries: skip without parsing. Using indexOf on a fixed
    // substring is ~30× faster than JSON.parse for the ~15% of lines
    // that carry no file data. The `"t":"d"` marker is unique to dir
    // records so a substring match is unambiguous.
    if (line.indexOf('"t":"d"') !== -1) continue;

    // Fast path — regex match on the canonical shape, then unescape the
    // captured path string (Windows paths have `\\` for every
    // separator; see unescapeJsonPath).
    let rawPath: string;
    let size: number;
    let mtime: number;
    const fastMatch = FILE_LINE_RE.exec(line);
    const fastPath = fastMatch ? unescapeJsonPath(fastMatch[1]) : null;
    if (fastMatch && fastPath !== null) {
      rawPath = fastPath;
      size = Number(fastMatch[2]);
      mtime = Number(fastMatch[3]);
    } else {
      // Slow fallback: line has unusual escapes or field ordering.
      let rec: { p?: string; s?: number; t?: string; m?: number };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || typeof rec.p !== "string") continue;
      if (rec.t === "d") continue;
      if (typeof rec.s !== "number") continue;
      rawPath = rec.p;
      size = rec.s;
      mtime = typeof rec.m === "number" ? rec.m : 0;
    }

    const filePathNorm = toKey(rawPath);

    let current = toKey(Path.dirname(filePathNorm));
    let prevChild = filePathNorm;
    const directParent = toKey(Path.dirname(filePathNorm));
    while (true) {
      const parent = current;
      if (prevChild === filePathNorm && parent === directParent) {
        let list = filesByParent.get(parent);
        if (!list) {
          list = [];
          filesByParent.set(parent, list);
        }
        list.push({
          name: Path.basename(filePathNorm),
          size,
          modifiedAt: mtime,
        });
        if (list.length > FILES_PER_FOLDER * 2) {
          list.sort((a, b) => b.size - a.size);
          list.length = FILES_PER_FOLDER;
        }
      } else if (prevChild !== filePathNorm) {
        let totals = childDirTotalsByParent.get(parent);
        if (!totals) {
          totals = new Map();
          childDirTotalsByParent.set(parent, totals);
        }
        const cur = totals.get(prevChild);
        if (cur) {
          cur.size += size;
          cur.fileCount += 1;
        } else {
          totals.set(prevChild, { size, fileCount: 1 });
        }
      }

      const grandparent = toKey(Path.dirname(parent));
      if (grandparent === parent || grandparent === "") break;
      prevChild = parent;
      current = grandparent;
    }
  }

  const tree: SerializedFolderTree = [];
  const allKeys = new Set<string>();
  for (const k of childDirTotalsByParent.keys()) allKeys.add(k);
  for (const k of filesByParent.keys()) allKeys.add(k);
  for (const parent of allKeys) {
    const dirTotals = childDirTotalsByParent.get(parent);
    const dirs = dirTotals
      ? Array.from(dirTotals.entries())
          .map(([path, t]) => ({ path, size: t.size, fileCount: t.fileCount }))
          .sort((a, b) => b.size - a.size)
          .slice(0, DIRS_PER_FOLDER)
      : [];
    const rawFiles = filesByParent.get(parent) ?? [];
    const files = rawFiles
      .sort((a, b) => b.size - a.size)
      .slice(0, FILES_PER_FOLDER);
    tree.push([parent, { dirs, files }]);
  }
  return tree;
}

export function resolveBundledFolderTreeWorkerPath(baseDir: string): string {
  return resolveBundledWorkerScript(baseDir, "folderTreeWorker.cjs");
}

export interface RunFolderTreeWorkerOptions {
  workerPath: string;
  signal?: AbortSignal;
}

export async function runFolderTreeWorker(
  input: FolderTreeWorkerInput,
  options: RunFolderTreeWorkerOptions,
): Promise<SerializedFolderTree> {
  // Electron's main isolate and its workers share one 4 GB pointer-
  // compression cage, so a bigger resourceLimit is capped at 4 GB and a
  // worker that fills the cage aborts the whole app, not just itself.
  // folderTreeLoadPlan only sends small indexes here. A tight limit
  // makes a bad estimate fail as a worker OOM that main survives.
  const worker = new Worker(options.workerPath, {
    resourceLimits: {
      maxOldGenerationSizeMb: FOLDER_TREE_BUILD_WORKER_HEAP_MB,
      maxYoungGenerationSizeMb: 256,
    },
  });
  trackWorker(worker, "folder-tree");
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return await new Promise<SerializedFolderTree>((resolve, reject) => {
    let settled = false;

    // Mark settled and drop the listeners BEFORE terminate(). A
    // terminated worker exits with code 1, and Node emits 'exit' to
    // onExit before terminate()'s promise resolves. Settling afterwards
    // let onExit reject a finished tree as a crash.
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate().finally(callback);
    };

    const handleAbort = () => {
      settle(() => reject(new Error("Folder tree worker aborted")));
    };

    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      options.signal?.removeEventListener("abort", handleAbort);
    };

    const onMessage = (message: FolderTreeWorkerResponse) => {
      if (!message || message.requestId !== requestId) {
        return;
      }

      if (message.type === "result") {
        settle(() => resolve(message.tree));
        return;
      }
      settle(() => reject(new Error(message.type === "error" ? message.message : `Unexpected ${message.type}`)));
    };

    // A heap-limit kill arrives here as ERR_WORKER_OUT_OF_MEMORY, then
    // 'exit' with code 1. Code 1 alone does not mean OOM: an uncaught
    // throw and terminate() exit with 1 too.
    const onError = (error: Error) => {
      if ((error as NodeJS.ErrnoException)?.code === "ERR_WORKER_OUT_OF_MEMORY") {
        settle(() => reject(new Error(`Folder tree worker out of memory. The index may be too large for the worker's ${FOLDER_TREE_BUILD_WORKER_HEAP_MB} MB heap.`, { cause: error })));
        return;
      }
      settle(() => reject(error));
    };

    const onExit = (code: number) => {
      if (code !== 0) {
        settle(() => reject(new Error(`Folder tree worker exited with code ${code}`)));
      }
    };

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);

    if (options.signal) {
      if (options.signal.aborted) {
        handleAbort();
        return;
      }
      options.signal.addEventListener("abort", handleAbort, { once: true });
    }

    const request: FolderTreeWorkerRequest = {
      type: "build",
      requestId,
      input,
    };
    worker.postMessage(request);
  });
}

/**
 * Run one paged sidecar query (see folderTreeSidecarQuery.ts) in a
 * short-lived worker. Main's event loop stays free while the worker
 * gunzips and scans the whole sidecar, and a surprise in the data hits
 * the worker's small heap limit instead of the shared cage.
 *
 * Marks itself settled and drops its listeners before terminate():
 * terminate() makes the worker exit with code 1, and an exit handler
 * still attached would misreport that as a failure. It resolves only
 * after terminate() finishes, so the worker's heap is freed from the
 * shared cage before the caller builds on the result.
 */
export async function runFolderTreeQueryWorker(
  input: FolderTreeSidecarQueryInput,
  options: RunFolderTreeWorkerOptions,
): Promise<FolderTreeSidecarQueryResult> {
  const worker = new Worker(options.workerPath, {
    resourceLimits: { maxOldGenerationSizeMb: FOLDER_TREE_QUERY_WORKER_HEAP_MB },
  });
  trackWorker(worker, "folder-tree-query");
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return await new Promise<FolderTreeSidecarQueryResult>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      options.signal?.removeEventListener("abort", onAbort);
      void worker.terminate().finally(callback);
    };
    const onMessage = (message: FolderTreeWorkerResponse) => {
      if (!message || message.requestId !== requestId) return;
      if (message.type === "query-result") {
        finish(() => resolve(message.result));
      } else {
        finish(() => reject(new Error(message.type === "error" ? message.message : `Unexpected ${message.type}`)));
      }
    };
    const onError = (error: Error) => finish(() => reject(error));
    const onExit = (code: number) => {
      finish(() => reject(new Error(`Folder tree query worker exited with code ${code}`)));
    };
    const onAbort = () => finish(() => reject(new Error("Folder tree query aborted")));

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const request: FolderTreeWorkerRequest = { type: "query", requestId, input };
    worker.postMessage(request);
  });
}
