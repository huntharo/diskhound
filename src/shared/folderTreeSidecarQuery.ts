import { createReadStream } from "node:fs";
import { pipeline } from "node:stream";
import { createGunzip } from "node:zlib";

import { parseFolderTreeSidecarLine } from "./folderTreeSidecarParse";
import type { SerializedFolderTree } from "./folderTreeWorkerProtocol";

/**
 * Read one folder, plus a bounded slice of the tree around it, out of a
 * folder-tree sidecar without loading the rest.
 *
 * Paged Folders-tab mode uses this for scans whose tree is too big to
 * hold in the heap (see folderTreeLoadPlan.ts). The sidecar is unordered
 * gzipped NDJSON, so every query is one full streaming pass. Lines are
 * matched on raw bytes and only the kept ones become strings, so heap
 * use stays flat. A 995 MB sidecar (3.7 GB of NDJSON, 8.7M lines) takes
 * about 6 s per pass with ~2 MB of heap.
 *
 * The prefetch hangs off `anchorKey`, usually the target's parent, so
 * the target's siblings come along too. Descendants of the anchor are
 * kept by depth, up to `maxDepth`. When the kept bytes pass `maxBytes`,
 * the deepest level is dropped whole. So `coveredDepth` is exact: any
 * key at or above it under the anchor is either in `entries` or has no
 * line, meaning the folder is empty. The target's own line is always
 * kept, whatever its depth.
 */

export interface FolderTreeSidecarQueryInput {
  sidecarPath: string;
  /** The folder asked for. Tree key: `normPath()` form, no trailing separator. "" is the POSIX root. */
  targetKey: string;
  /** Prefetch root: the target or one of its ancestors. Defaults to the target. */
  anchorKey?: string;
  /** Separator the scanner used for keys: "\\" on Windows, "/" elsewhere. */
  separator: "/" | "\\";
  maxDepth: number;
  maxBytes: number;
}

