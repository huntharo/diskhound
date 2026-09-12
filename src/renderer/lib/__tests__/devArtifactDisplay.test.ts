import { describe, expect, it } from "vitest";

import type { DevArtifact } from "../../../shared/contracts";
import { artifactHeadline, artifactTail, shortenUnscopedParent } from "../devArtifactDisplay";

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

  it("names DiagOutputDir and shortens the Temp parent", () => {
    const row = artifact({
      path: "C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir",
      kind: "diag-logs",
    });
    expect(artifactHeadline(row)).toBe("DiagOutputDir");
    expect(artifactTail(row)).toBe("AppData\\Local\\Temp");
  });

  it("keeps a short unscoped parent as-is after the drive", () => {
    expect(shortenUnscopedParent("C:\\Windows\\Temp")).toBe("Windows\\Temp");
  });
});
