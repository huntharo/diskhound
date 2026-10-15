import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentTrashRefusal, canonicalPath, configuredTrashGuard, outermostPaths } from "../trashGuard";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));

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

  it("protects descendants and ancestors of exclusions with symlinked parents", async () => {
    const excluded = Path.join(dir, "PhotosLink", "2020");
    const guard = await configuredTrashGuard([excluded]);
    const requested = Path.join(excluded, "file.jpg");
    FS.writeFileSync(requested, "photo");
    const target = await canonicalPath(requested);
    expect(guard(requested, target)).toContain("Protected folder");
    expect(guard(target, target)).toContain("Protected folder");
    expect(guard(Path.join(dir, "Photos"), Path.join(dir, "Photos"))).toContain("contains");
    expect(guard(Path.join(dir, "Photos", "2021"), Path.join(dir, "Photos", "2021"))).toBeNull();
  });

  it("resolves a protected alias itself and preserves original-path protections", async () => {
    const alias = Path.join(dir, "PhotosLink");
    const target = Path.join(dir, "Photos", "2020");
    const guard = await configuredTrashGuard([alias]);
    expect(guard(target, target)).toContain("Protected folder");
    expect(guard(alias, await canonicalPath(alias))).toContain("Protected folder");
    const missing = Path.join(alias, "missing");
    const missingGuard = await configuredTrashGuard([missing]);
    expect(missingGuard(missing, Path.join(dir, "Photos", "missing"))).toContain("Protected folder");
  });

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


describe("configured protections scaling", () => {
  it("resolves each exclusion once per batch and scales with folder count", async () => {
    async function measure(n: number) {
      let operations = 0;
      const folders = new Proxy(Array.from({ length: n }, (_, i) => `/protected/${i}`), {
        get(target, property, receiver) { operations++; return Reflect.get(target, property, receiver); },
      });
      const realpath = vi.spyOn(FSP, "realpath").mockImplementation(async (path) => {
        operations++;
        return String(path);
      });
      try {
        const guard = await configuredTrashGuard(folders);
        // MCP limits a Trash batch to 20 targets, independent of exclusions.
        for (let i = 0; i < 20; i++) expect(guard(`/allowed/${i}`, `/allowed/${i}`)).toBeNull();
        expect(realpath).toHaveBeenCalledTimes(n);
        return operations;
      } finally { realpath.mockRestore(); }
    }
    const small = await measure(128);
    const large = await measure(1024);
    expect(large).toBeLessThanOrEqual(small * 16);
    expect(large).toBeLessThanOrEqual(200_000);
  });
});
