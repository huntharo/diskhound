import { unescapeJsonPath } from "./jsonPathUnescape";

/**
 * Walk one folder-tree sidecar line in place, without making strings.
 *
 * Both writers emit one fixed layout (native `append_folder_tree_line`
 * and Node `JSON.stringify({ k, d, f })`):
 *   {"k":"<parent>","d":[["<path>",size,fileCount],...],"f":[["<name>",size,mtime],...]}
 *
 * The scanner takes exactly that layout and hands each string's raw JSON
 * bytes to a visitor. It checks everything JSON.parse would on the way:
 * escapes, raw control bytes, number syntax, and that `}` ends the line.
 * So a line it accepts parses to the same values, and a line it rejects
 * either fails JSON.parse too or uses another layout (key order,
 * whitespace). Callers hand those to JSON.parse.
 *
 * Rows reach the visitor as they are scanned, before the line is known
 * to be valid, so buffer them until this returns true.
 */

/** No escapes: the raw bytes are the string's UTF-8. */
export const ESCAPES_NONE = 0;
/** Only `\\`: every raw backslash byte is half of an escaped backslash. */
export const ESCAPES_BACKSLASH = 1;
/** Some other escape (`\"`, `\n`, `\u0001`): decode before comparing. */
export const ESCAPES_OTHER = 2;

