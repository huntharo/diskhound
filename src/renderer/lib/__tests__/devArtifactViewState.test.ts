import { describe, expect, it } from "vitest";

import type { DevArtifact, DevArtifactReport } from "../../../shared/contracts";
import {
  groupDevArtifacts,
  isUsefulDevReport,
  resolveDevPaint,
  seedDevViewState,
} from "../devArtifactViewState";

function report(paths: string[]): DevArtifactReport {
  return {
    artifacts: paths.map((path) => ({
      path,
      kind: "node-modules",
      projectPath: null,
      projectName: "Unscoped",
      size: 10,
      fileCount: 1,
      previousSize: null,
      deltaBytes: null,
    })),
    totalBytes: paths.length * 10,
    totalFiles: paths.length,
    projectCount: 0,
    kindTotals: paths.length > 0
      ? [{ kind: "node-modules", size: paths.length * 10, count: paths.length }]
      : [],
    generatedAt: 1,
    rootPath: "C:\\",
  };
}

describe("dev artifact empty paint", () => {
  it("does not treat a null or empty report as useful cache", () => {
    expect(isUsefulDevReport(null)).toBe(false);
    expect(isUsefulDevReport(report([]))).toBe(false);
    expect(isUsefulDevReport(report(["C:\\repo\\node_modules"]))).toBe(true);
  });

  it("keeps last-good on screen instead of seeding the empty copy", () => {
    const lastGood = { root: "C:\\", report: report(["C:\\repo\\node_modules"]) };
    const seeded = seedDevViewState("C:\\", 99, "done", null, lastGood, null);
    expect(seeded.report?.artifacts).toHaveLength(1);
    expect(seeded.settled).toBe(false);
    expect(resolveDevPaint({
      report: seeded.report,
      remainingCount: 1,
      loading: seeded.loading,
      settled: seeded.settled,
      loadError: null,
    })).toBe("list");
  });

  it("stays on loading until a fetch settles, even if report is still null", () => {
    expect(resolveDevPaint({
      report: null,
      remainingCount: 0,
      loading: false,
      settled: false,
      loadError: null,
    })).toBe("loading");
  });

  it("shows empty only after a completed load with no remaining trees", () => {
    expect(resolveDevPaint({
      report: report([]),
      remainingCount: 0,
      loading: false,
      settled: true,
      loadError: null,
    })).toBe("empty");
  });

  it("does not paint empty from an empty session cache on tab enter", () => {
    const seeded = seedDevViewState(
      "C:\\",
      10,
      "done",
      { key: "C:\\|10", report: report([]) },
      null,
      null,
    );
    expect(seeded.settled).toBe(false);
    expect(seeded.loading).toBe(true);
    expect(resolveDevPaint({
      report: seeded.report,
      remainingCount: 0,
      loading: seeded.loading,
      settled: seeded.settled,
      loadError: null,
    })).toBe("loading");
  });
});

function tree(partial: Partial<DevArtifact> & Pick<DevArtifact, "path" | "size">): DevArtifact {
  return {
    kind: "node-modules",
    projectPath: null,
    projectName: "Unscoped",
    fileCount: 1,
    previousSize: null,
    deltaBytes: null,
    ...partial,
  };
}

describe("groupDevArtifacts", () => {
  const rust = tree({
    path: "C:\\a\\target",
    kind: "rust-target",
    projectPath: "C:\\a",
    projectName: "a",
    size: 30,
  });
  const node = tree({
    path: "C:\\b\\node_modules",
    kind: "node-modules",
    projectPath: "C:\\b",
    projectName: "b",
    size: 10,
  });
  const diag = tree({
    path: "C:\\Users\\me\\AppData\\Local\\Temp\\DiagOutputDir",
    kind: "diag-logs",
    size: 20,
  });

  it("All is one size-sorted list", () => {
    const groups = groupDevArtifacts([node, rust, diag], "all");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("all");
    expect(groups[0]?.artifacts.map((a) => a.path)).toEqual([
      rust.path,
      diag.path,
      node.path,
    ]);
  });

  it("By kind and By project still bucket", () => {
    expect(groupDevArtifacts([node, rust, diag], "kind")).toHaveLength(3);
    expect(groupDevArtifacts([node, rust, diag], "project").map((g) => g.label).sort()).toEqual([
      "Unscoped",
      "a",
      "b",
    ]);
  });
});
