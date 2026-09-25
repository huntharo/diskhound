import * as Path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ascendingFileRecords, makeTempDir, writeIndexFixture } from "../../testing/indexFixture";
import { expectNearLinear, measureOps, measureOpsSync } from "../../testing/opCounter";
import type { FullFileChange } from "../contracts";
import { computeFullDiffFromIndexFiles, createTopChangeAccumulator } from "../fullDiffWorkerRuntime";

// Operation-count scaling tests: each runs at N and 8N and requires every
// counted category to grow at most ~2× faster than linear. The run merge
// has its own step-count test in fullDiffScaling.test.ts.

let tmp: { dir: string; cleanup: () => Promise<void> };

beforeAll(async () => {
  tmp = await makeTempDir("full-diff-scaling");
});

afterAll(async () => {
  await tmp.cleanup();
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
