import { describe, expect, it } from "vitest";

import { classifyArtifactPath } from "../devArtifacts";

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
});
