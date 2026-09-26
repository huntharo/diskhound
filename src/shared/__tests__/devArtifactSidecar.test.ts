import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tempDir: string;

beforeEach(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-dev-sidecar-"));
});

afterEach(async () => {
  await FSP.rm(tempDir, { recursive: true, force: true });
});

describe("noteDevFile", () => {
  it("rolls node_modules occupancy and skips extra hardlinks", async () => {
    const { createDevAcc, noteDevFile, sidecarFromAcc, reportFromSidecar } = await import("../devArtifactSidecar");
    const acc = createDevAcc();
    noteDevFile(acc, "C:\\proj\\package.json", 200, false);
    noteDevFile(acc, "C:\\proj\\node_modules\\preact\\dist\\preact.js", 5_000_000, false);
    noteDevFile(acc, "C:\\proj\\node_modules\\dup\\x.js", 5_000_000, true);

    const result = reportFromSidecar(sidecarFromAcc(acc, "C:\\proj"));
    expect(result.totalBytes).toBe(5_000_000);
    expect(result.artifacts.some((a) => a.kind === "node-modules")).toBe(true);
  });
});

describe("sidecarFromDirectoryRoots", () => {
  it("keeps the outer target folder and skips target/debug", async () => {
    const { sidecarFromDirectoryRoots, reportFromSidecar } = await import("../devArtifactSidecar");
    const sidecar = sidecarFromDirectoryRoots("C:\\", [
      { path: "C:\\proj\\target", size: 80_000_000, files: 400 },
      { path: "C:\\proj\\target\\debug", size: 50_000_000, files: 300 },
      { path: "C:\\proj\\node_modules", size: 20_000_000, files: 100 },
      { path: "C:\\proj\\node_modules\\preact", size: 1_000_000, files: 10 },
    ], ["C:\\proj"]);
    const report = reportFromSidecar(sidecar);
    expect(report.totalBytes).toBe(100_000_000);
    expect(report.artifacts.map((a) => a.path).sort()).toEqual([
      "C:\\proj\\node_modules",
      "C:\\proj\\target",
    ]);
  });
});

describe("dropNestedRoots", () => {
  it("drops roots under another root, whatever the case or separator", async () => {
    const { createDevAcc, dropNestedRoots } = await import("../devArtifactSidecar");
    const acc = createDevAcc();
    for (const path of [
      "C:\\proj\\target\\debug",
      "C:\\proj\\target",
      "C:\\Proj\\Target\\release",
      "/w/.worktrees/feat",
      "/w/.worktrees",
      "/w/targets",
      "/w/targets2/debug",
    ]) {
      acc.artifacts.set(path, { kind: "rust-target", size: 1, files: 1 });
    }
    dropNestedRoots(acc);
    expect([...acc.artifacts.keys()]).toEqual([
      "C:\\proj\\target",
      "/w/.worktrees",
      "/w/targets",
      "/w/targets2/debug",
    ]);
  });
});

describe("projectCanOwnArtifact", () => {
  it("rules out projects inside an artifact tree", async () => {
    const { projectCanOwnArtifact } = await import("../devArtifactSidecar");
    expect(projectCanOwnArtifact("/src/app")).toBe(true);
    expect(projectCanOwnArtifact("/src/app/target")).toBe(true);
    expect(projectCanOwnArtifact("/src/app/.worktrees/feat")).toBe(true);
    expect(projectCanOwnArtifact("/src/app/node_modules/preact")).toBe(false);
    expect(projectCanOwnArtifact("C:\\src\\app\\Node_Modules\\@scope\\pkg")).toBe(false);
    expect(projectCanOwnArtifact("/src/app/.worktrees/feat/packages/ui")).toBe(false);
  });
});

