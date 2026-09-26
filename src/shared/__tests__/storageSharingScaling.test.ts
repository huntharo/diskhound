import { describe, expect, it } from "vitest";

import type { DevArtifact } from "../contracts";
import { foldHardlinks } from "../duplicates";
import { groupDevArtifacts } from "../../renderer/lib/devArtifactViewState";

/**
 * Scaling tests (AGENTS.md) for the per-file and per-tree loops that
 * hardlink and APFS clone accounting added. They count field reads
 * through getters at N and 8N (with the folder or project count growing
 * 8× too), not time. Linear work grows 8×; 16× leaves room for sorts.
 */
const MAX_GROWTH = 16;

type Counter = { reads: number };

function expectScales(label: string, small: number, large: number, cap: number): void {
  expect(large / small, label).toBeLessThanOrEqual(MAX_GROWTH);
  expect(large, label).toBeLessThanOrEqual(cap);
}

describe("storage sharing scaling", () => {
  it("folds hardlink names in linear reads", () => {
    // Every size bucket holds names of a few multi-link files plus plain copies.
    const run = (files: number, buckets: number) => {
      const counter: Counter = { reads: 0 };
      const sizeMap = new Map<number, { linkId?: string }[]>();
      for (let i = 0; i < files; i++) {
        const size = i % buckets;
        const linkId = i % 3 === 0 ? undefined : `1:${Math.floor(i / 6)}`;
        const file = {
          get linkId() {
            counter.reads += 1;
            return linkId;
          },
        };
        const bucket = sizeMap.get(size);
        if (bucket) bucket.push(file);
        else sizeMap.set(size, [file]);
      }
      foldHardlinks(sizeMap);
      return counter.reads;
    };
    const n = 4_000;
    expectScales("foldHardlinks", run(n, 50), run(8 * n, 400), 4 * 8 * n);
  });

  it("groups Dev trees with clone-aware totals in linear reads", () => {
    const run = (trees: number, projects: number) => {
      const counter: Counter = { reads: 0 };
      const artifacts: DevArtifact[] = [];
      for (let i = 0; i < trees; i++) {
        const project = `/p/${i % projects}`;
        const clone = {
          cloneSize: 100,
          clonePrivateSize: 0,
          cloneInternalSize: 0,
          cloneSharedSize: 100,
          cloneSharedBlocks: 20,
          sharedRoots: 4,
          sharedWith: [],
        };
        artifacts.push({
          path: `${project}/t${i}/node_modules`,
          kind: "node-modules",
          projectPath: project,
          projectName: project,
          get size() {
            counter.reads += 1;
            return 100 + (i % 7);
          },
          fileCount: 1,
          previousSize: null,
          deltaBytes: null,
          get clone() {
            counter.reads += 1;
            return clone;
          },
        });
      }
      groupDevArtifacts(artifacts, "project", "size", true);
      return counter.reads;
    };
    const n = 2_000;
    expectScales("groupDevArtifacts", run(n, 40), run(8 * n, 320), 40 * 8 * n);
  });
});
