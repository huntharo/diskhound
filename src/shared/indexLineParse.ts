/**
 * Parse one scan-index NDJSON line.
 *
 * Canonical writer shape (native IndexWriter / JSON.stringify({p,s,m})):
 *   {"p":"<escaped>","s":<size>,"m":<mtime>}
 *   {"p":"<escaped>","s":<size>,"m":<mtime>,"h":1}
 *   {"p":"<escaped>","t":"d","m":<mtime>}
 *
 * Optional suffixes follow in this fixed order after the optional `h`:
 *   ,"i":"<dev>:<ino>"     every name of a file with more than one
 *                          name (Unix); equal ids = one file
 *   ,"v":<private bytes>   APFS clone: what deleting it alone frees (< s)
 *   ,"k":1                 APFS clone: shares blocks with another file
 *
 * Fast path matches the folder-tree worker's FILE_LINE_RE spirit.
 * Odd field order falls back to JSON.parse. Does not change the
 * on-disk index format.
 */

import { unescapeJsonPath } from "./jsonPathUnescape";

export type ParsedIndexLine =
  | { t: "d"; p: string }
  | { t: "f"; p: string; s: number; m: number; h?: 1; i?: string; v?: number; k?: 1 };

const INDEX_FILE_LINE_RE =
  /^\{"p":"((?:\\.|[^"\\])*)","s":(\d+),"m":(\d+)(,"h":1)?(?:,"i":"(\d+:\d+)")?(?:,"v":(\d+))?(,"k":1)?\}$/;
const INDEX_DIR_LINE_RE = /^\{"p":"((?:\\.|[^"\\])*)","t":"d","m":(\d+)\}$/;

export function parseIndexLine(line: string): ParsedIndexLine | null {
  const fileMatch = INDEX_FILE_LINE_RE.exec(line);
  const filePath = fileMatch ? unescapeJsonPath(fileMatch[1]!) : null;
  if (fileMatch && filePath !== null) {
    return {
      t: "f",
      p: filePath,
      s: Number(fileMatch[2]),
      m: Number(fileMatch[3]),
      ...(fileMatch[4] ? { h: 1 as const } : {}),
      ...(fileMatch[5] !== undefined ? { i: fileMatch[5] } : {}),
      ...(fileMatch[6] !== undefined ? { v: Number(fileMatch[6]) } : {}),
      ...(fileMatch[7] ? { k: 1 as const } : {}),
    };
  }
  const dirMatch = INDEX_DIR_LINE_RE.exec(line);
  const dirPath = dirMatch ? unescapeJsonPath(dirMatch[1]!) : null;
  if (dirPath !== null) {
    return { t: "d", p: dirPath };
  }
  try {
    const rec = JSON.parse(line) as {
      p?: string; s?: number; m?: number; t?: string; h?: number; i?: string; v?: number; k?: number;
    };
    if (!rec || typeof rec.p !== "string") return null;
    if (rec.t === "d") return { t: "d", p: rec.p };
    if (typeof rec.s !== "number" || typeof rec.m !== "number") return null;
    return {
      t: "f",
      p: rec.p,
      s: rec.s,
      m: rec.m,
      ...(rec.h === 1 ? { h: 1 as const } : {}),
      ...(typeof rec.i === "string" && rec.i ? { i: rec.i } : {}),
      ...(typeof rec.v === "number" ? { v: rec.v } : {}),
      ...(rec.k === 1 ? { k: 1 as const } : {}),
    };
  } catch {
    return null;
  }
}
