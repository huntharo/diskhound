import * as Path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ascendingFileRecords, makeTempDir, writeIndexFixture } from "../../testing/indexFixture";
import { expectNearLinear, measureOps, measureOpsSync } from "../../testing/opCounter";
import type { ScanSnapshot } from "../contracts";
import { createIdleScanSnapshot } from "../contracts";
import { computeDiff } from "../scanDiff";
import {
  buildSnapshotFromIndex,
  diffIndexes,
  loadDirectChildrenFromIndex,
  loadLargestFiles,
  searchIndexFile,
  type IndexRecord,
} from "../scanIndex";

// Operation-count scaling tests over gzipped NDJSON index fixtures. Sizes
// ascend through each fixture: every record beats the smallest one a
// top-N list holds, the worst case for keeping that list. The top-N
// limit scales with N where the API takes one, so a list that re-sorts
// per record (N × limit work) shows up as ~64× growth instead of 8×.

let tmp: { dir: string; cleanup: () => Promise<void> };
let root: string;

beforeAll(async () => {
  tmp = await makeTempDir("scan-index-scaling");
  root = Path.join(tmp.dir, "scan-root");
});

afterAll(async () => {
  await tmp.cleanup();
});

function fixture(name: string, records: Iterable<Record<string, unknown>>): string {
  return writeIndexFixture(Path.join(tmp.dir, `${name}.ndjson.gz`), records);
}

const N = 2_000;
const LIMIT = 250;

describe("loadLargestFiles scaling", () => {
  it("keeps the top N in n log n on ascending sizes", async () => {
    const run = async (count: number, limit: number) => {
      const indexPath = fixture(`largest-${count}`, ascendingFileRecords(root, count));
      const { result, ops } = await measureOps(() => loadLargestFiles(indexPath, limit));
      expect(result).toHaveLength(limit);
      expect(result[0]!.s).toBe(1_000 + count - 1);
      return ops;
    };
    const small = await run(N, LIMIT);
    const large = await run(N * 8, LIMIT * 8);
    expectNearLinear("loadLargestFiles", small, large, { maxTotal: N * 8 * 3 });
  });
});

describe("loadDirectChildrenFromIndex scaling", () => {
  it("keeps the top direct files and child folders in n log n", async () => {
    const run = async (count: number, limit: number) => {
      // Half the records sit directly in the root, half in `limit * 2` subfolders.
      const records = [...ascendingFileRecords(root, count, { folders: limit * 2 })].map((rec, i) => (
        i % 2 === 0 ? { ...rec, p: Path.join(root, `direct-${i}.bin`) } : rec
      ));
      const indexPath = fixture(`children-${count}`, records);
      const { result, ops } = await measureOps(() => loadDirectChildrenFromIndex(indexPath, root, limit, limit));
      expect(result.files).toHaveLength(limit);
      expect(result.dirs).toHaveLength(limit);
      return ops;
    };
    const small = await run(N, LIMIT);
    const large = await run(N * 8, LIMIT * 8);
    expectNearLinear("loadDirectChildrenFromIndex", small, large, { maxTotal: N * 8 * 15 });
  });
});

describe("searchIndexFile scaling", () => {
  it("keeps the largest hits in n log n", async () => {
    const run = async (count: number, limit: number) => {
      const indexPath = fixture(`search-${count}`, ascendingFileRecords(root, count));
      const { result, ops } = await measureOps(() => searchIndexFile(indexPath, { query: "file-", limit }));
      expect(result.hits).toHaveLength(limit);
      expect(result.filesScanned).toBe(count);
      return ops;
    };
    // searchIndexFile caps the limit at 2,000.
    const small = await run(N, 200);
    const large = await run(N * 8, 1_600);
    expectNearLinear("searchIndexFile", small, large, { maxTotal: N * 8 * 15 });
  });
});

describe("buildSnapshotFromIndex scaling", () => {
  it("counts comparisons within n log n of the fixed 5,000-file list", async () => {
    // TOP_FILE_LIMIT is fixed, so start just past it: at 6k and 48k files
    // a re-sort per accepted file does 1k × 5k vs 43k × 5k comparisons.
    const run = async (count: number) => {
      const indexPath = fixture(`snapshot-${count}`, ascendingFileRecords(root, count, { folders: 200 }));
      const { result, ops } = await measureOps(() => buildSnapshotFromIndex({
        indexPath,
        rootPath: root,
        engine: "js-worker",
        startedAt: 0,
        elapsedMs: 1,
      }));
      expect(result.filesVisited).toBe(count);
      expect(result.largestFiles).toHaveLength(5_000);
      expect(result.largestFiles[0]!.size).toBe(1_000 + count - 1);
      return ops;
    };
    const small = await run(6_000);
    const large = await run(48_000);
    expectNearLinear("buildSnapshotFromIndex", small, large, {
      maxTotal: 48_000 * 25,
    });
    expect(large.compares).toBeLessThanOrEqual(4 * 48_000 * Math.log2(5_000));
  });
});

describe("diffIndexes / computeDiff scaling", () => {
  function indexMap(count: number, offset: number): Map<string, IndexRecord> {
    const map = new Map<string, IndexRecord>();
    for (let i = 0; i < count; i += 1) {
      const p = `/data/file-${i + offset}.bin`;
      map.set(p, { p, s: 1_000 + ((i * 7) % count), m: 0 });
    }
    return map;
  }

  it("diffs two indexes in n log n", () => {
    const run = (count: number) => {
      const baseline = indexMap(count, 0);
      const current = indexMap(count, count / 4);
      return measureOpsSync(() => diffIndexes("a", "b", baseline, current, count / 10)).ops;
    };
    expectNearLinear("diffIndexes", run(N), run(N * 8), { maxTotal: N * 8 * 20 });
  });

  function snapshot(count: number, offset: number): ScanSnapshot {
    return {
      ...createIdleScanSnapshot(),
      status: "done",
      rootPath: "/data",
      bytesSeen: count * 1_000 + offset,
      filesVisited: count,
      largestFiles: Array.from({ length: count }, (_, i) => ({
        path: `/data/f-${i + offset}.bin`,
        name: `f-${i + offset}.bin`,
        parentPath: "/data",
        extension: `.e${i % 40}`,
        size: 1_000 + ((i * 13) % count),
        modifiedAt: 0,
      })),
      hottestDirectories: Array.from({ length: count }, (_, i) => ({
        path: `/data/d-${i + offset}`,
        size: 5_000 + i,
        fileCount: 3,
        depth: 1,
      })),
      topExtensions: Array.from({ length: 12 }, (_, i) => ({ extension: `.e${i}`, size: 100 * i + offset, count: i })),
    };
  }

  it("diffs two snapshots in n log n", () => {
    const run = (count: number) => {
      const baseline = snapshot(count, 0);
      const current = snapshot(count, count / 4);
      return measureOpsSync(() => computeDiff(baseline, current, "a", "b")).ops;
    };
    expectNearLinear("computeDiff", run(N), run(N * 8), { maxTotal: N * 8 * 60 });
  });
});