describe("resolveDevArtifactSidecar", () => {
  it("returns the history sidecar when it already exists", async () => {
    const { resolveDevArtifactSidecar, writeDevArtifactSidecar } = await import("../devArtifactSidecar");
    const dest = Path.join(tempDir, "scan.dev-artifacts.json");
    await writeDevArtifactSidecar(dest, {
      version: 1,
      rootPath: "C:\\",
      generatedAt: 1,
      roots: [{ path: "C:\\proj\\node_modules", kind: "node-modules", size: 10, files: 1 }],
      projects: ["C:\\proj"],
    });
    const sidecar = await resolveDevArtifactSidecar(dest, "C:\\", [
      Path.join(tempDir, "pending-other.dev-artifacts.json"),
    ]);
    expect(sidecar?.roots).toHaveLength(1);
    expect(sidecar?.roots[0]?.path).toBe("C:\\proj\\node_modules");
  });

  it("adopts a pending sidecar for the same scan root", async () => {
    const { resolveDevArtifactSidecar, writeDevArtifactSidecar, readDevArtifactSidecar } = await import("../devArtifactSidecar");
    const dest = Path.join(tempDir, "history.dev-artifacts.json");
    const pending = Path.join(tempDir, "pending-abc.dev-artifacts.json");
    await writeDevArtifactSidecar(pending, {
      version: 1,
      rootPath: "C:\\",
      generatedAt: 2,
      roots: [{ path: "C:\\proj\\target", kind: "rust-target", size: 50, files: 3 }],
      projects: ["C:\\proj"],
    });
    const sidecar = await resolveDevArtifactSidecar(dest, "C:\\", [pending]);
    expect(sidecar?.roots[0]?.kind).toBe("rust-target");
    expect(await readDevArtifactSidecar(dest)).not.toBeNull();
    await expect(FSP.access(pending)).rejects.toThrow();
  });

  it("ignores a pending sidecar for a different root", async () => {
    const { resolveDevArtifactSidecar, writeDevArtifactSidecar } = await import("../devArtifactSidecar");
    const dest = Path.join(tempDir, "history-d.dev-artifacts.json");
    const pending = Path.join(tempDir, "pending-d.dev-artifacts.json");
    await writeDevArtifactSidecar(pending, {
      version: 1,
      rootPath: "D:\\",
      generatedAt: 3,
      roots: [{ path: "D:\\proj\\node_modules", kind: "node-modules", size: 9, files: 1 }],
      projects: ["D:\\proj"],
    });
    await expect(resolveDevArtifactSidecar(dest, "C:\\", [pending])).resolves.toBeNull();
  });
});

describe("loadDevArtifactReport", () => {
  it("opens a compact sidecar without a worker", async () => {
    const { loadDevArtifactReport, writeDevArtifactSidecar } = await import("../devArtifactSidecar");
    const dest = Path.join(tempDir, "history.dev-artifacts.json");
    await writeDevArtifactSidecar(dest, {
      version: 1,
      rootPath: "C:\\",
      generatedAt: 4,
      roots: [{ path: "C:\\proj\\node_modules", kind: "node-modules", size: 42, files: 3 }],
      projects: ["C:\\proj"],
    });
    const report = await loadDevArtifactReport(dest, "C:\\", []);
    expect(report?.rootPath).toBe("C:\\");
    expect(report?.totalBytes).toBe(42);
    expect(report?.artifacts[0]?.path).toBe("C:\\proj\\node_modules");
  });

  it("adopts a pending sidecar for the same root", async () => {
    const { loadDevArtifactReport, writeDevArtifactSidecar } = await import("../devArtifactSidecar");
    const dest = Path.join(tempDir, "adopt.dev-artifacts.json");
    const pending = Path.join(tempDir, "pending-load.dev-artifacts.json");
    await writeDevArtifactSidecar(pending, {
      version: 1,
      rootPath: "C:\\",
      generatedAt: 5,
      roots: [{ path: "C:\\proj\\target", kind: "rust-target", size: 80, files: 4 }],
      projects: ["C:\\proj"],
    });
    const report = await loadDevArtifactReport(dest, "C:\\", [pending]);
    expect(report?.artifacts[0]?.kind).toBe("rust-target");
  });

  it("throws when the dest sidecar exists but is unreadable", async () => {
    const { loadDevArtifactReport } = await import("../devArtifactSidecar");
    const dest = Path.join(tempDir, "broken.dev-artifacts.json");
    await FSP.writeFile(dest, "{not-json");
    await expect(loadDevArtifactReport(dest, "C:\\", [])).rejects.toThrow(/exists but could not be read/);
  });
});

