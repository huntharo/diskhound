import * as Path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeTempDir, writeIndexFixture } from "../../testing/indexFixture";
import { expectNearLinear, measureOps } from "../../testing/opCounter";
import { buildFolderTreeFromIndex } from "../folderTreeWorkerRuntime";

// Operation-count scaling test over a gzipped NDJSON index fixture: runs
// at N and 8N files and requires every counted category to grow at most
// ~2× faster than linear.

let tmp: { dir: string; cleanup: () => Promise<void> };

beforeAll(async () => {
  tmp = await makeTempDir("folder-tree-scaling");
});

afterAll(async () => {
  await tmp.cleanup();
});

describe("buildFolderTreeFromIndex scaling", () => {
  it("rolls up folders and trims each folder's file list in n log n", async () => {
    const run = async (count: number) => {
      const root = Path.join(tmp.dir, `root-${count}`);
      // Half the files in one big folder (its list is trimmed as it grows),
      // half spread over a nested tree that grows with N. Sizes ascend.
      const records = Array.from({ length: count }, (_, i) => {
        const folder = i % 2 === 0
          ? Path.join(root, "big")
          : Path.join(root, `a${i % 16}`, `b${i % (count / 64)}`, `c${i % 7}`);
        return { p: Path.join(folder, `f${i}.bin`), s: 1_000 + i, m: 1 };
      });
      const indexPath = writeIndexFixture(Path.join(tmp.dir, `tree-${count}.ndjson.gz`), records);
      const { result, ops } = await measureOps(() => buildFolderTreeFromIndex(indexPath));
      const big = result.find(([key]) => key.endsWith(`${Path.sep}big`));
      expect(big?.[1].files).toHaveLength(200);
      expect(big?.[1].files[0]!.size).toBe(1_000 + count - 2);
      return ops;
    };
    expectNearLinear("buildFolderTreeFromIndex", await run(4_000), await run(32_000), {
      maxTotal: 32_000 * 60,
    });
  });
});
