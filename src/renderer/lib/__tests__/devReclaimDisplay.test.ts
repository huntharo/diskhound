import { afterEach, describe, expect, it } from "vitest";

import type { DevArtifact } from "../../../shared/contracts";
import { setSizeUnitPreference } from "../format";
import { overviewDevTileDisplay } from "../devReclaimDisplay";

const GB = 1_000_000_000;

function artifact(size: number, clone?: DevArtifact["clone"]): DevArtifact {
  return {
    path: "/work/app/node_modules",
    kind: "node-modules",
    projectPath: "/work/app",
    projectName: "app",
    size,
    fileCount: 1,
    previousSize: null,
    deltaBytes: null,
    clone,
  };
}

afterEach(() => setSizeUnitPreference(undefined));

describe("Overview Dev Artifacts tile", () => {
  it("leads with the Dev tab's reclaimable range and qualifies the listed total", () => {
    setSizeUnitPreference("decimal");
    const display = overviewDevTileDisplay([artifact(216 * GB, {
      cloneSize: 195.2 * GB,
      clonePrivateSize: 0,
      cloneInternalSize: 0,
      cloneSharedSize: 195.2 * GB,
      cloneSharedBlocks: 10.6 * GB,
      sharedRoots: 1,
      sharedWith: [],
    })]);
    expect(display).toMatchObject({
      value: "20.8–31.4 GB",
      label: "dev artifacts reclaimable",
      secondary: "216 GB listed",
      listedBytes: 216 * GB,
      freesBytes: 20.8 * GB,
      freesAtMostBytes: 31.4 * GB,
    });
    expect(display?.title).toMatch(/deleting every listed tree.*20.8 GB.*31.4 GB/i);
    expect(display?.title).toMatch(/snapshots.*delay/i);
  });

  it("keeps unmeasured tree sizes labelled as listed, not reclaimable", () => {
    setSizeUnitPreference("decimal");
    const display = overviewDevTileDisplay([artifact(216 * GB)]);
    expect(display).toMatchObject({
      value: "216 GB",
      label: "dev artifacts listed",
      secondary: null,
    });
    expect(display?.title).toMatch(/clone measurements are unavailable/i);
  });

  it("qualifies the range if some trees have no clone measurements", () => {
    setSizeUnitPreference("decimal");
    const display = overviewDevTileDisplay([
      artifact(100 * GB, {
        cloneSize: 90 * GB,
        clonePrivateSize: 0,
        cloneInternalSize: 0,
        cloneSharedSize: 90 * GB,
        cloneSharedBlocks: 10 * GB,
        sharedRoots: 1,
        sharedWith: [],
      }),
      artifact(25 * GB),
    ]);
    expect(display?.value).toBe("35.0–45.0 GB");
    expect(display?.title).toMatch(/some trees had no clone measurements/i);
  });

  it("does not promote a negligible clone adjustment or an empty report", () => {
    setSizeUnitPreference("decimal");
    expect(overviewDevTileDisplay([])).toBeNull();
    const display = overviewDevTileDisplay([artifact(100 * GB, {
      cloneSize: 1 * GB,
      clonePrivateSize: 0,
      cloneInternalSize: 0,
      cloneSharedSize: 1 * GB,
      cloneSharedBlocks: 1 * GB,
      sharedRoots: 1,
      sharedWith: [],
    })]);
    expect(display).toMatchObject({ value: "100 GB", label: "dev artifacts listed" });
  });
});
