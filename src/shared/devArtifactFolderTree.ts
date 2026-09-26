import * as FS from "node:fs";
import { pipeline } from "node:stream";
import { createGunzip } from "node:zlib";

import { ARTIFACT_SEGMENT_NAMES } from "./devArtifacts";
import {
  createDevAcc,
  dropNestedRoots,
  isProjectMarkerName,
  noteDirectoryRoot,
  PROJECT_MARKERS,
  projectCanOwnArtifact,
  sidecarFromAcc,
  type DevAcc,
  type DevArtifactSidecar,
} from "./devArtifactSidecar";
import {
  decodeScannedString,
  ESCAPES_NONE,
  ESCAPES_OTHER,
  scanFolderTreeLine,
  type FolderTreeLineVisitor,
} from "./folderTreeLineScan";

/**
 * Classify Dev Artifacts from a folder-tree sidecar (NDJSON.gz), for
 * scans that have no `.dev-artifacts.json`. Never opens the 7M-file index.
 *
 * This runs in the Dev Artifacts worker, which shares Electron's 4 GB
 * heap cage with the main process (see folderTreeLoadPlan.ts). A 42M-file
 * `/` scan wrote a 995 MB folder-tree sidecar: 8.7M lines holding ~10M
 * child-folder rows. The first version of this reader kept every one of
 * those rows as an object before classifying, enough to fill the cage
 * and abort the whole app.
 *
 * So it streams raw bytes the way folderTreeSidecarQuery.ts does, and
 * holds only artifact roots and the project folders that could own one.
 * A folder row becomes a string only when its last or second-to-last
 * path segment is a name `classifyArtifactPath` can start a match on,
 * because an artifact root always ends at or one past that segment.
 * Every other row is skipped where it lies.
 */

export interface FolderTreeClassifyStats {
  /** Non-empty lines read, and how many went through JSON.parse. */
  lines: number;
  parsedLines: number;
  /** Lines longer than the line cap, dropped unread. */
  skippedLines: number;
  /** `d` and `f` rows looked at. A line the scanner gives up on is looked at again by JSON.parse. */
  rows: number;
  /** Rows turned into strings: likely artifact paths and odd names. */
  decodedRows: number;
  /**
   * Artifact roots and project folders held when the file ended. Both
   * only grow while streaming, so this is also the most held at once.
   */
  retainedRoots: number;
  retainedProjects: number;
  /**
   * One per line, per row, and per ancestor lookup when nested roots are
   * dropped: the operation count the scaling tests compare.
   */
  steps: number;
}

const NEWLINE = 0x0a;
/**
 * Longest line read. A longer one (a corrupt file with no newlines) would
 * be held whole in Buffers the worker's heap limit doesn't cover, and the
 * JSON.parse fallback can't make a string that long anyway.
 */
export const MAX_FOLDER_TREE_LINE_BYTES = 256 * 1024 * 1024;

/** Lowercase ASCII names grouped by length, to match raw bytes without a string. */
function namesByLength(names: Iterable<string>): Buffer[][] {
  const table: Buffer[][] = [];
  for (const name of names) (table[name.length] ??= []).push(Buffer.from(name, "latin1"));
  return table;
}

const SEGMENTS_BY_LENGTH = namesByLength(ARTIFACT_SEGMENT_NAMES);
const MARKERS_BY_LENGTH = namesByLength(PROJECT_MARKERS);

/**
 * Whether escape-free bytes, lowercased, are one of `names`. Bytes past
 * ASCII take the string path: `toLowerCase` folds a few of them (the
 * Kelvin sign) into ASCII letters.
 */
function bytesNameIn(
  buf: Buffer,
  start: number,
  end: number,
  table: Buffer[][],
  names: ReadonlySet<string>,
): boolean {
  for (let i = start; i < end; i++) {
    if (buf[i]! >= 0x80) return names.has(buf.toString("utf8", start, end).toLowerCase());
  }
  const candidates = table[end - start];
  if (!candidates) return false;
  next: for (const name of candidates) {
    for (let j = 0; j < name.length; j++) {
      let b = buf[start + j]!;
      if (b >= 0x41 && b <= 0x5a) b += 0x20;
      if (b !== name[j]) continue next;
    }
    return true;
  }
  return false;
}

