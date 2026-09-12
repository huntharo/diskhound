import { describe, expect, it } from "vitest";

import type { DevArtifact } from "../../../shared/contracts";
import {
  artifactHeadline,
  artifactTail,
  identifyingParent,
  isGenericArtifactLeaf,
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

    const gradle = artifact({
      path: "C:\\Users\\thoma\\.gradle",
      kind: "jvm",
    });
    expect(artifactHeadline(gradle)).toBe("C:\\Users\\thoma");
    expect(artifactTail(gradle)).toBe(".gradle");
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

  it("names DiagOutputDir by the Temp parent path", () => {
    const row = artifact({
      path: "C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir",
      kind: "diag-logs",
    });
    expect(artifactHeadline(row)).toBe("C:\\Users\\thoma\\AppData\\Local\\Temp");
    expect(artifactTail(row)).toBe("DiagOutputDir");
  });

  it("ellipsizes a long parent and keeps the drive and leaf", () => {
    const parent = "C:\\Users\\thoma\\local-experimentation\\crosslink_monolith\\zebra-crosslink";
    expect(shortenVisiblePath(parent, 40)).toBe("C:\\Users\\thoma\\…\\zebra-crosslink");
    expect(shortenVisiblePath("C:\\Users\\thoma\\.gradle")).toBe("C:\\Users\\thoma\\.gradle");
  });

  it("keeps a short unscoped parent as-is after the drive", () => {
    expect(shortenUnscopedParent("C:\\Windows\\Temp")).toBe("Windows\\Temp");
  });
});
