import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { afterPack, afterSign } from "./macos-packaging.mjs";

const mac = process.platform === "darwin";
afterEach(() => vi.unstubAllEnvs());

function context(root, identity = "-") {
  return {
    electronPlatformName: "darwin", appOutDir: root,
    packager: {
      appInfo: { id: "com.diskhound.app", version: "0.6.2", productFilename: "DiskHound" },
      info: { framework: { version: "40.6.0" } },
      platformSpecificBuildOptions: { identity },
    },
  };
}

it("leaves Windows and Linux packaging alone", async () => {
  for (const electronPlatformName of ["win32", "linux"]) {
    await afterPack({ electronPlatformName });
    await afterSign({ electronPlatformName });
  }
});

it("rejects disabled signing before touching the executable", async () => {
  await expect(afterPack(context("/does-not-exist", null))).rejects.toThrow("requires signing");
  vi.stubEnv("GITHUB_BASE_REF", "main");
  vi.stubEnv("CSC_FOR_PULL_REQUEST", "false");
  await expect(afterPack(context("/does-not-exist"))).rejects.toThrow("requires signing");
});

describe.skipIf(!mac)("real macOS launcher signatures", () => {
  it.each(["arm64", "x86_64", "universal"])("re-signs %s and verifies every slice, then remains idempotent", async (arch) => {
    // This test uses only locally compiled fixtures and ad-hoc codesign. It
    // never invokes builder's signing/certificate discovery or launches code.
    vi.stubEnv("CSC_FOR_PULL_REQUEST", "true");
    const root = await mkdtemp(path.join(os.tmpdir(), "diskhound-uuid-"));
    try {
      const app = path.join(root, "DiskHound.app");
      const executable = path.join(app, "Contents/MacOS/DiskHound");
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(path.join(root, "main.c"), "int main(void) { return 0; }\n");
      await writeFile(path.join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.diskhound.app</string>
<key>CFBundleExecutable</key><string>DiskHound</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
      const arches = arch === "universal" ? ["arm64", "x86_64"] : [arch];
      for (const cpu of arches) {
        execFileSync("/usr/bin/clang", ["-arch", cpu, path.join(root, "main.c"), "-o", path.join(root, cpu)]);
      }
      execFileSync("/usr/bin/lipo", ["-create", ...arches.map(cpu => path.join(root, cpu)), "-output", executable]);
      const sign = () => execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], { stdio: "pipe" });
      const verify = () => execFileSync("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", app], { stdio: "pipe" });
      sign();
      verify();
      const original = await readFile(executable);
      await afterPack(context(root));
      expect(await readFile(executable)).not.toEqual(original);
      expect(verify).toThrow(); // Rewriting LC_UUID really invalidates the seal.
      await expect(afterSign(context(root))).rejects.toThrow();
      sign();
      await afterSign(context(root));
      const otherVersion = context(root);
      otherVersion.packager.appInfo.version = "0.6.3";
      await expect(afterSign(otherVersion)).rejects.toThrow("expected DiskHound UUIDs");
      const signed = await readFile(executable);
      const before = await stat(executable);
      await afterPack(context(root)); // Universal afterPack repeats on merged code.
      await afterSign(context(root));
      expect(await readFile(executable)).toEqual(signed);
      expect((await stat(executable)).mtimeMs).toBe(before.mtimeMs);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
