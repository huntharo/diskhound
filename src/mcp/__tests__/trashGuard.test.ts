import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agentTrashRefusal, canonicalPath, outermostPaths } from "../trashGuard";

describe("canonicalPath", () => {
  let dir: string;

  beforeEach(() => {
    // .native, like canonicalPath: it also expands Windows 8.3 names
    // such as RUNNER~1, which the JS realpath leaves alone.
    dir = FS.realpathSync.native(FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-trash-guard-")));
    FS.mkdirSync(Path.join(dir, "Photos", "2020"), { recursive: true });
    FS.symlinkSync(Path.join(dir, "Photos"), Path.join(dir, "PhotosLink"));
  });

  afterEach(() => {
    FS.rmSync(dir, { recursive: true, force: true });
  });

  it("resolves symlinks in parent folders", async () => {
    expect(await canonicalPath(Path.join(dir, "PhotosLink", "2020"))).toBe(Path.join(dir, "Photos", "2020"));
  });

  it("keeps a symlink itself, since trashing it moves only the link", async () => {
    expect(await canonicalPath(Path.join(dir, "PhotosLink"))).toBe(Path.join(dir, "PhotosLink"));
  });

  it.runIf(process.platform === "darwin" || process.platform === "win32")(
    "restores on-disk letter case on case-insensitive volumes",
    async () => {
      expect(await canonicalPath(Path.join(dir, "photos", "2020"))).toBe(Path.join(dir, "Photos", "2020"));
      expect(await canonicalPath(Path.join(dir, "photoslink"))).toBe(Path.join(dir, "PhotosLink"));
    },
  );

  it("throws when nothing exists at the path", async () => {
    await expect(canonicalPath(Path.join(dir, "missing"))).rejects.toThrow();
  });
});

describe("agentTrashRefusal", () => {
  const keep = ["/Users/test", "/Users/test/Documents", "/Users/test/Library", "/Users"];

  it("allows ordinary paths, including ones inside kept folders", () => {
    expect(agentTrashRefusal("/Users/test/Documents/old.zip", keep, "darwin")).toBeNull();
    expect(agentTrashRefusal("/Users/test/github/app/node_modules", keep, "darwin")).toBeNull();
    expect(agentTrashRefusal("/opt/cache", keep, "linux")).toBeNull();
  });

  it("refuses a kept folder itself, ignoring case on macOS", () => {
    expect(agentTrashRefusal("/Users/test/Documents", keep, "darwin")).toContain("never");
    expect(agentTrashRefusal("/users/test/documents/", keep, "darwin")).toContain("never");
  });

  it("refuses anything that contains a kept folder", () => {
    expect(agentTrashRefusal("/Users", ["/Users/test"], "darwin")).toBe("it contains /Users/test");
  });

  it("is case-sensitive on Linux", () => {
    expect(agentTrashRefusal("/home/Test", ["/home/test"], "linux")).toBeNull();
  });

  it("refuses drive roots", () => {
    expect(agentTrashRefusal("/", [], "linux")).toBe("it is a drive root");
    expect(agentTrashRefusal("D:\\", [], "win32")).toBe("it is a drive root");
  });

  it("refuses network and device paths on Windows", () => {
    expect(agentTrashRefusal("\\\\localhost\\C$\\Windows", [], "win32")).toContain("network");
    expect(agentTrashRefusal("\\\\?\\C:\\Windows", [], "win32")).toContain("network");
  });

  it("compares Windows paths case-insensitively", () => {
    expect(agentTrashRefusal("c:\\users\\test\\appdata", ["C:\\Users\\test\\AppData"], "win32")).toContain("never");
    expect(agentTrashRefusal("C:\\Users\\test\\AppData\\Local\\Temp\\x", ["C:\\Users\\test\\AppData"], "win32")).toBeNull();
  });
});

describe("outermostPaths", () => {
  it("drops duplicates and paths inside another requested path", () => {
    expect(outermostPaths(["/a/b", "/a", "/a/b/c", "/ab", "/a"], "linux")).toEqual(["/a", "/ab"]);
  });

  it("matches case-insensitively on macOS", () => {
    expect(outermostPaths(["/Users/test/Build", "/users/test/build/out"], "darwin")).toEqual(["/Users/test/Build"]);
  });
});
