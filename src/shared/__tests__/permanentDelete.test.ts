import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inFlightDeleteBytes } from "../deleteProgress";
import {
  classifyPermanentDeleteError,
  isAccessDeniedFsError,
  permanentlyDeleteOnDisk,
  tryPermanentDelete,
} from "../permanentDelete";

let tempDir: string;

beforeEach(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-rm-test-"));
});

afterEach(async () => {
  await FSP.rm(tempDir, { recursive: true, force: true });
});

describe.each(["walk", "recursive"] as const)("permanentlyDeleteOnDisk (%s)", (method) => {
  it("recursively unlinks a nested tree", async () => {
    const tree = Path.join(tempDir, "node_modules");
    const nested = Path.join(tree, "pkg", "dist");
    await FSP.mkdir(nested, { recursive: true });
    await FSP.writeFile(Path.join(nested, "index.js"), "module.exports = 1\n");
    await FSP.writeFile(Path.join(tree, "readme"), "keep me not");

    await permanentlyDeleteOnDisk(tree, undefined, method);

    expect(FS.existsSync(tree)).toBe(false);
    expect(FS.existsSync(nested)).toBe(false);
  });

  it("treats an already-missing path as success", async () => {
    await expect(permanentlyDeleteOnDisk(Path.join(tempDir, "gone"), undefined, method)).resolves.toBeUndefined();
  });

  it("unlinks a symlink without deleting the target", async () => {
    const target = Path.join(tempDir, "real.txt");
    const link = Path.join(tempDir, "alias.txt");
    await FSP.writeFile(target, "keep");
    try {
      await FSP.symlink(target, link);
    } catch {
      // Windows needs Developer Mode or admin for file symlinks.
      return;
    }

    await permanentlyDeleteOnDisk(link, undefined, method);

    expect(FS.existsSync(link)).toBe(false);
    expect(await FSP.readFile(target, "utf8")).toBe("keep");
  });

  it("does not follow a Windows directory junction into the target", async () => {
    if (process.platform !== "win32") return;
    const real = Path.join(tempDir, "store");
    const junction = Path.join(tempDir, "node_modules-pkg");
    await FSP.mkdir(real);
    await FSP.writeFile(Path.join(real, "pkg.json"), "{\"ok\":true}");
    const result = spawnSync("cmd.exe", ["/c", "mklink", "/J", junction, real], {
      windowsHide: true,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      // Some CI images block mklink /J.
      return;
    }

    await permanentlyDeleteOnDisk(junction, undefined, method);

    expect(FS.existsSync(junction)).toBe(false);
    expect(await FSP.readFile(Path.join(real, "pkg.json"), "utf8")).toBe("{\"ok\":true}");
  });

  it("emits current path while walking a tree", async () => {
    const tree = Path.join(tempDir, "node_modules");
    const nested = Path.join(tree, "pkg", "dist");
    await FSP.mkdir(nested, { recursive: true });
    await FSP.writeFile(Path.join(nested, "index.js"), "module.exports = 1\n");

    const seen: string[] = [];
    let lastWalked = 0;
    await permanentlyDeleteOnDisk(tree, (progress) => {
      seen.push(progress.path);
      lastWalked = progress.filesWalked;
    }, method);

    expect(FS.existsSync(tree)).toBe(false);
    expect(seen[0]).toBe(Path.resolve(tree));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    if (method === "walk") expect(lastWalked).toBeGreaterThanOrEqual(2);
    else expect(lastWalked).toBe(0); // rm has no per-file progress; never fabricate it.
  });

  it("removes a read-only file in a tree", async () => {
    const tree = Path.join(tempDir, "cache");
    const file = Path.join(tree, "lock");
    await FSP.mkdir(tree);
    await FSP.writeFile(file, "ro");
    await FSP.chmod(file, 0o444);

    await permanentlyDeleteOnDisk(tree, undefined, method);

    expect(FS.existsSync(tree)).toBe(false);
  });

  it("removes nested directory links without touching an outside tree", async () => {
    const tree = Path.join(tempDir, "target");
    const outside = Path.join(tempDir, "outside");
    await FSP.mkdir(tree);
    await FSP.mkdir(outside);
    const sentinel = Path.join(outside, "keep.txt");
    await FSP.writeFile(sentinel, "keep outside data");
    // Junction creation does not need Windows Developer Mode.
    await FSP.symlink(outside, Path.join(tree, "link"), process.platform === "win32" ? "junction" : "dir");

    await permanentlyDeleteOnDisk(tree, undefined, method);

    expect(FS.existsSync(tree)).toBe(false);
    expect(await FSP.readFile(sentinel, "utf8")).toBe("keep outside data");
  });

  it("removes a root directory link without touching the target", async () => {
    const outside = Path.join(tempDir, "outside");
    const link = Path.join(tempDir, "link");
    await FSP.mkdir(outside);
    await FSP.writeFile(Path.join(outside, "keep.txt"), "keep");
    await FSP.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");

    await permanentlyDeleteOnDisk(link, undefined, method);

    await expect(FSP.lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await FSP.readFile(Path.join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  it("removes a dangling directory link", async () => {
    const target = Path.join(tempDir, "outside");
    const link = Path.join(tempDir, "dangling");
    await FSP.mkdir(target);
    await FSP.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    await FSP.rmdir(target);

    await permanentlyDeleteOnDisk(link, undefined, method);

    await expect(FSP.lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves other names of hard-linked files intact", async () => {
    const outside = Path.join(tempDir, "keep.txt");
    const tree = Path.join(tempDir, "target");
    await FSP.mkdir(tree);
    await FSP.writeFile(outside, "keep");
    await FSP.link(outside, Path.join(tree, "linked.txt"));

    await permanentlyDeleteOnDisk(tree, undefined, method);

    expect(await FSP.readFile(outside, "utf8")).toBe("keep");
  });
});

describe("inFlightDeleteBytes", () => {
  it("counts the current tree size so the banner is not 0 B", () => {
    expect(inFlightDeleteBytes(0, 15_700_000_000)).toBe(15_700_000_000);
    expect(inFlightDeleteBytes(1_000, 500)).toBe(1_500);
    expect(inFlightDeleteBytes(0, 0)).toBe(0);
  });
});

describe("tryPermanentDelete", () => {
  it("reports success when the tree is gone", async () => {
    const tree = Path.join(tempDir, "target");
    await FSP.mkdir(tree);
    await FSP.writeFile(Path.join(tree, "a"), "x");

    const result = await tryPermanentDelete(tree, false);

    expect(result).toEqual({ ok: true, message: "Permanently deleted." });
    expect(FS.existsSync(tree)).toBe(false);
  });
});

describe("classifyPermanentDeleteError", () => {
  it("flags access denied as needing elevation on Windows when not elevated", () => {
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    const result = classifyPermanentDeleteError(error, false, "C:\\proj\\node_modules");
    if (process.platform === "win32") {
      expect(result.ok).toBe(false);
      expect(result.requiresElevation).toBe(true);
      expect(result.message).toContain("not Recycle Bin");
    } else {
      expect(result.requiresElevation).toBeUndefined();
    }
  });

  it("does not offer elevation when already elevated", () => {
    const error = Object.assign(new Error("denied"), { code: "EPERM" });
    const result = classifyPermanentDeleteError(error, true, "C:\\proj\\node_modules");
    expect(result.ok).toBe(false);
    expect(result.requiresElevation).toBeUndefined();
  });

  it("recognizes EPERM and EACCES", () => {
    expect(isAccessDeniedFsError({ code: "EACCES" })).toBe(true);
    expect(isAccessDeniedFsError({ code: "EPERM" })).toBe(true);
    expect(isAccessDeniedFsError({ code: "EBUSY" })).toBe(false);
  });
});
