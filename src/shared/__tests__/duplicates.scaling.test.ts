import * as FS from "node:fs";
import * as Path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { backslashParseOps, makeTempDir, writeIndexFixture } from "../../testing/indexFixture";
import { expectNearLinear, measureOps, totalOps } from "../../testing/opCounter";
import { collectFromIndex, collectFromWalk } from "../duplicates";
import { normPath } from "../pathUtils";

// Operation-count scaling tests: each runs at N and 8N and requires every
// counted category to grow at most ~2× faster than linear.
//
// Most files get a size of their own: that's the worst case for a
// progress tick that recounts every size bucket, since the bucket count
// grows with every file.

let tmp: { dir: string; cleanup: () => Promise<void> };

beforeAll(async () => {
  tmp = await makeTempDir("duplicates-scaling");
});

afterAll(async () => {
  await tmp.cleanup();
});

/** Size of file `i`: unique, except every 10th file pairs with the one before. */
function sizeOf(i: number): number {
  return 10_000 + (i % 10 === 9 ? i - 1 : i);
}

describe("collectFromIndex scaling", () => {
  it("reports progress without recounting every size bucket", async () => {
    let parseOps = 0;
    const run = async (count: number) => {
      const root = Path.join(tmp.dir, `index-root-${count}`);
      const records = Array.from({ length: count }, (_, i) => ({
        p: Path.join(root, `d${i % 50}`, `f${i}.bin`),
        s: sizeOf(i),
        m: 1,
      }));
      parseOps = backslashParseOps(records[count - 1]!);
      const indexPath = writeIndexFixture(Path.join(tmp.dir, `dups-${count}.ndjson.gz`), records);
      const rootNorm = normPath(Path.resolve(root));
      const ticks: Array<[number, number]> = [];
      const { result, ops } = await measureOps(() => collectFromIndex(indexPath, {
        minSizeBytes: 1,
        rootNorm,
        rootPrefix: rootNorm + Path.sep,
        applyNoiseFilter: false,
        isCancelled: () => false,
        onProgress: (walked, groups) => {
          ticks.push([walked, groups]);
        },
      }));
      expect(result.size).toBe(count / 10);
      // Ticks every 5,000 files report the pairs seen so far.
      expect(ticks[0]).toEqual([5_000, 500]);
      return ops;
    };
    const small = await run(20_000);
    const large = await run(160_000);
    expectNearLinear("collectFromIndex", small, large, { maxTotal: 160_000 * (12 + 2 * parseOps) });
  }, 60_000);
});

describe("collectFromWalk scaling", () => {
  it("reports progress without recounting every size bucket", async () => {
    const run = async (count: number) => {
      const root = Path.join(tmp.dir, `walk-root-${count}`);
      for (let d = 0; d < 20; d += 1) FS.mkdirSync(Path.join(root, `d${d}`), { recursive: true });
      for (let i = 0; i < count; i += 1) {
        // Sparse: the size is set without writing the bytes.
        const file = Path.join(root, `d${i % 20}`, `f${i}.bin`);
        FS.closeSync(FS.openSync(file, "w"));
        FS.truncateSync(file, sizeOf(i));
      }
      const ticks: Array<[number, number]> = [];
      const { result, ops } = await measureOps(() => collectFromWalk(root, {
        minSizeBytes: 1,
        applyNoiseFilter: false,
        isCancelled: () => false,
        onProgress: (walked, groups) => {
          ticks.push([walked, groups]);
        },
      }));
      expect(result.size).toBe(count / 10);
      expect(ticks.at(-1)).toEqual([count, count / 10]);
      return ops;
    };
    const small = await run(500);
    const large = await run(4_000);
    // On Windows, Path.join and fs.stat do array work inside Node that
    // the counter sees (about 10 ops per file on CI's Node, 0 on macOS
    // and Linux). The walk makes those calls once per entry (4,000 files
    // and 20 folders), so the cap allows for them on top of its own ~2
    // per file.
    const dir = Path.join(tmp.dir, "walk-root-500", "d0");
    const nodeOps = totalOps((await measureOps(() => FS.promises.stat(Path.join(dir, "f0.bin")))).ops);
    expectNearLinear("collectFromWalk", small, large, { maxTotal: 4_000 * 6 + 4_020 * nodeOps });
    // Creating and statting 4,500 files takes about 7 s on a Windows runner.
  }, 60_000);
});
