import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveBundledWorkerScript } from "../bundledWorkerPath";

let tempDir: string;

beforeEach(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-worker-path-"));
});

afterEach(async () => {
  await FSP.rm(tempDir, { recursive: true, force: true });
});

describe("resolveBundledWorkerScript", () => {
  it("keeps the packed path when there is no asar", () => {
    const base = Path.join(tempDir, "dist-electron");
    expect(resolveBundledWorkerScript(base, "devArtifactsWorker.cjs"))
      .toBe(Path.join(base, "scan", "devArtifactsWorker.cjs"));
    expect(resolveBundledWorkerScript(base, "permanentDeleteWorker.cjs"))
      .toBe(Path.join(base, "scan", "permanentDeleteWorker.cjs"));
  });

  it("rewrites app.asar to app.asar.unpacked when the file is there", async () => {
    const packedScan = Path.join(tempDir, "resources", "app.asar", "dist-electron", "scan");
    const unpackedScan = Path.join(tempDir, "resources", "app.asar.unpacked", "dist-electron", "scan");
    await FSP.mkdir(unpackedScan, { recursive: true });
    await FSP.writeFile(Path.join(unpackedScan, "devArtifactsWorker.cjs"), "ok");
    const resolved = resolveBundledWorkerScript(
      Path.join(tempDir, "resources", "app.asar", "dist-electron"),
      "devArtifactsWorker.cjs",
    );
    expect(resolved).toBe(Path.join(unpackedScan, "devArtifactsWorker.cjs"));
    expect(FS.existsSync(resolved)).toBe(true);
    expect(FS.existsSync(packedScan)).toBe(false);
  });
});
