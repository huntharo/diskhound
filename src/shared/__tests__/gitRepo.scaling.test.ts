import { expect, it } from "vitest";

import type { DevArtifact, DevArtifactReport, DevGitRepoInfo } from "../contracts";
import { annotateGitRepos } from "../gitRepo";
import { countReads, expectNearLinear, measureOps } from "../../testing/opCounter";

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

const INFO: DevGitRepoInfo = { remotes: ["origin"], remoteUrl: "github.com/me/app", readable: true };

it("annotates repos in linear work, and reads each .git/config once, as the repo count grows 8×", async () => {
  const run = async (count: number) => {
    const report: DevArtifactReport = {
      artifacts: countReads(artifacts(count)),
      totalBytes: 0,
      totalFiles: 0,
      projectCount: 0,
      kindTotals: [],
      generatedAt: 0,
      rootPath: "/",
    };
    let reads = 0;
    const { result, ops } = await measureOps(() =>
      annotateGitRepos(report, new Map(), async () => { reads += 1; return INFO; }));
    expect(reads).toBe(count / 2);
    expect(result.artifacts.filter((a) => a.git).length).toBe(count / 2);
    return ops;
  };
  const n = 200;
  expectNearLinear("annotateGitRepos", await run(n), await run(n * 8), { maxTotal: n * 8 * 200 });
});