export interface FolderTreeLineVisitor {
  /** The parent folder, `k`. `buf[start, end)` is the string between its quotes. */
  key(buf: Buffer, start: number, end: number, escapes: number): void;
  /** One `d` row: a child folder's path, recursive size and file count. */
  dir(buf: Buffer, start: number, end: number, escapes: number, size: number, fileCount: number): void;
  /** One `f` row: a file's name. */
  file(buf: Buffer, start: number, end: number, escapes: number): void;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const CLOSE_BRACE = 0x7d;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;
const ZERO = 0x30;
const NINE = 0x39;

const LINE_HEAD = Buffer.from('{"k":"', "latin1");
const DIRS_HEAD = Buffer.from(',"d":[', "latin1");
const FILES_HEAD = Buffer.from(',"f":[', "latin1");

/** Escape letters JSON allows after a backslash, besides `\\` and `\u`. */
const SIMPLE_ESCAPES = new Set([QUOTE, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74]);

// Side results of scanString and scanNumber, so the hot loop allocates nothing.
let stringEscapes = ESCAPES_NONE;
let numberValue = 0;

function isDigit(b: number | undefined): boolean {
  return b !== undefined && b >= ZERO && b <= NINE;
}

function isHex(b: number): boolean {
  return (b >= ZERO && b <= NINE) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
}

function bytesAt(buf: Buffer, i: number, end: number, literal: Buffer): boolean {
  if (i + literal.length > end) return false;
  for (let j = 0; j < literal.length; j++) {
    if (buf[i + j] !== literal[j]) return false;
  }
  return true;
}

/** From the byte after an opening quote to its closing quote's index, or -1. */
function scanString(buf: Buffer, i: number, end: number): number {
  let escapes = ESCAPES_NONE;
  while (i < end) {
    const b = buf[i]!;
    if (b === QUOTE) {
      stringEscapes = escapes;
      return i;
    }
    if (b < 0x20) return -1;
    if (b !== BACKSLASH) {
      i += 1;
      continue;
    }
    if (i + 1 >= end) return -1;
    const next = buf[i + 1]!;
    if (next === BACKSLASH) {
      if (escapes === ESCAPES_NONE) escapes = ESCAPES_BACKSLASH;
      i += 2;
      continue;
    }
    escapes = ESCAPES_OTHER;
    if (next === 0x75) {
      if (i + 6 > end) return -1;
      for (let j = i + 2; j < i + 6; j++) {
        if (!isHex(buf[j]!)) return -1;
      }
      i += 6;
      continue;
    }
    if (!SIMPLE_ESCAPES.has(next)) return -1;
    i += 2;
  }
  return -1;
}

/** One JSON number from `i`: the index after it, or -1. */
function scanNumber(buf: Buffer, i: number, end: number): number {
  const start = i;
  let plain = true;
  let value = 0;
  if (buf[i] === MINUS) {
    plain = false;
    i += 1;
  }
  if (i >= end || !isDigit(buf[i])) return -1;
  if (buf[i] === ZERO) {
    i += 1;
  } else {
    for (; i < end && isDigit(buf[i]); i++) value = value * 10 + (buf[i]! - ZERO);
  }
  if (i < end && buf[i] === DOT) {
    plain = false;
    i += 1;
    if (i >= end || !isDigit(buf[i])) return -1;
    while (i < end && isDigit(buf[i])) i += 1;
  }
  if (i < end && (buf[i] === 0x65 || buf[i] === 0x45)) {
    plain = false;
    i += 1;
    if (i < end && (buf[i] === PLUS || buf[i] === MINUS)) i += 1;
    if (i >= end || !isDigit(buf[i])) return -1;
    while (i < end && isDigit(buf[i])) i += 1;
  }
  // Up to 15 digits sum exactly in a double. Anything else goes through
  // the same decimal conversion JSON.parse uses.
  numberValue = plain && i - start <= 15 ? value : Number(buf.toString("latin1", start, i));
  return i;
}

/** `[["s",n,n],...]` from the byte after `[`: the index after `]`, or -1. */
function scanRows(
  buf: Buffer,
  i: number,
  end: number,
  visitor: FolderTreeLineVisitor,
  dirs: boolean,
): number {
  if (i < end && buf[i] === CLOSE_BRACKET) return i + 1;
  for (;;) {
    if (i + 1 >= end || buf[i] !== OPEN_BRACKET || buf[i + 1] !== QUOTE) return -1;
    const strStart = i + 2;
    const strEnd = scanString(buf, strStart, end);
    if (strEnd < 0) return -1;
    const escapes = stringEscapes;
    i = strEnd + 1;
    if (i >= end || buf[i] !== COMMA) return -1;
    i = scanNumber(buf, i + 1, end);
    if (i < 0 || i >= end || buf[i] !== COMMA) return -1;
    const first = numberValue;
    i = scanNumber(buf, i + 1, end);
    if (i < 0 || i >= end || buf[i] !== CLOSE_BRACKET) return -1;
    const second = numberValue;
    i += 1;
    if (dirs) visitor.dir(buf, strStart, strEnd, escapes, first, second);
    else visitor.file(buf, strStart, strEnd, escapes);
    if (i >= end) return -1;
    if (buf[i] === CLOSE_BRACKET) return i + 1;
    if (buf[i] !== COMMA) return -1;
    i += 1;
  }
}

/** Scan `buf[start, end)`, one line without its newline. False: not the canonical layout. */
export function scanFolderTreeLine(
  buf: Buffer,
  start: number,
  end: number,
  visitor: FolderTreeLineVisitor,
): boolean {
  if (!bytesAt(buf, start, end, LINE_HEAD)) return false;
  const keyStart = start + LINE_HEAD.length;
  const keyEnd = scanString(buf, keyStart, end);
  if (keyEnd < 0) return false;
  visitor.key(buf, keyStart, keyEnd, stringEscapes);
  let i = keyEnd + 1;
  if (!bytesAt(buf, i, end, DIRS_HEAD)) return false;
  i = scanRows(buf, i + DIRS_HEAD.length, end, visitor, true);
  if (i < 0 || !bytesAt(buf, i, end, FILES_HEAD)) return false;
  i = scanRows(buf, i + FILES_HEAD.length, end, visitor, false);
  return i >= 0 && i + 1 === end && buf[i] === CLOSE_BRACE;
}

/** A string the scanner reported, decoded as JSON.parse would. */
export function decodeScannedString(buf: Buffer, start: number, end: number, escapes: number): string {
  const raw = buf.toString("utf8", start, end);
  if (escapes === ESCAPES_NONE) return raw;
  // The scanner already rejected escapes JSON doesn't define.
  return unescapeJsonPath(raw)!;
}
