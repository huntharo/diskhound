import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveBundledWorkerScript } from "../bundledWorkerPath";
import { runPermanentDeleteWorker } from "../permanentDeleteWorkerRuntime";

const repoRoot = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "../../..");

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

describe("packaged scan workers", () => {
  it("builds each scan worker as a single entry without code splitting", () => {
    const config = FS.readFileSync(Path.join(repoRoot, "tsdown.config.ts"), "utf8");
    expect(config).toContain("codeSplitting: false");
    expect(config).toContain("permanentDeleteWorker");
    expect(config).toContain("scan/${name}");
    expect(config).toContain("src/scan/${name}.ts");
  });

  it("unpacks the scan worker directory from the asar", () => {
    const yml = FS.readFileSync(Path.join(repoRoot, "electron-builder.yml"), "utf8");
    expect(yml).toContain("dist-electron/scan/**");
  });

  it("emits the delete worker without parent-dir chunk requires", () => {
    const worker = Path.join(repoRoot, "dist-electron", "scan", "permanentDeleteWorker.cjs");
    if (!FS.existsSync(worker)) return;
    const source = FS.readFileSync(worker, "utf8");
    expect(source).not.toMatch(/require\(\s*['"]\.\.\//);
  });

  it.each(["walk", "recursive"] as const)("loads the bundled delete worker and removes a tree (%s)", async (method) => {
    const worker = Path.join(repoRoot, "dist-electron", "scan", "permanentDeleteWorker.cjs");
    if (!FS.existsSync(worker)) return;
    const tree = Path.join(tempDir, "node_modules");
    await FSP.mkdir(tree);
    await FSP.writeFile(Path.join(tree, "lock"), "x");
    const seen: string[] = [];
    let filesWalked = 0;
    await runPermanentDeleteWorker(tree, {
      workerPath: worker,
      method,
      onProgress: (progress) => {
        seen.push(progress.path);
        filesWalked = progress.filesWalked;
      },
    });
    expect(FS.existsSync(tree)).toBe(false);
    expect(seen[0]).toBe(Path.resolve(tree));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(filesWalked).toBe(method === "walk" ? 2 : 0);
  });

  it("preserves filesystem error codes for the Windows elevation decision", async () => {
    const worker = Path.join(tempDir, "denied.cjs");
    await FSP.writeFile(worker, `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', request => parentPort.postMessage({
        type: 'error', requestId: request.requestId, message: 'denied', code: 'EACCES'
      }));
    `);
    await expect(runPermanentDeleteWorker(tempDir, { workerPath: worker }))
      .rejects.toMatchObject({ message: "denied", code: "EACCES" });
  });
});
