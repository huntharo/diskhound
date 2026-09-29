import { expect, it } from "vitest";

import type { DevArtifact } from "../../../shared/contracts";
import { countReads, expectNearLinear, measureOpsSync } from "../../../testing/opCounter";
import { overviewDevTileDisplay } from "../devReclaimDisplay";

it.each([false, true])("summarizes the Overview tile in linear work as the tree count grows 8× (mixed: %s)", (mixed) => {
  const run = (count: number) => {
    const artifacts: DevArtifact[] = Array.from({ length: count }, (_, i) => ({
      path: `/work/project-${i}/node_modules`,
      kind: "node-modules",
      projectPath: `/work/project-${i}`,
      projectName: `project-${i}`,
      size: 100_000_000,
      fileCount: 1,
      previousSize: null,
      deltaBytes: null,
      clone: mixed && i % 2 === 1 ? undefined : {
        cloneSize: 90_000_000,
        clonePrivateSize: 0,
        cloneInternalSize: 0,
        cloneSharedSize: 90_000_000,
        cloneSharedBlocks: 10_000_000,
        sharedRoots: 1,
        sharedWith: [],
      },
    }));
    const { result, ops } = measureOpsSync(() => overviewDevTileDisplay(countReads(artifacts)));
    expect(result).not.toBeNull();
    return ops;
  };
  const n = 300;
  expectNearLinear("overviewDevTileDisplay", run(n), run(n * 8), { maxTotal: n * 8 * 100 });
});
