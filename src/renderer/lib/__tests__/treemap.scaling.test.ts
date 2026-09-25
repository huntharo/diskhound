import { describe, expect, it } from "vitest";

import type { ScanFileRecord } from "../../../shared/contracts";
import { countReads, expectNearLinear, measureOpsSync } from "../../../testing/opCounter";
import {
  buildTreemapComposition,
  buildTreemapLayout,
  buildTreemapRects,
  squarify,
  type TreemapAreaMode,
  type TreemapLayout,
} from "../treemap";

// Operation-count scaling tests: each runs at N and 8N and requires every
// counted category to grow at most ~2× faster than linear.

const N = 1_250;

type SizeShape = "equal" | "geometric";

function sizeAt(shape: SizeShape, i: number): number {
  // Geometric sizes shrink 0.1% per file: a long tail of ever-smaller rows.
  return shape === "equal" ? 4_096 : Math.round(1e15 * 0.999 ** i);
}

function files(count: number, shape: SizeShape, folders = 16): ScanFileRecord[] {
  return Array.from({ length: count }, (_, i) => {
    const parentPath = `/data/set-${i % folders}/part-${i % 3}`;
    const name = `file-${i}.bin`;
    return {
      path: `${parentPath}/${name}`,
      name,
      parentPath,
      extension: ".bin",
      size: sizeAt(shape, i),
      modifiedAt: 0,
    };
  });
}

// Tree cases put every file in one of three folders, so each folder's
// squarify pass sees thousands of children.
const CASES: Array<{ shape: SizeShape; areaMode: TreemapAreaMode; layout: TreemapLayout; folders: number }> = [
  { shape: "equal", areaMode: "compressed", layout: "size", folders: 16 },
  { shape: "equal", areaMode: "exact", layout: "size", folders: 16 },
  { shape: "geometric", areaMode: "compressed", layout: "size", folders: 16 },
  { shape: "geometric", areaMode: "exact", layout: "size", folders: 16 },
  { shape: "equal", areaMode: "compressed", layout: "tree", folders: 1 },
  { shape: "geometric", areaMode: "compressed", layout: "tree", folders: 1 },
];

describe("buildTreemapLayout scaling", () => {
  for (const { shape, areaMode, layout, folders } of CASES) {
    it(`lays out ${shape} sizes (${areaMode}, ${layout}) in n log n`, () => {
      const run = (count: number) => {
        const input = countReads(files(count, shape, folders));
        return measureOpsSync(() => buildTreemapLayout(input, 1_600, 1_000, areaMode, layout)).ops;
      };
      expectNearLinear(`buildTreemapLayout ${shape} ${areaMode} ${layout}`, run(N), run(N * 8), {
        maxTotal: N * 8 * 120,
      });
    });
  }

  it("places 10k files without deep recursion", () => {
    for (const shape of ["equal", "geometric"] as const) {
      const result = buildTreemapLayout(files(10_000, shape), 1_600, 1_000, "exact", "size");
      expect(result.leaves.length).toBeGreaterThan(0);
      for (const leaf of result.leaves) {
        expect(leaf.x + leaf.w).toBeLessThanOrEqual(1_600 + 1e-6);
        expect(leaf.y + leaf.h).toBeLessThanOrEqual(1_000 + 1e-6);
      }
    }
  });

  it("builds rects and compositions in n log n", () => {
    const rects = (count: number) => {
      const input = files(count, "equal");
      return measureOpsSync(() => buildTreemapRects(input, 1_600, 1_000)).ops;
    };
    expectNearLinear("buildTreemapRects", rects(N), rects(N * 8));

    const composition = (count: number) => {
      const input = countReads(files(count, "geometric"));
      return measureOpsSync(() => buildTreemapComposition(input)).ops;
    };
    expectNearLinear("buildTreemapComposition", composition(N), composition(N * 8));
  });
});

describe("squarify scaling", () => {
  // The shared row builder behind the flat, tree and process treemaps.
  // Counting reads of the items array and their weights catches rescans
  // of the row and copies of the remaining items, however they're written.
  for (const shape of ["equal", "geometric"] as const) {
    it(`reads each ${shape} item a bounded number of times`, () => {
      const run = (count: number) => {
        const items = countReads(
          Array.from({ length: count }, (_, i) => ({ weight: Math.sqrt(sizeAt(shape, i)) })),
        );
        const total = Array.from({ length: count }, (_, i) => Math.sqrt(sizeAt(shape, i))).reduce((a, b) => a + b, 0);
        let placed = 0;
        const { ops } = measureOpsSync(() => squarify(items, { x: 0, y: 0, w: 1_600, h: 1_000 }, total, () => {
          placed += 1;
        }));
        expect(placed).toBeGreaterThan(0);
        return ops;
      };
      expectNearLinear(`squarify ${shape}`, run(N), run(N * 8), { maxTotal: N * 8 * 30 });
    });
  }
});
