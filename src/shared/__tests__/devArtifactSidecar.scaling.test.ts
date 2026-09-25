import { describe, expect, it } from "vitest";

import { countReads, expectNearLinear, measureOpsSync } from "../../testing/opCounter";
import type { DevArtifact, DevArtifactReport } from "../contracts";
import {
  compactDevArtifactSidecar,
  DEV_SIDECAR_ROOT_CAP,
  planRescanTargets,
  reportFromSidecar,
  sidecarFromDirectoryRoots,
  type DevArtifactSidecar,
} from "../devArtifactSidecar";
import { dropArtifactsFromReport, mergeDiagLogHotspots } from "../devArtifacts";

// Operation-count scaling tests: each runs at N and 8N and requires every
// counted category to grow at most ~2× faster than linear.

const PROJECTS = 150;

function projectPath(i: number): string {
  // Mix Windows and POSIX roots; the sidecar code handles both.
  return i % 2 === 0 ? `C:\\Users\\dev\\src\\project-${i}` : `/home/dev/src/project-${i}`;
}

function join(parent: string, name: string): string {
  return parent.includes("\\") ? `${parent}\\${name}` : `${parent}/${name}`;
}

/** Folder-tree rollups for `projects` projects: 3 artifact roots each, one nested. */
function folderRollups(projects: number): Array<{ path: string; size: number; files: number }> {
  const dirs: Array<{ path: string; size: number; files: number }> = [];
  for (let i = 0; i < projects; i += 1) {
    const project = projectPath(i);
    dirs.push({ path: project, size: 9_000 + i, files: 90 });
    dirs.push({ path: join(project, "src"), size: 1_000, files: 10 });
    dirs.push({ path: join(project, "node_modules"), size: 5_000 + i, files: 50 });
    dirs.push({ path: join(project, "target"), size: 3_000 + i, files: 30 });
    dirs.push({ path: join(join(project, "target"), "debug"), size: 2_000, files: 20 });
  }
  return dirs;
}

function sidecarWith(projects: number): DevArtifactSidecar {
  const roots: DevArtifactSidecar["roots"] = [];
  const projectPaths: string[] = [];
  for (let i = 0; i < projects; i += 1) {
    const project = projectPath(i);
    projectPaths.push(project);
    roots.push({ path: join(project, "node_modules"), kind: "node-modules", size: 5_000 + i, files: 50 });
    roots.push({ path: join(project, "dist"), kind: "js-build", size: 2_000 + i, files: 20 });
  }
  return { version: 1, rootPath: "C:\\", generatedAt: 1, roots, projects: projectPaths };
}

function reportWith(projects: number): DevArtifactReport {
  const sidecar = sidecarWith(projects);
  return reportFromSidecar(sidecar);
}

describe("sidecarFromDirectoryRoots scaling", () => {
  const run = (projects: number) => {
    const dirs = countReads(folderRollups(projects));
    return measureOpsSync(() => sidecarFromDirectoryRoots("C:\\", dirs, [])).ops;
  };

  it("drops nested roots in linear work", () => {
    // ~80 ops per folder, most of it classifyArtifactPath.
    expectNearLinear("sidecarFromDirectoryRoots", run(PROJECTS), run(PROJECTS * 8), {
      maxTotal: PROJECTS * 8 * 5 * 120,
    });
  });

  it("still keeps the outer root of each nested pair", () => {
    const sidecar = sidecarFromDirectoryRoots("C:\\", folderRollups(4), []);
    const paths = sidecar.roots.map((root) => root.path).sort();
    expect(paths).toEqual([
      "/home/dev/src/project-1/node_modules",
      "/home/dev/src/project-1/target",
      "/home/dev/src/project-3/node_modules",
      "/home/dev/src/project-3/target",
      "C:\\Users\\dev\\src\\project-0\\node_modules",
      "C:\\Users\\dev\\src\\project-0\\target",
      "C:\\Users\\dev\\src\\project-2\\node_modules",
      "C:\\Users\\dev\\src\\project-2\\target",
    ]);
  });
});

