import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultSettings } from "../contracts";
import { indexFilePath, initScanIndex, openIndexWriter } from "../scanIndex";
import { analyzeCleanupFromIndex } from "../suggestions";

let tempDir: string;

beforeEach(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-cleanup-"));
  initScanIndex(tempDir);
});

afterEach(async () => {
  await FSP.rm(tempDir, { recursive: true, force: true });
});

describe("analyzeCleanupFromIndex", () => {
  it("rolls nested node_modules files into the cache bucket", async () => {
    const filePath = indexFilePath("scan");
    const { stream, finalize } = openIndexWriter(filePath);
    stream.write(`${JSON.stringify({ p: "C:\\proj\\node_modules\\preact\\dist\\preact.js", s: 5_000_000, m: 1 })}\n`);
    stream.write(`${JSON.stringify({ p: "C:\\proj\\src\\index.ts", s: 100, m: 1 })}\n`);
    await finalize();

    const result = await analyzeCleanupFromIndex("C:\\proj", filePath, defaultSettings().cleanup);
    const caches = result.suggestions.find((s) => s.category === "build-cache");
    expect(caches).toBeTruthy();
    expect(caches!.totalSize).toBe(5_000_000);
    expect(caches!.paths.some((p) => p.includes("node_modules"))).toBe(true);
  });

  it("does not treat editor out/ or cargo bin/ as build caches", async () => {
    const filePath = indexFilePath("scan-broad");
    const { stream, finalize } = openIndexWriter(filePath);
    stream.write(`${JSON.stringify({ p: "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\resources\\app\\out\\vs.js", s: 8_000_000, m: 1 })}\n`);
    stream.write(`${JSON.stringify({ p: "C:\\Users\\me\\.cargo\\bin\\rg.exe", s: 4_000_000, m: 1 })}\n`);
    stream.write(`${JSON.stringify({ p: "C:\\proj\\dist\\bundle.js", s: 3_000_000, m: 1 })}\n`);
    await finalize();

    const result = await analyzeCleanupFromIndex("C:\\", filePath, defaultSettings().cleanup);
    const caches = result.suggestions.find((s) => s.category === "build-cache");
    expect(caches).toBeUndefined();
  });

  it("treats Next.js .next as a cache", async () => {
    const filePath = indexFilePath("scan-next");
    const { stream, finalize } = openIndexWriter(filePath);
    stream.write(`${JSON.stringify({ p: "C:\\proj\\app\\.next\\cache\\webpack\\chunk.js", s: 9_000_000, m: 1 })}\n`);
    await finalize();

    const result = await analyzeCleanupFromIndex("C:\\proj", filePath, defaultSettings().cleanup);
    const caches = result.suggestions.find((s) => s.category === "build-cache");
    expect(caches).toBeTruthy();
    expect(caches!.totalSize).toBe(9_000_000);
  });

  it("treats MSBuild obj/ and Rust target/ as caches", async () => {
    const filePath = indexFilePath("scan-obj");
    const { stream, finalize } = openIndexWriter(filePath);
    stream.write(`${JSON.stringify({ p: "C:\\proj\\App\\obj\\Debug\\net8.0\\App.dll", s: 2_000_000, m: 1 })}\n`);
    stream.write(`${JSON.stringify({ p: "C:\\proj\\native\\target\\release\\app.exe", s: 6_000_000, m: 1 })}\n`);
    await finalize();

    const result = await analyzeCleanupFromIndex("C:\\proj", filePath, defaultSettings().cleanup);
    const caches = result.suggestions.find((s) => s.category === "build-cache");
    expect(caches).toBeTruthy();
    expect(caches!.totalSize).toBe(8_000_000);
  });
});
