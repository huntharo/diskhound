import { describe, expect, it } from "vitest";

import { agentPath, isInside } from "../paths";

describe("isInside", () => {
  it("accepts the root itself and anything below it", () => {
    expect(isInside("/Users/test", "/Users/test")).toBe(true);
    expect(isInside("/Users/test", "/Users/test/")).toBe(true);
    expect(isInside("/Users/test/", "/Users/test/Downloads/a.iso")).toBe(true);
  });

  it("is separator-aware, so a sibling with the same prefix is outside", () => {
    expect(isInside("/Users/a", "/Users/ab")).toBe(false);
    expect(isInside("/Users/a", "/Users/ab/c")).toBe(false);
    expect(isInside("/Users/test", "/Users")).toBe(false);
  });

  it("treats a POSIX filesystem root as containing every absolute path", () => {
    expect(isInside("/", "/")).toBe(true);
    expect(isInside("/", "/Users/test")).toBe(true);
    expect(isInside("/", "C:\\Users")).toBe(false);
  });

  it("handles Windows drive roots and backslash separators", () => {
    expect(isInside("C:\\", "C:\\Users\\test")).toBe(true);
    expect(isInside("C:\\Users", "C:\\Users\\test\\AppData")).toBe(true);
    expect(isInside("C:\\Users", "C:\\Users2")).toBe(false);
    expect(isInside("C:\\", "D:\\data")).toBe(false);
  });

  it.runIf(process.platform === "win32")("ignores case on Windows", () => {
    expect(isInside("C:\\Users\\Test", "c:\\users\\test\\file.txt")).toBe(true);
  });
});

describe("agentPath", () => {
  it("normalizes absolute POSIX paths", () => {
    expect(agentPath("/Users/test/Downloads/../Desktop/", "darwin")).toBe("/Users/test/Desktop");
  });

  it("expands ~ to the home folder", () => {
    expect(agentPath("~", "linux", "/home/test")).toBe("/home/test");
    expect(agentPath("~/Downloads", "darwin", "/Users/test")).toBe("/Users/test/Downloads");
    expect(agentPath("~\\Downloads", "win32", "C:\\Users\\test")).toBe("C:\\Users\\test\\Downloads");
  });

  it("refuses relative paths", () => {
    expect(() => agentPath("Downloads", "darwin")).toThrow(/absolute path/);
    expect(() => agentPath("./a", "linux")).toThrow(/absolute path/);
    expect(() => agentPath("Downloads", "win32")).toThrow(/absolute path/);
  });

  it("turns a bare drive letter into the drive root on Windows", () => {
    expect(agentPath("C:", "win32")).toBe("C:\\");
    expect(agentPath("d:\\", "win32")).toBe("d:\\");
    expect(agentPath("C:/Users/test", "win32")).toBe("C:\\Users\\test");
  });

  it("refuses drive-relative Windows paths but keeps UNC paths", () => {
    expect(() => agentPath("\\Users\\test", "win32")).toThrow(/absolute path/);
    expect(() => agentPath("C:Users", "win32")).toThrow(/absolute path/);
    expect(agentPath("\\\\server\\share\\dir", "win32")).toBe("\\\\server\\share\\dir");
  });
});
