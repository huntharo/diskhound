/**
 * Parse one scan-index NDJSON line.
 *
 * Canonical writer shape (native IndexWriter / JSON.stringify({p,s,m})):
 *   {"p":"<escaped>","s":<size>,"m":<mtime>}
 *   {"p":"<escaped>","s":<size>,"m":<mtime>,"h":1}
 *   {"p":"<escaped>","t":"d","m":<mtime>}
 *
 * macOS APFS clones append, in this order after the optional `h`:
 *   ,"v":<private bytes>   what deleting this file alone frees (< s)
 *   ,"k":1                 the file shares blocks with a clone
 *
 * Fast path matches the folder-tree worker's FILE_LINE_RE spirit.
 * Odd field order falls back to JSON.parse. Does not change the
 * on-disk index format.
 */

export type ParsedIndexLine =
  | { t: "d"; p: string }
  | { t: "f"; p: string; s: number; m: number; h?: 1; v?: number; k?: 1 };

const INDEX_FILE_LINE_RE =
  /^\{"p":"((?:\\.|[^"\\])*)","s":(\d+),"m":(\d+)(,"h":1)?(?:,"v":(\d+))?(,"k":1)?\}$/;
const INDEX_DIR_LINE_RE = /^\{"p":"((?:\\.|[^"\\])*)","t":"d","m":(\d+)\}$/;

function unescapeIndexPath(escaped: string): string {
  return escaped.indexOf("\\") === -1
    ? escaped
    : escaped.replace(/\\\\/g, "\\").replace(/\\"/g, '"');
}

export function parseIndexLine(line: string): ParsedIndexLine | null {
  const fileMatch = INDEX_FILE_LINE_RE.exec(line);
  if (fileMatch) {
    return {
      t: "f",
      p: unescapeIndexPath(fileMatch[1]!),
      s: Number(fileMatch[2]),
      m: Number(fileMatch[3]),
      ...(fileMatch[4] ? { h: 1 as const } : {}),
      ...(fileMatch[5] !== undefined ? { v: Number(fileMatch[5]) } : {}),
      ...(fileMatch[6] ? { k: 1 as const } : {}),
    };
  }
  const dirMatch = INDEX_DIR_LINE_RE.exec(line);
  if (dirMatch) {
    return { t: "d", p: unescapeIndexPath(dirMatch[1]!) };
  }
  try {
    const rec = JSON.parse(line) as {
      p?: string; s?: number; m?: number; t?: string; h?: number; v?: number; k?: number;
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
      ...(typeof rec.v === "number" ? { v: rec.v } : {}),
      ...(rec.k === 1 ? { k: 1 as const } : {}),
    };
  } catch {
    return null;
  }
}
