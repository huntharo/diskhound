import { describe, expect, it } from "vitest";

import {
  ARTIFACT_SEGMENT_NAMES,
  classifyArtifactPath,
  dropArtifactsFromReport,
  mergeDiagLogHotspots,
} from "../devArtifacts";

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

  it("detects Terraform provider downloads", () => {
    expect(classifyArtifactPath(
      "/Users/me/infra/env/prod/.terraform/providers/registry.terraform.io/hashicorp/aws/6.54.0/darwin_arm64/terraform-provider-aws_v6.54.0_x5",
    )).toEqual({ root: "/Users/me/infra/env/prod/.terraform/providers", kind: "terraform" });
    // Terraform 0.13 and older put them under .terraform/plugins.
    expect(classifyArtifactPath(
      "C:\\infra\\old\\.terraform\\plugins\\windows_amd64\\terraform-provider-aws_v2.70.0_x4.exe",
    )).toEqual({ root: "C:\\infra\\old\\.terraform\\plugins", kind: "terraform" });
    expect(classifyArtifactPath(
      "/home/me/.terraform.d/plugin-cache/registry.terraform.io/hashicorp/aws/6.54.0/linux_amd64/terraform-provider-aws_v6.54.0_x5",
    )).toEqual({ root: "/home/me/.terraform.d/plugin-cache", kind: "terraform" });
  });

  it("leaves Terraform state, modules and hand-installed providers alone", () => {
    for (const path of [
      "/Users/me/infra/env/prod/.terraform/terraform.tfstate",
      "/Users/me/infra/env/prod/.terraform/environment",
      "/Users/me/infra/env/prod/.terraform/modules/modules.json",
      "/Users/me/infra/env/prod/.terraform",
      "/home/me/.terraform.d/plugins/example.com/me/thing/1.0.0/linux_amd64/terraform-provider-thing",
    ]) {
      expect(classifyArtifactPath(path), path).toBeNull();
    }
  });

  it("ignores ordinary documents", () => {
    expect(classifyArtifactPath("C:\\Users\\thoma\\Documents\\tax-2025.pdf")).toBeNull();
  });

  it("ignores folders named after Object.prototype members", () => {
    // These used to match through the plain-object kind lookup, with a
    // function as the kind.
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(classifyArtifactPath(`/src/app/${name}/index.ts`), name).toBeNull();
    }
  });

  it("lists only lowercase ASCII names that can start a match", () => {
    for (const name of ARTIFACT_SEGMENT_NAMES) {
      expect(name, name).toMatch(/^[\x21-\x7e]+$/);
      expect(name.toLowerCase(), name).toBe(name);
      const inside = classifyArtifactPath(`/p/${name}/debug/x`) ?? classifyArtifactPath(`/p/${name}/registry/x`)
        ?? classifyArtifactPath(`/p/${name}/mod/x`) ?? classifyArtifactPath(`/p/${name}/ccache/x`)
        ?? classifyArtifactPath(`/p/${name}/providers/x`) ?? classifyArtifactPath(`/p/${name}/plugin-cache/x`);
      expect(inside, name).not.toBeNull();
    }
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

  it("does not restore a deleted DiagOutputDir from scan hotspots", () => {
    const path = "C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir";
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
      droppedPaths: [path],
    }, [{ path, size: 9_980_000_000, fileCount: 40 }]);
    expect(report.artifacts.some((a) => a.kind === "diag-logs")).toBe(false);
    expect(report.totalBytes).toBe(100);
  });
});

describe("dropArtifactsFromReport", () => {
  it("subtracts size from totals and kind chips immediately", () => {
    const report = dropArtifactsFromReport({
      artifacts: [
        {
          path: "C:\\proj\\node_modules",
          kind: "node-modules",
          projectPath: "C:\\proj",
          projectName: "proj",
          size: 80,
          fileCount: 4,
          previousSize: null,
          deltaBytes: null,
        },
        {
          path: "C:\\proj\\target",
          kind: "rust-target",
          projectPath: "C:\\proj",
          projectName: "proj",
          size: 20,
          fileCount: 2,
          previousSize: null,
          deltaBytes: null,
        },
      ],
      totalBytes: 100,
      totalFiles: 6,
      projectCount: 1,
      kindTotals: [
        { kind: "node-modules", size: 80, count: 1 },
        { kind: "rust-target", size: 20, count: 1 },
      ],
      generatedAt: 1,
      rootPath: "C:\\",
    }, ["C:\\proj\\node_modules"]);
    expect(report.totalBytes).toBe(20);
    expect(report.totalFiles).toBe(2);
    expect(report.artifacts).toHaveLength(1);
    expect(report.kindTotals).toEqual([{ kind: "rust-target", size: 20, count: 1 }]);
    expect(report.droppedPaths).toEqual(["C:\\proj\\node_modules"]);
  });
});
