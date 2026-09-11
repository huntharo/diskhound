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
});
