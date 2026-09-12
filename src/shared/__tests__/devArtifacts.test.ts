import { describe, expect, it } from "vitest";

import { classifyArtifactPath, mergeDiagLogHotspots } from "../devArtifacts";

describe("classifyArtifactPath", () => {
  it("detects node_modules at the package root", () => {
    expect(classifyArtifactPath("C:\\src\\app\\node_modules\\preact\\dist\\preact.js")).toEqual({
      root: "C:\\src\\app\\node_modules",
      kind: "node-modules",
    });
  });

  it("detects Rust debug targets", () => {
    expect(classifyArtifactPath("/home/dev/diskhound/target/debug/diskhound")).toEqual({
      root: "/home/dev/diskhound/target/debug",
      kind: "rust-target",
    });
  });

  it("classifies a bare target directory", () => {
    expect(classifyArtifactPath("C:\\src\\diskhound\\target")).toEqual({
      root: "C:\\src\\diskhound\\target",
      kind: "rust-target",
    });
  });

  it("detects git worktrees", () => {
    expect(classifyArtifactPath("C:\\Users\\thoma\\proj\\.worktrees\\feat-foo\\src\\main.ts")).toEqual({
      root: "C:\\Users\\thoma\\proj\\.worktrees\\feat-foo",
      kind: "worktree",
    });
  });

  it("detects pnpm store and cargo registry", () => {
    expect(classifyArtifactPath("/home/dev/.pnpm-store/v3/files/ab")).toMatchObject({
      kind: "package-cache",
    });
    expect(classifyArtifactPath("/home/dev/.cargo/registry/src/foo/lib.rs")).toMatchObject({
      kind: "cargo-registry",
    });
  });

  it("ignores ordinary documents", () => {
    expect(classifyArtifactPath("C:\\Users\\thoma\\Documents\\tax-2025.pdf")).toBeNull();
  });

  it("keeps UNC prefixes", () => {
    expect(classifyArtifactPath("\\\\nas\\share\\app\\node_modules\\x\\index.js")).toEqual({
      root: "\\\\nas\\share\\app\\node_modules",
      kind: "node-modules",
    });
  });

  it("classifies DiagOutputDir as the RDP / diag root", () => {
    expect(classifyArtifactPath(
      "C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir\\RdClientAutoTrace\\a.etl",
    )).toEqual({
      root: "C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir",
      kind: "diag-logs",
    });
  });

  it("classifies a standalone RdClientAutoTrace folder", () => {
    expect(classifyArtifactPath(
      "C:\\Users\\thoma\\AppData\\Local\\Temp\\RdClientAutoTrace\\a.etl",
    )).toEqual({
      root: "C:\\Users\\thoma\\AppData\\Local\\Temp\\RdClientAutoTrace",
      kind: "diag-logs",
    });
  });
});

describe("mergeDiagLogHotspots", () => {
  it("adds a DiagOutputDir hotspot missing from the sidecar", () => {
    const report = mergeDiagLogHotspots({
      artifacts: [{
        path: "C:\\proj\\node_modules",
        kind: "node-modules",
        projectPath: "C:\\proj",
        projectName: "proj",
        size: 100,
        fileCount: 2,
        previousSize: null,
        deltaBytes: null,
      }],
      totalBytes: 100,
      totalFiles: 2,
      projectCount: 1,
      kindTotals: [{ kind: "node-modules", size: 100, count: 1 }],
      generatedAt: 1,
      rootPath: "C:\\",
    }, [
      { path: "C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir", size: 9_980_000_000, fileCount: 40 },
      { path: "C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir\\RdClientAutoTrace", size: 9_900_000_000, fileCount: 38 },
    ]);
    expect(report.artifacts.some((a) => a.kind === "diag-logs")).toBe(true);
    expect(report.artifacts.find((a) => a.kind === "diag-logs")?.path)
      .toBe("C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir");
    expect(report.artifacts.find((a) => a.kind === "diag-logs")?.size).toBe(9_980_000_000);
    expect(report.totalBytes).toBe(9_980_000_100);
  });

  it("does not duplicate a sidecar root that already classified the folder", () => {
    const path = "C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir";
    const report = mergeDiagLogHotspots({
      artifacts: [{
        path,
        kind: "diag-logs",
        projectPath: null,
        projectName: "Unscoped",
        size: 50,
        fileCount: 3,
        previousSize: null,
        deltaBytes: null,
      }],
      totalBytes: 50,
      totalFiles: 3,
      projectCount: 0,
      kindTotals: [{ kind: "diag-logs", size: 50, count: 1 }],
      generatedAt: 1,
      rootPath: "C:\\",
    }, [{ path, size: 80, fileCount: 4 }]);
    expect(report.artifacts).toHaveLength(1);
    expect(report.totalBytes).toBe(50);
  });
});
