import { expect, it } from "vitest";

import type { DevArtifact } from "../../../shared/contracts";
import { countReads, expectNearLinear, measureOpsSync } from "../../../testing/opCounter";
import { artifactsInsideCheckout } from "../gitRepoDisplay";

/** Half repos, half node_modules inside them. */
function artifacts(count: number): DevArtifact[] {
  return Array.from({ length: count }, (_, i): DevArtifact => {
    const project = `/work/project-${i >> 1}`;
    return {
      path: i % 2 === 0 ? `${project}/.git` : `${project}/node_modules`,
      kind: i % 2 === 0 ? "git-repo" : "node-modules",
      projectPath: project,
      projectName: `project-${i >> 1}`,
      size: 100_000_000,
      fileCount: 1,
      previousSize: null,
      deltaBytes: null,
    };
  });
}

it("finds the trees inside a checkout in linear work as the tree count grows 8×", () => {
  const run = (count: number) => {
    const rows = artifacts(count);
    const { result, ops } = measureOpsSync(() => artifactsInsideCheckout(countReads(rows), rows[0]!));
    expect(result.map((a) => a.path)).toEqual(["/work/project-0/node_modules"]);
    return ops;
  };
  const n = 300;
  expectNearLinear("artifactsInsideCheckout", run(n), run(n * 8), { maxTotal: n * 8 * 100 });
});
