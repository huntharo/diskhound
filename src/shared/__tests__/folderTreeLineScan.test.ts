import { describe, expect, it } from "vitest";

import {
  decodeScannedString,
  ESCAPES_BACKSLASH,
  ESCAPES_NONE,
  ESCAPES_OTHER,
  scanFolderTreeLine,
  type FolderTreeLineVisitor,
} from "../folderTreeLineScan";

interface Scanned {
  key: string;
  keyEscapes: number;
  dirs: Array<[string, number, number]>;
  files: string[];
}

/**
 * Scan `text` placed in the middle of a buffer, between bytes that would
 * extend a string or a row if the scanner read past the line's end.
 */
function scan(text: string): Scanned | null {
  const before = Buffer.from('"],[\\');
  const bytes = Buffer.from(text, "utf8");
  const after = Buffer.from('\\"]],"f":[]}\n');
  const buf = Buffer.concat([before, bytes, after]);
  const out: Scanned = { key: "", keyEscapes: -1, dirs: [], files: [] };
  const visitor: FolderTreeLineVisitor = {
    key(b, start, end, escapes) {
      out.key = decodeScannedString(b, start, end, escapes);
      out.keyEscapes = escapes;
    },
    dir(b, start, end, escapes, size, fileCount) {
      out.dirs.push([decodeScannedString(b, start, end, escapes), size, fileCount]);
    },
    file(b, start, end, escapes) {
      out.files.push(decodeScannedString(b, start, end, escapes));
    },
  };
  return scanFolderTreeLine(buf, before.length, before.length + bytes.length, visitor) ? out : null;
}

/** What JSON.parse makes of a line, in the scanner's shape, or null. */
function parsed(text: string): Scanned | null {
  let rec: { k: string; d: [string, number, number][]; f: [string, number, number][] };
  try {
    rec = JSON.parse(text);
  } catch {
    return null;
  }
  return {
    key: rec.k,
    keyEscapes: -1,
    dirs: rec.d.map(([path, size, files]) => [path, size, files]),
    files: rec.f.map(([name]) => name),
  };
}

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "a", "Z", "node_modules", "/", "\\", "\"", "\n", "\t", "\u0001", "\u001f", "\u007f",
  "é", "ñ", "\u212A", "😀", "\ud800", "\udc00", "\u2028", " ", ".", "-", "{", "]",
];
const NUMBERS = [0, -0, 1, 7, 42, 1_234_567, 2 ** 53 + 2, 1e21, 1700000000000.25, 1.5e-7, -3];

describe("scanFolderTreeLine", () => {
  it("reads what the writers emit the same as JSON.parse", () => {
    const random = mulberry32(1);
    const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
    const str = () => Array.from({ length: Math.floor(random() * 6) }, () => pick(PIECES)).join("");
    for (let i = 0; i < 3_000; i++) {
      const rows = () => Array.from({ length: Math.floor(random() * 4) }, () => [str(), pick(NUMBERS), pick(NUMBERS)]);
      const text = JSON.stringify({ k: str(), d: rows(), f: rows() });
      const got = scan(text);
      expect(got, text).not.toBeNull();
      expect({ ...got!, keyEscapes: -1 }, text).toEqual(parsed(text));
    }
  });

  it("accepts only lines JSON.parse accepts, with the same values", () => {
    const random = mulberry32(2);
    const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
    const bytes = ['"', "\\", ",", "[", "]", "{", "}", "0", "9", "-", "+", ".", "e", "u", "x", " ", "\u0001", "\u00e9"];
    let accepted = 0;
    for (let i = 0; i < 20_000; i++) {
      const text = JSON.stringify({
        k: pick(["/a", "C:\\x", "q\"t", "\u0002"]),
        d: [[pick(["/a/node_modules", "b\\c", "t\tb"]), pick(NUMBERS), pick(NUMBERS)]],
        f: [[pick(["package.json", "x"]), pick(NUMBERS), pick(NUMBERS)]],
      });
      const at = Math.floor(random() * (text.length + 1));
      const edit = Math.floor(random() * 4);
      const mutated =
        edit === 0 ? text.slice(0, at) + text.slice(at + 1)
        : edit === 1 ? text.slice(0, at) + pick(bytes) + text.slice(at)
        : edit === 2 ? text.slice(0, at) + pick(bytes) + text.slice(at + 1)
        : text.slice(0, at);
      const got = scan(mutated);
      if (!got) continue;
      accepted += 1;
      expect({ ...got, keyEscapes: -1 }, mutated).toEqual(parsed(mutated));
    }
    // Most edits break the line; some (a digit in a number, a letter in a
    // string) leave it valid, and those must still read the same.
    expect(accepted).toBeGreaterThan(1_000);
  });

  it("rejects what JSON.parse rejects", () => {
    for (const text of [
      `{"k":"/a","d":[["/a/b",01,1]],"f":[]}`,
      `{"k":"/a","d":[["/a/b",1.,1]],"f":[]}`,
      `{"k":"/a","d":[["/a/b",1e,1]],"f":[]}`,
      `{"k":"/a","d":[["/a/b",-,1]],"f":[]}`,
      `{"k":"/a","d":[["/a/b",+1,1]],"f":[]}`,
      `{"k":"/a\\x","d":[],"f":[]}`,
      `{"k":"/a\\u12","d":[],"f":[]}`,
      `{"k":"/a\\u12g4","d":[],"f":[]}`,
      `{"k":"/a\u0001","d":[],"f":[]}`,
      `{"k":"/a","d":[],"f":[]}}`,
      `{"k":"/a","d":[],"f":[]`,
      `{"k":"/a","d":[,],"f":[]}`,
      `{"k":"/a","d":[["/a/b",1,1],],"f":[]}`,
    ]) {
      expect(parsed(text), text).toBeNull();
      expect(scan(text), text).toBeNull();
    }
  });

  it("leaves other layouts to JSON.parse", () => {
    for (const text of [
      `{"d":[],"k":"/a","f":[]}`,
      `{ "k":"/a","d":[],"f":[]}`,
      `{"k":"/a","d":[],"f":[]} `,
      `{"k":"/a","d":[["/a/b",1,1,0]],"f":[]}`,
      `{"k":"/a","d":[]}`,
    ]) {
      expect(() => JSON.parse(text), text).not.toThrow();
      expect(scan(text), text).toBeNull();
    }
  });

  it("says which escapes a string has", () => {
    expect(scan(JSON.stringify({ k: "/plain/é", d: [], f: [] }))?.keyEscapes).toBe(ESCAPES_NONE);
    expect(scan(JSON.stringify({ k: "C:\\Users", d: [], f: [] }))?.keyEscapes).toBe(ESCAPES_BACKSLASH);
    expect(scan(JSON.stringify({ k: "C:\\a\"b", d: [], f: [] }))?.keyEscapes).toBe(ESCAPES_OTHER);
    expect(scan(JSON.stringify({ k: "a\nb\\c", d: [], f: [] }))?.keyEscapes).toBe(ESCAPES_OTHER);
  });
});