function isSeparator(b: number): boolean {
  return b === 0x2f || b === 0x5c;
}

/**
 * Whether the last or second-to-last segment of a raw path names an
 * artifact. Only for paths whose sole escape is `\\`, where every
 * backslash byte is part of a separator.
 */
function tailNamesArtifact(buf: Buffer, start: number, end: number): boolean {
  let i = end;
  for (let segment = 0; segment < 2; segment++) {
    while (i > start && isSeparator(buf[i - 1]!)) i -= 1;
    const segmentEnd = i;
    while (i > start && !isSeparator(buf[i - 1]!)) i -= 1;
    if (i === segmentEnd) return false;
    if (bytesNameIn(buf, i, segmentEnd, SEGMENTS_BY_LENGTH, ARTIFACT_SEGMENT_NAMES)) return true;
  }
  return false;
}

/** Collects one line's keepers until the scanner says the line is valid. */
class LineKeepers implements FolderTreeLineVisitor {
  keyStart = 0;
  keyEnd = 0;
  keyEscapes = ESCAPES_NONE;
  hasMarker = false;
  readonly dirs: Array<{ path: string; size: number; files: number }> = [];
  rows = 0;
  decodedRows = 0;

  reset(): void {
    this.hasMarker = false;
    this.dirs.length = 0;
    this.rows = 0;
    this.decodedRows = 0;
  }

  key(_buf: Buffer, start: number, end: number, escapes: number): void {
    this.keyStart = start;
    this.keyEnd = end;
    this.keyEscapes = escapes;
  }

  dir(buf: Buffer, start: number, end: number, escapes: number, size: number, files: number): void {
    this.rows += 1;
    if (size <= 0) return;
    if (escapes !== ESCAPES_OTHER && !tailNamesArtifact(buf, start, end)) return;
    this.decodedRows += 1;
    this.dirs.push({ path: decodeScannedString(buf, start, end, escapes), size, files });
  }

  file(buf: Buffer, start: number, end: number, escapes: number): void {
    this.rows += 1;
    if (this.hasMarker) return;
    if (escapes === ESCAPES_NONE) {
      this.hasMarker = bytesNameIn(buf, start, end, MARKERS_BY_LENGTH, PROJECT_MARKERS);
      return;
    }
    this.decodedRows += 1;
    this.hasMarker = isProjectMarkerName(decodeScannedString(buf, start, end, escapes));
  }
}

function noteProject(acc: DevAcc, path: string): void {
  if (projectCanOwnArtifact(path)) acc.projects.add(path);
}

/**
 * A line in another layout, through JSON.parse. Same checks as the
 * original reader. Returns whether it was a folder entry.
 */
function noteParsedLine(acc: DevAcc, line: string, counts: FolderTreeClassifyStats): boolean {
  let rec: { k?: unknown; d?: unknown; f?: unknown } | null;
  try { rec = JSON.parse(line); } catch { return false; }
  if (!rec || typeof rec !== "object" || typeof rec.k !== "string") return false;
  if (Array.isArray(rec.f)) {
    counts.rows += rec.f.length;
    counts.steps += rec.f.length;
    const marker = rec.f.some((row: unknown) =>
      Array.isArray(row) && typeof row[0] === "string" && isProjectMarkerName(row[0]));
    if (marker) noteProject(acc, rec.k);
  }
  if (Array.isArray(rec.d)) {
    counts.rows += rec.d.length;
    counts.steps += rec.d.length;
    for (const row of rec.d as unknown[]) {
      if (!Array.isArray(row) || row.length < 3) continue;
      const [path, size, files] = row;
      if (typeof path !== "string" || typeof size !== "number" || typeof files !== "number") continue;
      noteDirectoryRoot(acc, path, size, files);
    }
  }
  return true;
}

/**
 * Returns null when the file is missing, unreadable, or has no folder
 * entries. Pass `stats` to get the counts back from a completed read.
 */
