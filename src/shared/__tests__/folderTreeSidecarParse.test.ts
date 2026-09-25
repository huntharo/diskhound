import { describe, expect, it } from "vitest";

import { parseFolderTreeSidecarLine } from "../folderTreeSidecarParse";

describe("parseFolderTreeSidecarLine", () => {
  it("parses the canonical writer shape with escaped Windows paths", () => {
    const line = JSON.stringify({
      k: "C:\\Users",
      d: [["C:\\Users\\foo", 100, 2]],
      f: [["a.txt", 50, 1234]],
    });
    expect(parseFolderTreeSidecarLine(line)).toEqual({
      key: "C:\\Users",
      dirs: [{ path: "C:\\Users\\foo", size: 100, fileCount: 2 }],
      files: [{ name: "a.txt", size: 50, modifiedAt: 1234 }],
    });
  });

  it("parses empty dir and file arrays", () => {
    const line = '{"k":"c:\\\\empty","d":[],"f":[]}';
    expect(parseFolderTreeSidecarLine(line)).toEqual({
      key: "c:\\empty",
      dirs: [],
      files: [],
    });
  });

  it("decodes every escape the native writer emits on the fast path", () => {
    // append_folder_tree_line escapes k, d paths and f names with
    // append_json_escaped: \" \\ \n \r \t, other control chars as \u00XX.
    const path = 'C:\\odd "dir"\\a\tb\nc\rd\u0001e.bin';
    const line = JSON.stringify({ k: path, d: [[path, 1, 2]], f: [["x\ty\u0001.bin", 3, 4]] });
    expect(line).toContain("\\u0001");
    expect(line.startsWith('{"k":"')).toBe(true);
    expect(parseFolderTreeSidecarLine(line)).toEqual({
      key: path,
      dirs: [{ path, size: 1, fileCount: 2 }],
      files: [{ name: "x\ty\u0001.bin", size: 3, modifiedAt: 4 }],
    });
  });

  it("falls back to JSON.parse for odd field order", () => {
    const line = JSON.stringify({
      f: [["z.bin", 9, 1]],
      k: "D:\\proj",
      d: [["D:\\proj\\src", 9, 1]],
    });
    expect(line.startsWith('{"k":"')).toBe(false);
    expect(parseFolderTreeSidecarLine(line)).toEqual({
      key: "D:\\proj",
      dirs: [{ path: "D:\\proj\\src", size: 9, fileCount: 1 }],
      files: [{ name: "z.bin", size: 9, modifiedAt: 1 }],
    });
  });

  it("decodes control-character escapes the way JSON.parse does", () => {
    // Native writes \u0008 where JSON.stringify writes \b; both decode.
    const line = '{"k":"/tmp/a\\nb","d":[["/tmp/a\\nb/c\\u0008d\\\\n",1,1]],"f":[["t\\tab\\"q",2,3]]}';
    expect(parseFolderTreeSidecarLine(line)).toEqual({
      key: "/tmp/a\nb",
      dirs: [{ path: "/tmp/a\nb/c\bd\\n", size: 1, fileCount: 1 }],
      files: [{ name: "t\tab\"q", size: 2, modifiedAt: 3 }],
    });
    expect(parseFolderTreeSidecarLine(line)).toEqual(
      (() => {
        const rec = JSON.parse(line);
        return {
          key: rec.k,
          dirs: [{ path: rec.d[0][0], size: 1, fileCount: 1 }],
          files: [{ name: rec.f[0][0], size: 2, modifiedAt: 3 }],
        };
      })(),
    );
  });

  it("returns null for garbage and missing keys", () => {
    expect(parseFolderTreeSidecarLine("not json")).toBeNull();
    expect(parseFolderTreeSidecarLine('{"d":[],"f":[]}')).toBeNull();
  });

  it("returns null for a canonical-shaped line with an invalid escape", () => {
    expect(parseFolderTreeSidecarLine('{"k":"c:\\\\a\\qb","d":[],"f":[]}')).toBeNull();
    expect(parseFolderTreeSidecarLine('{"k":"c:\\\\a","d":[],"f":[["x\\q",1,2]]}')).toBeNull();
  });
});