export interface FolderTreeSidecarQueryResult {
  anchorKey: string;
  entries: SerializedFolderTree;
  /** Depth below the anchor that `entries` covers completely. */
  coveredDepth: number;
  linesScanned: number;
  /** Uncompressed line bytes behind `entries`. */
  bytesKept: number;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const SLASH = 0x2f;
const NEWLINE = 0x0a;
const KEY_HEAD = Buffer.from('{"k":"', "utf8");
const NEEDS_DECODED_COMPARE_RE =
  /[\u0000-\u001f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Escape a key the way both sidecar writers do. Native
 * `append_json_escaped` and `JSON.stringify` only disagree on
 * \b and \f; keys with control characters take the decoded path below.
 */
function escapeKey(key: string): string {
  return key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Depth of `key` below `target`: 0 = the target, -1 = not under it. */
export function relativeDepth(key: string, target: string, separator: string): number {
  if (key === target) return 0;
  const prefix = target + separator;
  if (!key.startsWith(prefix)) return -1;
  let depth = 1;
  for (let i = key.indexOf(separator, prefix.length); i !== -1; i = key.indexOf(separator, i + 1)) {
    depth += 1;
  }
  return depth;
}

export async function queryFolderTreeSidecar(
  input: FolderTreeSidecarQueryInput,
): Promise<FolderTreeSidecarQueryResult> {
  const { targetKey, separator } = input;
  const anchorKey = input.anchorKey ?? targetKey;
  const windowsSeparator = separator === "\\";
  const targetDepth = relativeDepth(targetKey, anchorKey, separator);
  if (targetDepth < 0) throw new Error(`anchor ${anchorKey} is not an ancestor of ${targetKey}`);
  // Keys with control characters or lone surrogates are escaped
  // differently by the two writers, so compare decoded keys for those
  // instead of bytes. It's a slower pass, and such paths are rare.
  const decodeEveryKey = NEEDS_DECODED_COMPARE_RE.test(targetKey);
  const anchor = Buffer.from(escapeKey(anchorKey), "utf8");
  const targetHead = Buffer.from(`{"k":"${escapeKey(targetKey)}"`, "utf8");
  const separatorBytes = Buffer.from(windowsSeparator ? "\\\\" : "/", "utf8");

  let maxDepth = Math.max(0, Math.floor(input.maxDepth));
  const buckets: Buffer[][] = Array.from({ length: maxDepth + 1 }, () => []);
  const bucketBytes: number[] = new Array(maxDepth + 1).fill(0);
  let keptBytes = 0;
  let foundAnchor = false;
  /** The target's line, kept even when its level is dropped from the prefetch. */
  let pinnedTarget: Buffer | null = null;
  let targetInBuckets = false;
  let linesScanned = 0;

  /**
   * Depth below the anchor from the escaped key bytes, or -1. Stops
   * counting once past the depth that matters.
   */
  const depthFromBytes = (buf: Buffer, start: number, end: number): number => {
    const keyStart = start + KEY_HEAD.length;
    const afterAnchor = keyStart + anchor.length;
    if (afterAnchor >= end) return -1;
    if (buf.compare(anchor, 0, anchor.length, keyStart, afterAnchor) !== 0) return -1;
    if (buf[afterAnchor] === QUOTE) return 0;
    if (buf.compare(separatorBytes, 0, separatorBytes.length, afterAnchor, afterAnchor + separatorBytes.length) !== 0) {
      return -1;
    }
    const stopPast = Math.max(maxDepth, targetDepth);
    let depth = 1;
    let i = afterAnchor + separatorBytes.length;
    while (i < end) {
      const b = buf[i];
      if (b === QUOTE) return depth;
      if (b === BACKSLASH) {
        if (windowsSeparator && buf[i + 1] === BACKSLASH) {
          depth += 1;
          if (depth > stopPast) return depth;
        }
        i += 2;
        continue;
      }
      if (!windowsSeparator && b === SLASH) {
        depth += 1;
        if (depth > stopPast) return depth;
      }
      i += 1;
    }
    return -1;
  };

  /** [depth below the anchor, whether the key is the target], or null. */
  const classifyDecodedLine = (line: string): [number, boolean] | null => {
    const parsed = parseFolderTreeSidecarLine(line);
    if (!parsed) return null;
    const depth = relativeDepth(parsed.key, anchorKey, separator);
    return depth < 0 ? null : [depth, parsed.key === targetKey];
  };

  const keep = (buf: Buffer, start: number, end: number, depth: number, isTarget: boolean) => {
    const line = Buffer.from(buf.subarray(start, end));
    if (depth === 0) foundAnchor = true;
    if (isTarget) pinnedTarget = line;
    if (depth > maxDepth) return;
    if (isTarget) targetInBuckets = true;
    buckets[depth].push(line);
    bucketBytes[depth] += line.length;
    keptBytes += line.length;
    // Over budget: drop whole levels from the bottom so coverage stays
    // exact. The anchor's own line always stays.
    while (keptBytes > input.maxBytes && maxDepth > 0) {
      keptBytes -= bucketBytes[maxDepth];
      buckets[maxDepth] = [];
      bucketBytes[maxDepth] = 0;
      if (maxDepth === targetDepth) targetInBuckets = false;
      maxDepth -= 1;
    }
  };

  const onLine = (buf: Buffer, start: number, end: number) => {
    if (end <= start) return;
    linesScanned += 1;
    const canonical =
      !decodeEveryKey &&
      end - start > KEY_HEAD.length &&
      buf.compare(KEY_HEAD, 0, KEY_HEAD.length, start, start + KEY_HEAD.length) === 0;
    let depth: number;
    let isTarget: boolean;
    if (canonical) {
      depth = depthFromBytes(buf, start, end);
      isTarget = depth === targetDepth &&
        end - start > targetHead.length &&
        buf.compare(targetHead, 0, targetHead.length, start, start + targetHead.length) === 0;
    } else {
      const classified = classifyDecodedLine(buf.toString("utf8", start, end));
      if (!classified) return;
      [depth, isTarget] = classified;
    }
    if (depth >= 0 && (depth <= maxDepth || isTarget)) keep(buf, start, end, depth, isTarget);
  };

  const source = createReadStream(input.sidecarPath, { highWaterMark: 1 << 20 });
  const gunzip = createGunzip({ chunkSize: 1 << 20 });
  // pipeline() destroys both streams on any error, so the loop below
  // rejects instead of waiting on a stream that never ends.
  pipeline(source, gunzip, () => { /* surfaced by the for-await */ });

  let pending: Buffer | null = null;
  for await (const chunk of gunzip as AsyncIterable<Buffer>) {
    let start = 0;
    if (pending) {
      const nl = chunk.indexOf(NEWLINE);
      if (nl === -1) {
        pending = Buffer.concat([pending, chunk]);
        continue;
      }
      const joined: Buffer = Buffer.concat([pending, chunk.subarray(0, nl)]);
      pending = null;
      onLine(joined, 0, joined.length);
      start = nl + 1;
    }
    for (let nl = chunk.indexOf(NEWLINE, start); nl !== -1; nl = chunk.indexOf(NEWLINE, start)) {
      onLine(chunk, start, nl);
      start = nl + 1;
    }
    if (start < chunk.length) pending = Buffer.from(chunk.subarray(start));
    // Nothing below the anchor is wanted any more and the target is in
    // hand, so the rest of the file can't change the answer.
    if (maxDepth === 0 && foundAnchor && pinnedTarget) {
      pending = null;
      source.destroy();
      break;
    }
  }
  if (pending) onLine(pending, 0, pending.length);

  const lines = buckets.slice(0, maxDepth + 1).flat();
  let bytesKept = keptBytes;
  const pinned = pinnedTarget as Buffer | null;
  if (pinned && !targetInBuckets) {
    lines.push(pinned);
    bytesKept += pinned.length;
  }
  const entries: SerializedFolderTree = [];
  for (const line of lines) {
    const parsed = parseFolderTreeSidecarLine(line.toString("utf8"));
    if (parsed) entries.push([parsed.key, { dirs: parsed.dirs, files: parsed.files }]);
  }
  return { anchorKey, entries, coveredDepth: maxDepth, linesScanned, bytesKept };
}