export async function sidecarFromFolderTreeFile(
  filePath: string,
  treeRoot: string,
  stats?: FolderTreeClassifyStats,
  maxLineBytes = MAX_FOLDER_TREE_LINE_BYTES,
): Promise<DevArtifactSidecar | null> {
  if (!FS.existsSync(filePath)) return null;

  const counts: FolderTreeClassifyStats = {
    lines: 0,
    parsedLines: 0,
    skippedLines: 0,
    rows: 0,
    decodedRows: 0,
    retainedRoots: 0,
    retainedProjects: 0,
    steps: 0,
  };
  const acc = createDevAcc();
  const keepers = new LineKeepers();
  let parents = 0;

  const onLine = (buf: Buffer, start: number, end: number) => {
    if (end <= start) return;
    counts.lines += 1;
    counts.steps += 1;
    keepers.reset();
    const scanned = scanFolderTreeLine(buf, start, end, keepers);
    counts.rows += keepers.rows;
    counts.steps += keepers.rows;
    counts.decodedRows += keepers.decodedRows;
    if (scanned) {
      parents += 1;
      if (keepers.hasMarker) {
        noteProject(acc, decodeScannedString(buf, keepers.keyStart, keepers.keyEnd, keepers.keyEscapes));
      }
      for (const dir of keepers.dirs) noteDirectoryRoot(acc, dir.path, dir.size, dir.files);
      return;
    }
    counts.parsedLines += 1;
    if (noteParsedLine(acc, buf.toString("utf8", start, end), counts)) parents += 1;
  };

  const source = FS.createReadStream(filePath, { highWaterMark: 1 << 20 });
  const gunzip = createGunzip({ chunkSize: 1 << 20 });
  // pipeline() destroys both streams on any error, so the loop below
  // rejects instead of waiting on a stream that never ends.
  pipeline(source, gunzip, () => { /* surfaced by the for-await */ });

  try {
    // A line split across chunks. Joined once its newline arrives, so a
    // long line costs one copy, not one per chunk. Past maxLineBytes it is
    // dropped and the rest of it skipped up to the next newline.
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let skipping = false;
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      let start = 0;
      let nl = chunk.indexOf(NEWLINE);
      if (pending.length > 0 || skipping) {
        if (nl === -1) {
          if (!skipping) {
            pending.push(chunk);
            pendingBytes += chunk.length;
          }
          if (!skipping && pendingBytes > maxLineBytes) {
            skipping = true;
            pending = [];
            counts.skippedLines += 1;
          }
          continue;
        }
        if (!skipping && pendingBytes + nl <= maxLineBytes) {
          pending.push(chunk.subarray(0, nl));
          const line = Buffer.concat(pending);
          onLine(line, 0, line.length);
        } else if (!skipping) {
          counts.skippedLines += 1;
        }
        pending = [];
        pendingBytes = 0;
        skipping = false;
        start = nl + 1;
        nl = chunk.indexOf(NEWLINE, start);
      }
      for (; nl !== -1; nl = chunk.indexOf(NEWLINE, start)) {
        if (nl - start <= maxLineBytes) onLine(chunk, start, nl);
        else counts.skippedLines += 1;
        start = nl + 1;
      }
      if (start < chunk.length) {
        pending.push(Buffer.from(chunk.subarray(start)));
        pendingBytes = chunk.length - start;
        if (pendingBytes > maxLineBytes) {
          skipping = true;
          pending = [];
          counts.skippedLines += 1;
        }
      }
    }
    if (pending.length > 0 && !skipping) {
      const line = Buffer.concat(pending);
      onLine(line, 0, line.length);
    }
  } catch {
    return null;
  } finally {
    source.destroy();
    gunzip.destroy();
  }

  counts.retainedRoots = acc.artifacts.size;
  counts.retainedProjects = acc.projects.size;
  if (parents > 0) counts.steps += dropNestedRoots(acc);
  if (stats) Object.assign(stats, counts);
  return parents === 0 ? null : sidecarFromAcc(acc, treeRoot);
}