describe("planRescanTargets scaling", () => {
  it("checks seeded roots against known roots in linear work", () => {
    const run = (projects: number) => {
      const sidecar = sidecarWith(projects);
      // One seed per project: half nested under a known root, half new.
      const extras = Array.from({ length: projects }, (_, i) => (
        i % 2 === 0
          ? join(join(projectPath(i), "node_modules"), ".cache")
          : join(projectPath(i), "DiagOutputDir")
      ));
      return measureOpsSync(() => planRescanTargets(sidecar, extras)).ops;
    };
    expectNearLinear("planRescanTargets", run(PROJECTS), run(PROJECTS * 8), {
      maxTotal: PROJECTS * 8 * 3 * 60,
    });
  });

  it("skips seeds that equal, sit under, or hold a known root, ignoring case", () => {
    const sidecar: DevArtifactSidecar = {
      version: 1,
      rootPath: "C:\\",
      generatedAt: 1,
      roots: [{ path: "C:\\Work\\app\\node_modules", kind: "node-modules", size: 10, files: 1 }],
      projects: [],
    };
    expect(planRescanTargets(sidecar, [
      "c:\\work\\APP\\node_modules\\",
      "C:\\work\\app\\node_modules\\.cache",
      "C:\\Work",
      "C:\\Windows\\Temp\\DiagOutputDir",
      "C:\\Windows\\Temp\\DiagOutputDir\\RdClientAutoTrace",
    ])).toEqual([
      "C:\\Work\\app\\node_modules",
      "C:\\Windows\\Temp\\DiagOutputDir",
    ]);
  });
});

describe("compactDevArtifactSidecar / reportFromSidecar scaling", () => {
  it("compacts in n log n", () => {
    const run = (projects: number) => {
      const sidecar = sidecarWith(projects);
      return measureOpsSync(() => compactDevArtifactSidecar(sidecar)).ops;
    };
    // Stay under the root cap so both runs keep every root.
    expect(PROJECTS * 8 * 2).toBeLessThan(DEV_SIDECAR_ROOT_CAP);
    expectNearLinear("compactDevArtifactSidecar", run(PROJECTS), run(PROJECTS * 8));
  });

  it("builds a report in n log n", () => {
    const run = (projects: number) => {
      const sidecar = sidecarWith(projects);
      const previous = sidecarWith(projects);
      return measureOpsSync(() => reportFromSidecar(sidecar, previous)).ops;
    };
    expectNearLinear("reportFromSidecar", run(PROJECTS), run(PROJECTS * 8));
  });
});

describe("devArtifacts report helpers scaling", () => {
  it("merges diag-log hotspots in linear work", () => {
    const run = (projects: number) => {
      const report = reportWith(projects);
      const dirs = countReads(Array.from({ length: projects * 4 }, (_, i) => ({
        path: i % 2 === 0
          ? `C:\\Users\\u${i}\\AppData\\Local\\Temp\\DiagOutputDir\\trace-${i}`
          : join(projectPath(i), "src"),
        size: 1_000 + i,
        fileCount: 3,
      })));
      return measureOpsSync(() => mergeDiagLogHotspots(report, dirs)).ops;
    };
    expectNearLinear("mergeDiagLogHotspots", run(PROJECTS), run(PROJECTS * 8));
  });

  it("drops deleted trees in linear work", () => {
    const run = (projects: number) => {
      const report = reportWith(projects);
      const paths = report.artifacts.filter((_, i) => i % 3 === 0).map((artifact: DevArtifact) => artifact.path);
      return measureOpsSync(() => dropArtifactsFromReport(report, paths)).ops;
    };
    expectNearLinear("dropArtifactsFromReport", run(PROJECTS), run(PROJECTS * 8));
  });
});
