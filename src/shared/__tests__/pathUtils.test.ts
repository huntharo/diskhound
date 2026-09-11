import { describe, expect, it } from "vitest";

import { formatScanRoot, normPath } from "../pathUtils";

describe("normPath", () => {
  it("lowercases Windows paths while trimming trailing separators", () => {
    expect(normPath("C:\\Users\\Test\\", "win32")).toBe("c:\\users\\test");
    expect(normPath("C:\\Users\\Test\\\\", "win32")).toBe("c:\\users\\test");
  });

  it("preserves case on case-sensitive platforms while trimming trailing separators", () => {
    expect(normPath("/Users/Test/", "darwin")).toBe("/Users/Test");
    expect(normPath("/tmp/Foo//", "linux")).toBe("/tmp/Foo");
  });

  it("keeps existing casing when no trailing separator is present", () => {
    expect(normPath("/Data/MixedCase", "linux")).toBe("/Data/MixedCase");
    expect(normPath("D:\\Mixed\\Case", "win32")).toBe("d:\\mixed\\case");
  });
});

describe("formatScanRoot", () => {
  it("collapses a Windows drive root to the letter", () => {
    expect(formatScanRoot("C:\\")).toBe("C:");
    expect(formatScanRoot("c:")).toBe("C:");
    expect(formatScanRoot("D:\\")).toBe("D:");
  });

  it("keeps folder roots and Unix paths", () => {
    expect(formatScanRoot("C:\\Users\\thoma")).toBe("C:\\Users\\thoma");
    expect(formatScanRoot("/home/dev")).toBe("/home/dev");
    expect(formatScanRoot("/")).toBe("/");
  });
});
