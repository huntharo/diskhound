import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { analyzeDevArtifacts } from "../devArtifactsIndex";
import { indexFilePath, initScanIndex, openIndexWriter } from "../scanIndex";

let tempDir: string;

beforeEach(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-dev-index-"));
  initScanIndex(tempDir);
});

afterEach(async () => {
  await FSP.rm(tempDir, { recursive: true, force: true });
});

describe("analyzeDevArtifacts", () => {
  it("rolls node_modules occupancy and skips extra hardlinks", async () => {
    const filePath = indexFilePath("scan");
    const { stream, finalize } = openIndexWriter(filePath);
    stream.write(`${JSON.stringify({ p: "C:\\proj\\package.json", s: 200, m: 1 })}\n`);
    stream.write(`${JSON.stringify({ p: "C:\\proj\\node_modules\\preact\\dist\\preact.js", s: 5_000_000, m: 1 })}\n`);
    stream.write(`${JSON.stringify({ p: "C:\\proj\\node_modules\\dup\\x.js", s: 5_000_000, m: 1, h: 1 })}\n`);
    await finalize();

    const result = await analyzeDevArtifacts("C:\\proj", filePath);
    expect(result.totalBytes).toBe(5_000_000);
    expect(result.artifacts.some((a) => a.kind === "node-modules")).toBe(true);
  });
});

describe("sidecarFromDirectoryRoots", () => {
  it("keeps the outer target folder and skips target/debug", async () => {
    const { sidecarFromDirectoryRoots, reportFromSidecar } = await import("../devArtifactSidecar");
    const sidecar = sidecarFromDirectoryRoots("C:\\", [
      { path: "C:\\proj\\target", size: 80_000_000, files: 400 },
      { path: "C:\\proj\\target\\debug", size: 50_000_000, files: 300 },
      { path: "C:\\proj\\node_modules", size: 20_000_000, files: 100 },
      { path: "C:\\proj\\node_modules\\preact", size: 1_000_000, files: 10 },
    ], ["C:\\proj"]);
    const report = reportFromSidecar(sidecar);
    expect(report.totalBytes).toBe(100_000_000);
    expect(report.artifacts.map((a) => a.path).sort()).toEqual([
      "C:\\proj\\node_modules",
      "C:\\proj\\target",
    ]);
  });
});

describe("reportFromSidecar", () => {
  it("keeps dist/ only when a project marker exists", async () => {
    const { reportFromSidecar } = await import("../devArtifactSidecar");
    const report = reportFromSidecar({
      version: 1,
      rootPath: "C:\\",
      generatedAt: 1,
      roots: [
        { path: "C:\\proj\\dist", kind: "js-build", size: 9_000_000, files: 10 },
        { path: "C:\\proj\\node_modules", kind: "node-modules", size: 5_000_000, files: 20 },
      ],
      projects: ["C:\\proj"],
    });
    expect(report.totalBytes).toBe(14_000_000);
    expect(report.artifacts.map((a) => a.kind).sort()).toEqual(["js-build", "node-modules"]);
  });
});