describe("compactDevArtifactSidecar", () => {
  it("keeps the largest trees and only projects that own them", async () => {
    const { compactDevArtifactSidecar, DEV_SIDECAR_ROOT_CAP } = await import("../devArtifactSidecar");
    const roots = Array.from({ length: DEV_SIDECAR_ROOT_CAP + 40 }, (_, i) => ({
      path: `C:\\p${i}\\node_modules`,
      kind: "node-modules" as const,
      size: i + 1,
      files: 1,
    }));
    const compact = compactDevArtifactSidecar({
      version: 1,
      rootPath: "C:\\",
      generatedAt: 1,
      roots,
      projects: [
        ...Array.from({ length: DEV_SIDECAR_ROOT_CAP + 40 }, (_, i) => `C:\\p${i}`),
        "C:\\orphan",
      ],
    });
    expect(compact.roots).toHaveLength(DEV_SIDECAR_ROOT_CAP);
    expect(compact.roots[0]?.path).toBe(`C:\\p${DEV_SIDECAR_ROOT_CAP + 39}\\node_modules`);
    expect(compact.projects).toHaveLength(DEV_SIDECAR_ROOT_CAP);
    expect(compact.projects).not.toContain("C:\\orphan");
  });
});

describe("reportFromSidecar", () => {
  it("keeps dist/ only when a project marker exists", async () => {
    const { reportFromSidecar } = await import("../devArtifactSidecar");
    const report = reportFromSidecar({
      version: 1,
      rootPath: "C:\\",
      generatedAt: 1,
      roots: [
        { path: "C:\\proj\\dist", kind: "js-build", size: 9_000_000, files: 10 },
        { path: "C:\\proj\\node_modules", kind: "node-modules", size: 5_000_000, files: 20 },
      ],
      projects: ["C:\\proj"],
    });
    expect(report.totalBytes).toBe(14_000_000);
    expect(report.artifacts.map((a) => a.kind).sort()).toEqual(["js-build", "node-modules"]);
  });

  it("picks the nearest project among thousands", async () => {
    const { reportFromSidecar } = await import("../devArtifactSidecar");
    const projects = Array.from({ length: 3_000 }, (_, i) => `C:\\p${i}\\app`);
    projects.push("C:\\real\\app");
    const report = reportFromSidecar({
      version: 1,
      rootPath: "C:\\",
      generatedAt: 1,
      roots: [
        { path: "C:\\real\\app\\node_modules", kind: "node-modules", size: 10, files: 1 },
      ],
      projects,
    });
    expect(report.artifacts[0]?.projectPath).toBe("C:\\real\\app");
  });
});

describe("planRescanTargets", () => {
  it("walks known roots only and does not expand project hints", async () => {
    const { planRescanTargets, PROJECT_CHILD_HINTS } = await import("../devArtifactSidecar");
    expect(PROJECT_CHILD_HINTS.length).toBeGreaterThan(5);
    const projects = Array.from({ length: 200 }, (_, i) => `C:\\p${i}`);
    const targets = planRescanTargets({
      version: 1,
      rootPath: "C:\\",
      generatedAt: 1,
      roots: [
        { path: "C:\\a\\node_modules", kind: "node-modules", size: 1, files: 1 },
        { path: "C:\\a\\node_modules", kind: "node-modules", size: 1, files: 1 },
        { path: "C:\\b\\target", kind: "rust-target", size: 2, files: 2 },
      ],
      projects,
    });
    expect(targets).toEqual(["C:\\a\\node_modules", "C:\\b\\target"]);
    expect(targets.length).toBeLessThan(projects.length);
  });

  it("adds a seeded DiagOutputDir that is not already a sidecar root", async () => {
    const { planRescanTargets } = await import("../devArtifactSidecar");
    const targets = planRescanTargets({
      version: 1,
      rootPath: "C:\\",
      generatedAt: 1,
      roots: [{ path: "C:\\a\\node_modules", kind: "node-modules", size: 1, files: 1 }],
      projects: [],
    }, ["C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir"]);
    expect(targets).toEqual([
      "C:\\a\\node_modules",
      "C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir",
    ]);
  });

  it("drops a nested RdClientAutoTrace seed under DiagOutputDir", async () => {
    const { planRescanTargets } = await import("../devArtifactSidecar");
    const targets = planRescanTargets({
      version: 1,
      rootPath: "C:\\",
      generatedAt: 1,
      roots: [{
        path: "C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir",
        kind: "diag-logs",
        size: 1,
        files: 1,
      }],
      projects: [],
    }, [
      "C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir",
      "C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir\\RdClientAutoTrace",
    ]);
    expect(targets).toEqual(["C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir"]);
  });
});

