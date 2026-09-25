import { describe, expect, it } from "vitest";

import { unescapeJsonPath } from "../jsonPathUnescape";

/** The body of the JSON string literal for `value`, as the writers emit it. */
const body = (value: string) => JSON.stringify(value).slice(1, -1);

describe("unescapeJsonPath", () => {
  it("returns strings without a backslash unchanged", () => {
    const plain = "/Users/a/b.txt";
    expect(unescapeJsonPath(plain)).toBe(plain);
  });

  it("decodes the escapes on ordinary paths", () => {
    for (const path of ["C:\\Users\\a.txt", '/x/"quoted"', 'C:\\a\\"b', "\\\\server\\share\\", "C:\\n\\t\\u0001"]) {
      expect(unescapeJsonPath(body(path))).toBe(path);
    }
  });

  it("decodes control characters from both writers", () => {
    // Native append_json_escaped writes \u0008; JSON.stringify writes \b.
    expect(unescapeJsonPath("a\\u0008b\\u000cc")).toBe("a\bb\fc");
    expect(unescapeJsonPath("a\\bb\\fc\\/d")).toBe("a\bb\fc/d");
    const path = 'C:\\odd "dir"\\a\tb\nc\rd\u0001e\u001f.bin';
    expect(unescapeJsonPath(body(path))).toBe(path);
  });

  it("returns null for an escape JSON does not define", () => {
    expect(unescapeJsonPath("C:\\\\a\\qb")).toBeNull();
    expect(unescapeJsonPath("a\\u12")).toBeNull();
  });
});
