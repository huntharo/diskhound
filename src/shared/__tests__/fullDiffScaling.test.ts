import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { computeFullDiffFromIndexFiles, fullDiffWork } from "../fullDiffWorkerRuntime";
import { indexFilePath, initScanIndex, openIndexWriter } from "../scanIndex";

/**
 * Scaling test for the full diff. It counts the work the diff does
 * (index lines read, sort comparisons, heap levels walked, records
 * merged), not time, at N and 8N files per side. Runs stay at a fixed
 * size, so the run count grows 8× with N; the change list's limit grows
 * 8× too.
 *
 * From N to 8N, linear work grows 8×. The bound allows 2× that for log
 * factors. The merge this replaced scanned every run's head for each
 * record, so its work grew with runs × records, 64× here.
 */
const MAX_GROWTH = 16;
const RUN_RECORDS = 64;

let tempDir: string;

beforeAll(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-full-diff-scaling-"));
  initScanIndex(tempDir);
});

afterAll(async () => {
  await FSP.rm(tempDir, { recursive: true, force: true });
});

async function writeIndex(id: string, files: number, changeEvery: number): Promise<string> {
  const filePath = indexFilePath(id);
  const { stream, finalize } = openIndexWriter(filePath);
  // Paths in a scrambled order, as a parallel walk writes them.
  for (let i = 0; i < files; i += 1) {
    const n = (i * 7_919) % files;
    const size = n % changeEvery === 0 ? n + 1 : n;
    stream.write(`{"p":"/scan/g${n % 97}/d${n % 1_009}/f${n}.bin","s":${size},"m":1}\n`);
  }
  await finalize();
  return filePath;
}

async function diffWork(files: number, limit: number): Promise<number> {
  const baselinePath = await writeIndex(`scale-${files}-a`, files, 11);
  const currentPath = await writeIndex(`scale-${files}-b`, files, 13);
  fullDiffWork.steps = 0;
  const result = await computeFullDiffFromIndexFiles({
    baselineId: `scale-${files}-a`,
    currentId: `scale-${files}-b`,
    baselinePath,
    currentPath,
    caseSensitive: true,
    limit,
    sortChunkRecords: RUN_RECORDS,
  });
  expect(result?.totalChanges).toBeGreaterThan(0);
  return fullDiffWork.steps;
}

describe("full diff scaling", () => {
  it("grows about linearly with files and runs per side", async () => {
    const small = await diffWork(2_000, 100);
    const large = await diffWork(16_000, 800);
    if (process.env.SCAN_SCALING_REPORT === "1") {
      process.stdout.write(`full diff: ${small} -> ${large} steps (${(large / small).toFixed(1)}x)\n`);
    }
    expect(large / small).toBeLessThanOrEqual(MAX_GROWTH);
    // Per file and side: a line read, ~7 sort comparisons, ~8 heap
    // levels, and a merge step. 20 each leaves room.
    expect(large).toBeLessThanOrEqual(20 * 2 * 16_000);
  });
});