describe("discoverDiagLogRoots", () => {
  it("finds DiagOutputDir under a fake Users profile", async () => {
    const { discoverDiagLogRoots } = await import("../devArtifactSidecar");
    const drive = Path.join(tempDir, "drive");
    const diag = Path.join(drive, "Users", "thoma", "AppData", "Local", "Temp", "DiagOutputDir");
    await FSP.mkdir(diag, { recursive: true });
    const found = discoverDiagLogRoots(drive);
    expect(found.some((p) => p.toLowerCase().endsWith("diagoutputdir"))).toBe(true);
  });
});

describe("dropSidecarRoots", () => {
  it("removes the tree and records it so a reread cannot restore it", async () => {
    const { dropSidecarRoots, reportFromSidecar } = await import("../devArtifactSidecar");
    const dropped = dropSidecarRoots({
      version: 1,
      rootPath: "C:\\",
      generatedAt: 1,
      roots: [
        { path: "C:\\proj\\node_modules", kind: "node-modules", size: 80, files: 4 },
        { path: "C:\\proj\\target", kind: "rust-target", size: 20, files: 2 },
      ],
      projects: ["C:\\proj"],
    }, ["C:\\PROJ\\node_modules"]);
    expect(dropped.roots.map((r) => r.path)).toEqual(["C:\\proj\\target"]);
    expect(dropped.droppedPaths).toEqual(["C:\\PROJ\\node_modules"]);
    const report = reportFromSidecar(dropped);
    expect(report.totalBytes).toBe(20);
    expect(report.droppedPaths).toEqual(["C:\\PROJ\\node_modules"]);
  });

  it("records a hotspot-only path that was never a sidecar root", async () => {
    const { dropSidecarRoots } = await import("../devArtifactSidecar");
    const dropped = dropSidecarRoots({
      version: 1,
      rootPath: "C:\\",
      generatedAt: 1,
      roots: [{ path: "C:\\proj\\node_modules", kind: "node-modules", size: 10, files: 1 }],
      projects: ["C:\\proj"],
    }, ["C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir"]);
    expect(dropped.roots).toHaveLength(1);
    expect(dropped.droppedPaths).toEqual(["C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir"]);
  });
});

describe("rescanDevArtifactSidecar", () => {
  it("re-walks a known root and emits progress", async () => {
    const { writeDevArtifactSidecar, readDevArtifactSidecar, rescanDevArtifactSidecar } = await import("../devArtifactSidecar");
    const tree = Path.join(tempDir, "proj", "node_modules", "pkg");
    await FSP.mkdir(tree, { recursive: true });
    await FSP.writeFile(Path.join(tree, "index.js"), "x".repeat(100));
    const sidecarPath = Path.join(tempDir, "scan.dev-artifacts.json");
    await writeDevArtifactSidecar(sidecarPath, {
      version: 1,
      rootPath: tempDir,
      generatedAt: 1,
      roots: [{ path: Path.join(tempDir, "proj", "node_modules"), kind: "node-modules", size: 1, files: 1 }],
      projects: [Path.join(tempDir, "proj")],
      droppedPaths: ["C:\\gone\\node_modules"],
    });
    const sidecar = await readDevArtifactSidecar(sidecarPath);
    const ticks: number[] = [];
    const next = await rescanDevArtifactSidecar(sidecar!, (progress) => {
      ticks.push(progress.treesWalked);
      expect(progress.treesTotal).toBe(1);
    });
    expect(next.roots[0]?.files).toBe(1);
    expect(next.roots[0]?.size).toBeGreaterThanOrEqual(100);
    expect(next.droppedPaths).toEqual(["C:\\gone\\node_modules"]);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0]).toBe(0);
  });
});
