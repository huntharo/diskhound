import { describe, expect, it } from "vitest";

import type { DevArtifact, DevArtifactKind } from "../../../shared/contracts";
import { countReads, expectNearLinear, measureOpsSync } from "../../../testing/opCounter";
import { artifactsAtPaths, groupDevArtifacts, type DevGroupBy, type DevSortBy } from "../devArtifactViewState";

// Operation-count scaling tests: each runs at N and 8N and requires every
// counted category to grow at most ~2× faster than linear.

const N = 300;
const KINDS: DevArtifactKind[] = ["node-modules", "rust-target", "js-build", "python", "package-cache"];

function artifacts(count: number): DevArtifact[] {
  return Array.from({ length: count }, (_, i) => {
    const projectPath = `/home/dev/src/project-${i % Math.max(1, Math.floor(count / 4))}`;
    return {
      path: `${projectPath}/tree-${i}`,
      kind: KINDS[i % KINDS.length]!,
      projectPath,
      projectName: projectPath.slice(projectPath.lastIndexOf("/") + 1),
      size: 1_000 + ((i * 37) % count),
      fileCount: 10,
      previousSize: i % 3 === 0 ? null : 900,
      deltaBytes: i % 3 === 0 ? null : 100 + (i % 50),
    };
  });
}

describe("groupDevArtifacts scaling", () => {
  for (const groupBy of ["all", "kind", "project"] as DevGroupBy[]) {
    for (const sortBy of ["size", "increase"] as DevSortBy[]) {
      it(`groups by ${groupBy}, sorted by ${sortBy}, in n log n`, () => {
        const run = (count: number) => {
          const rows = countReads(artifacts(count));
          return measureOpsSync(() => groupDevArtifacts(rows, groupBy, sortBy)).ops;
        };
        expectNearLinear(`groupDevArtifacts ${groupBy} ${sortBy}`, run(N), run(N * 8), { maxTotal: N * 8 * 100 });
      });
    }
  }
});

describe("artifactsAtPaths scaling", () => {
  it("picks the selected rows in linear work", () => {
    const run = (count: number) => {
      const rows = countReads(artifacts(count));
      const paths = artifacts(count).filter((_, i) => i % 2 === 0).map((artifact) => artifact.path);
      const { result, ops } = measureOpsSync(() => artifactsAtPaths(rows, paths));
      expect(result).toHaveLength(count / 2);
      return ops;
    };
    expectNearLinear("artifactsAtPaths", run(N), run(N * 8), { maxTotal: N * 8 * 8 });
  });
});
