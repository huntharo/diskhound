import * as FSP from "node:fs/promises";
import * as Path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ascendingFileRecords, makeTempDir, writeIndexFixture } from "../../testing/indexFixture";
import { countReads, expectNearLinear, measureOps, measureOpsSync } from "../../testing/opCounter";
import type { FullFileChange } from "../contracts";
import {
  computeFullDiffFromIndexFiles,
  createTopChangeAccumulator,
  mergeSortedChunks,
  writeSortedChunk,
  type SortedRec,
} from "../fullDiffWorkerRuntime";

// Operation-count scaling tests: each runs at N and 8N and requires every
// counted category to grow at most ~2× faster than linear.

let tmp: { dir: string; cleanup: () => Promise<void> };

beforeAll(async () => {
  tmp = await makeTempDir("full-diff-scaling");
});

afterAll(async () => {
  await tmp.cleanup();
});

describe("mergeSortedChunks scaling", () => {
  /** `chunks` sorted chunk files of `perChunk` records, keys dealt round-robin. */
  async function writeChunks(chunks: number, perChunk: number): Promise<string[]> {
    const dir = Path.join(tmp.dir, `chunks-${chunks}`);
    const paths: string[] = [];
    for (let c = 0; c < chunks; c += 1) {
      const records: SortedRec[] = [];
      for (let i = 0; i < perChunk; i += 1) {
        const key = `/data/${String(i * chunks + c).padStart(8, "0")}.bin`;
        records.push({ key, p: key, s: i });
      }
      const dest = Path.join(dir, `chunk-${c}.jsonl`);
      await writeSortedChunk(records, dest);
      paths.push(dest);
    }
    return paths;
  }

  it("reads each chunk head O(log chunks) times per record", async () => {
    // Chunk records are parsed inside the merge; count reads on them the
    // same way countReads does for inputs we build ourselves.
    const parse = JSON.parse;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      const value = parse(text, reviver) as unknown;
      return value && typeof value === "object" && "key" in value ? countReads(value) : value;
    });
    try {
      const run = async (chunks: number) => {
        const paths = await writeChunks(chunks, 50);
        const { result, ops } = await measureOps(async () => {
          const keys: string[] = [];
          for await (const rec of mergeSortedChunks(paths)) keys.push(rec.key);
          return keys;
        });
        expect(result).toHaveLength(chunks * 50);
        expect(result.every((key, i) => i === 0 || result[i - 1]! < key)).toBe(true);
        return ops;
      };
      // 32 → 256 chunks: a scan of every chunk head per record grows 64×;
      // a heap grows 8 × log(256)/log(32) = 12.8×.
      expectNearLinear("mergeSortedChunks", await run(32), await run(256), { maxTotal: 256 * 50 * 80 });
    } finally {
      spy.mockRestore();
    }
  });

  it("takes equal keys in chunk order", async () => {
    const dir = Path.join(tmp.dir, "ties");
    const a = Path.join(dir, "a.jsonl");
    const b = Path.join(dir, "b.jsonl");
    await writeSortedChunk([{ key: "k1", p: "A1", s: 1 }, { key: "k2", p: "A2", s: 2 }], a);
    await writeSortedChunk([{ key: "k1", p: "B1", s: 3 }, { key: "k3", p: "B3", s: 4 }], b);
    const out: string[] = [];
    for await (const rec of mergeSortedChunks([a, b])) out.push(rec.p);
    expect(out).toEqual(["A1", "B1", "A2", "B3"]);
    await FSP.rm(dir, { recursive: true, force: true });
  });
});

describe("createTopChangeAccumulator scaling", () => {
  it("keeps the largest changes in n log n on ascending deltas", () => {
    const run = (count: number, limit: number) => {
      const changes: FullFileChange[] = Array.from({ length: count }, (_, i) => ({
        path: `/data/${i}.bin`,
        kind: "added",
        size: i + 1,
        previousSize: 0,
        deltaBytes: i % 2 === 0 ? i + 1 : -(i + 1),
      }));
      const { result, ops } = measureOpsSync(() => {
        const top = createTopChangeAccumulator(limit);
        for (const change of changes) top.add(change);
        return top.toSortedArray();
      });
      expect(result).toHaveLength(limit);
      expect(Math.abs(result[0]!.deltaBytes)).toBe(count);
      return ops;
    };
    expectNearLinear("createTopChangeAccumulator", run(2_000, 250), run(16_000, 2_000), { maxTotal: 16_000 * 6 });
  });

  it("lists equal deltas in the order they were added", () => {
    const top = createTopChangeAccumulator(3);
    for (const path of ["a", "b", "c", "d"]) {
      top.add({ path, kind: "added", size: 5, previousSize: 0, deltaBytes: 5 });
    }
    top.add({ path: "e", kind: "removed", size: 0, previousSize: 9, deltaBytes: -9 });
    expect(top.toSortedArray().map((change) => change.path)).toEqual(["e", "a", "b"]);
  });
});

describe("computeFullDiffFromIndexFiles scaling", () => {
  it("diffs two indexes in n log n", async () => {
    const run = async (count: number) => {
      const root = Path.join(tmp.dir, `root-${count}`);
      const baselinePath = writeIndexFixture(
        Path.join(tmp.dir, `baseline-${count}.ndjson.gz`),
        ascendingFileRecords(root, count),
      );
      // Current: every other file grew, a quarter removed, a quarter added.
      const current = [...ascendingFileRecords(root, count)]
        .filter((_, i) => i % 4 !== 3)
        .map((rec, i) => (i % 2 === 0 ? { ...rec, s: (rec.s as number) * 2 } : rec))
        .concat([...ascendingFileRecords(Path.join(root, "new"), count / 4)]);
      const currentPath = writeIndexFixture(Path.join(tmp.dir, `current-${count}.ndjson.gz`), current);
      const { result, ops } = await measureOps(() => computeFullDiffFromIndexFiles({
        baselineId: `b-${count}`,
        currentId: `c-${count}`,
        baselinePath,
        currentPath,
        limit: count / 10,
        caseSensitive: true,
      }));
      expect(result?.changes).toHaveLength(count / 10);
      return ops;
    };
    expectNearLinear("computeFullDiffFromIndexFiles", await run(2_000), await run(16_000), { maxTotal: 16_000 * 60 });
  });
});
