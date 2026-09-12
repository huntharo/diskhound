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

describe("permanentlyDeleteOnDisk", () => {
  it("recursively unlinks a nested tree", async () => {
    const tree = Path.join(tempDir, "node_modules");
    const nested = Path.join(tree, "pkg", "dist");
    await FSP.mkdir(nested, { recursive: true });
    await FSP.writeFile(Path.join(nested, "index.js"), "module.exports = 1\n");
    await FSP.writeFile(Path.join(tree, "readme"), "keep me not");

    await permanentlyDeleteOnDisk(tree);

    expect(FS.existsSync(tree)).toBe(false);
    expect(FS.existsSync(nested)).toBe(false);
  });

  it("treats an already-missing path as success", async () => {
    await expect(permanentlyDeleteOnDisk(Path.join(tempDir, "gone"))).resolves.toBeUndefined();
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

    await permanentlyDeleteOnDisk(link);

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

    await permanentlyDeleteOnDisk(junction);

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
    });

    expect(FS.existsSync(tree)).toBe(false);
    expect(seen[0]).toBe(Path.resolve(tree));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(lastWalked).toBeGreaterThanOrEqual(2);
  });

  it("removes a read-only file in a tree", async () => {
    const tree = Path.join(tempDir, "cache");
    const file = Path.join(tree, "lock");
    await FSP.mkdir(tree);
    await FSP.writeFile(file, "ro");
    await FSP.chmod(file, 0o444);

    await permanentlyDeleteOnDisk(tree);

    expect(FS.existsSync(tree)).toBe(false);
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
