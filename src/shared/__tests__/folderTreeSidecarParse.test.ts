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

  it("returns null for garbage and missing keys", () => {
    expect(parseFolderTreeSidecarLine("not json")).toBeNull();
    expect(parseFolderTreeSidecarLine('{"d":[],"f":[]}')).toBeNull();
  });
});
