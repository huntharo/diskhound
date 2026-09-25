import { describe, expect, it } from "vitest";

import type { DevArtifact } from "../../../shared/contracts";
import {
  artifactHeadline,
  artifactTail,
  identifyingParent,
  isGenericArtifactLeaf,
  isUninformativeParent,
  shortenUnscopedParent,
  shortenVisiblePath,
} from "../devArtifactDisplay";

function artifact(partial: Partial<DevArtifact> & Pick<DevArtifact, "path">): DevArtifact {
  return {
    kind: "rust-target",
    projectPath: null,
    projectName: "Unscoped",
    size: 1,
    fileCount: 1,
    previousSize: null,
    deltaBytes: null,
    ...partial,
  };
}

describe("artifact display", () => {
  it("uses the project name and relative tree tail", () => {
    const row = artifact({
      path: "C:\\Users\\thoma\\local-experimentation\\crosslink_monolith\\zebra-crosslink\\target\\release",
      projectPath: "C:\\Users\\thoma\\local-experimentation\\crosslink_monolith\\zebra-crosslink",
      projectName: "zebra-crosslink",
    });
    expect(artifactHeadline(row)).toBe("zebra-crosslink");
    expect(artifactTail(row)).toBe("target\\release");
  });

  it("keeps a named project over a generic leaf", () => {
    const row = artifact({
      path: "C:\\Users\\thoma\\local-experimentation\\the-app\\.next",
      kind: "js-build",
      projectPath: "C:\\Users\\thoma\\local-experimentation\\the-app",
      projectName: "the-app",
    });
    expect(artifactHeadline(row)).toBe("the-app");
    expect(artifactTail(row)).toBe(".next");
  });

  it("names generic unscoped trees by the parent path", () => {
    const next = artifact({
      path: "C:\\Users\\thoma\\local-experimentation\\the-app\\.next",
      kind: "js-build",
    });
    expect(isGenericArtifactLeaf(".next")).toBe(true);
    expect(artifactHeadline(next)).toBe("C:\\Users\\thoma\\local-experimentation\\the-app");
    expect(artifactTail(next)).toBe(".next");
  });

  it("keeps a real project folder as the headline", () => {
    const hub = artifact({
      path: "C:\\Users\\thoma\\pour-over-hub\\.next",
      kind: "js-build",
    });
    expect(artifactHeadline(hub)).toBe("C:\\Users\\thoma\\pour-over-hub");
    expect(artifactTail(hub)).toBe(".next");

    const atomic = artifact({
      path: "C:\\Users\\thoma\\local-experimentation\\Atomic2wap\\target\\debug",
      kind: "rust-target",
    });
    expect(artifactHeadline(atomic)).toBe("C:\\Users\\thoma\\local-experimentation\\Atomic2wap");
    expect(artifactTail(atomic)).toBe("target\\debug");
  });

  it("puts the artifact leaf first when the parent is home or Temp", () => {
    const gradle = artifact({
      path: "C:\\Users\\thoma\\.gradle",
      kind: "jvm",
    });
    expect(artifactHeadline(gradle)).toBe(".gradle");
    expect(artifactTail(gradle)).toBe("C:\\Users\\thoma");

    const goMod = artifact({
      path: "C:\\Users\\thoma\\pkg\\mod",
      kind: "go-module",
    });
    expect(identifyingParent(goMod)).toBe("C:\\Users\\thoma");
    expect(artifactHeadline(goMod)).toBe("pkg\\mod");
    expect(artifactTail(goMod)).toBe("C:\\Users\\thoma");

    const diag = artifact({
      path: "C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir",
      kind: "diag-logs",
    });
    expect(artifactHeadline(diag)).toBe("DiagOutputDir");
    expect(artifactTail(diag)).toBe("C:\\Users\\thoma\\AppData\\Local\\Temp");
  });

  it("does not treat a home folder as a named project headline", () => {
    const row = artifact({
      path: "C:\\Users\\thoma\\.gradle",
      kind: "jvm",
      projectPath: "C:\\Users\\thoma",
      projectName: "thoma",
    });
    expect(isUninformativeParent("C:\\Users\\thoma")).toBe(true);
    expect(artifactHeadline(row)).toBe(".gradle");
    expect(artifactTail(row)).toBe("C:\\Users\\thoma");
  });

  it("walks past target\\debug to the crate folder", () => {
    const row = artifact({
      path: "C:\\Users\\thoma\\local-experimentation\\diskhound\\target\\debug",
      kind: "rust-target",
    });
    expect(identifyingParent(row)).toBe("C:\\Users\\thoma\\local-experimentation\\diskhound");
    expect(artifactHeadline(row)).toBe("C:\\Users\\thoma\\local-experimentation\\diskhound");
    expect(artifactTail(row)).toBe("target\\debug");
  });

  it("ignores a projectPath that is itself a generic leaf", () => {
    const row = artifact({
      path: "C:\\Users\\thoma\\local-experimentation\\the-app\\.next",
      kind: "js-build",
      projectPath: "C:\\Users\\thoma\\local-experimentation\\the-app\\.next",
      projectName: ".next",
    });
    expect(identifyingParent(row)).toBe("C:\\Users\\thoma\\local-experimentation\\the-app");
    expect(artifactHeadline(row)).toBe("C:\\Users\\thoma\\local-experimentation\\the-app");
    expect(artifactTail(row)).toBe(".next");
  });

  it("treats Unix home and Windows profile shells as uninformative", () => {
    expect(isUninformativeParent("/home/thoma")).toBe(true);
    expect(isUninformativeParent("C:\\Users\\thoma\\AppData\\Local")).toBe(true);
    expect(isUninformativeParent("C:\\Users\\thoma\\pour-over-hub")).toBe(false);
    expect(isUninformativeParent("C:\\Windows\\Temp")).toBe(true);
  });

  it("ellipsizes a long parent and keeps the drive and leaf", () => {
    const parent = "C:\\Users\\thoma\\local-experimentation\\crosslink_monolith\\zebra-crosslink";
    expect(shortenVisiblePath(parent, 40)).toBe("C:\\Users\\thoma\\…\\zebra-crosslink");
    expect(shortenVisiblePath("C:\\Users\\thoma\\.gradle")).toBe("C:\\Users\\thoma\\.gradle");
  });

  it("keeps the leading slash when ellipsizing a POSIX path", () => {
    expect(shortenVisiblePath("/Users/dev/local-experimentation/crosslink_monolith/zebra-crosslink", 40))
      .toBe("/Users/dev/…/zebra-crosslink");
    expect(shortenVisiblePath("/home/dev/local-experimentation/crosslink_monolith/zebra-crosslink", 40))
      .toBe("/home/…/zebra-crosslink");
    expect(shortenVisiblePath("/mnt/c/Users/dev/local-experimentation/crosslink_monolith/zebra-crosslink", 40))
      .toBe("/mnt/c/Users/dev/…/zebra-crosslink");
    expect(shortenVisiblePath("\\\\server\\share\\local-experimentation\\crosslink_monolith\\zebra-crosslink", 40))
      .toBe("\\\\server\\…\\zebra-crosslink");

    const row = artifact({
      path: "/Users/dev/local-experimentation/crosslink_monolith/zebra-crosslink/target/debug",
      kind: "rust-target",
    });
    expect(artifactHeadline(row)).toBe("/Users/dev/…/zebra-crosslink");
    expect(artifactTail(row)).toBe("target/debug");
  });

  it("keeps a short unscoped parent as-is after the drive", () => {
    expect(shortenUnscopedParent("C:\\Windows\\Temp")).toBe("Windows\\Temp");
  });

  it("joins tails with the source path's separator", () => {
    const posix = artifact({
      path: "/Users/dev/code/diskhound/target/debug",
      projectPath: "/Users/dev/code/diskhound",
      projectName: "diskhound",
    });
    expect(artifactHeadline(posix)).toBe("diskhound");
    expect(artifactTail(posix)).toBe("target/debug");

    const windows = artifact({
      path: "C:\\Users\\dev\\code\\diskhound\\target\\debug",
      projectPath: "C:\\Users\\dev\\code\\diskhound",
      projectName: "diskhound",
    });
    expect(artifactHeadline(windows)).toBe("diskhound");
    expect(artifactTail(windows)).toBe("target\\debug");
  });

  it("keeps POSIX separators for unscoped and home-level artifacts", () => {
    const crate = artifact({
      path: "/home/dev/code/diskhound/target/debug",
      kind: "rust-target",
    });
    expect(artifactHeadline(crate)).toBe("/home/dev/code/diskhound");
    expect(artifactTail(crate)).toBe("target/debug");

    const goMod = artifact({
      path: "/home/dev/pkg/mod",
      kind: "go-module",
    });
    expect(artifactHeadline(goMod)).toBe("pkg/mod");
    expect(artifactTail(goMod)).toBe("/home/dev");

    expect(shortenUnscopedParent("/opt/tools")).toBe("opt/tools");
    expect(shortenUnscopedParent("/var/lib/tools/cache")).toBe("lib/tools/cache");
    expect(shortenUnscopedParent("C:\\ProgramData\\tools\\cache\\x")).toBe("tools\\cache\\x");
  });
});
