import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream";
import { getHeapStatistics } from "node:v8";
import { createGunzip } from "node:zlib";

import { parseFolderTreeSidecarLine } from "./folderTreeSidecarParse";
import type { FolderNodeRecord } from "./folderTreeWorkerProtocol";

export type FolderTreeSidecarLoadResult =
  | { status: "ok"; tree: Map<string, FolderNodeRecord>; lines: number; parseFailures: number }
  /** Stopped because the heap passed the ceiling; the partial tree is dropped. */
  | { status: "heap-ceiling"; lines: number; heapUsedBytes: number }
  | { status: "error"; lines: number; error: unknown };

export interface FolderTreeSidecarLoadOptions {
  /** Stop loading once the V8 heap in use passes this many bytes. */
  heapCeilingBytes: number;
  /** Test seam; defaults to `v8.getHeapStatistics().used_heap_size`. */
  heapUsedBytes?: () => number;
  /** Yield to the event loop and check the heap every N lines. */
  checkEveryLines?: number;
}

/**
 * Stream a folder-tree sidecar into an in-memory Map, one NDJSON line at
 * a time. folderTreeLoadPlan decides up front whether the tree fits.
 * This is the backstop when that estimate is wrong: it checks the heap
 * as it goes and gives up before V8 aborts the process.
 */
export async function loadFolderTreeSidecar(
  filePath: string,
  options: FolderTreeSidecarLoadOptions,
): Promise<FolderTreeSidecarLoadResult> {
  const heapUsed = options.heapUsedBytes ?? (() => getHeapStatistics().used_heap_size);
  const checkEvery = options.checkEveryLines ?? 4_000;
  let tree: Map<string, FolderNodeRecord> | null = new Map();
  let lines = 0;
  let parseFailures = 0;
  const source = createReadStream(filePath);
  const gunzip = createGunzip();
  // pipeline() destroys both streams on error, so the for-await below
  // rejects instead of waiting forever on a source that failed to open.
  pipeline(source, gunzip, () => { /* surfaced by the for-await */ });
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      lines++;
      const parsed = parseFolderTreeSidecarLine(line);
      if (!parsed) {
        parseFailures++;
        continue;
      }
      tree.set(parsed.key, { dirs: parsed.dirs, files: parsed.files });
      if (lines % checkEvery === 0) {
        const used = heapUsed();
        if (used > options.heapCeilingBytes) {
          tree = null;
          rl.close();
          source.destroy();
          return { status: "heap-ceiling", lines, heapUsedBytes: used };
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return { status: "ok", tree, lines, parseFailures };
  } catch (error) {
    return { status: "error", lines, error };
  }
}
