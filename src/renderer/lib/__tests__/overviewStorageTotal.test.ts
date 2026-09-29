import { describe, expect, it } from "vitest";

import type { ScanSnapshot } from "../../../shared/contracts";
import { overviewStorageTotal } from "../overviewStorageTotal";

function scan(overrides: Partial<ScanSnapshot> = {}): ScanSnapshot {
  return {
    status: "done",
    engine: "native-sidecar",
    rootPath: "/",
    scanOptions: {},
    startedAt: 1,
    finishedAt: 2,
    elapsedMs: 1,
    filesVisited: 3,
    directoriesVisited: 1,
    skippedEntries: 0,
    bytesSeen: 1_000,
    largestFiles: [],
    hottestDirectories: [],
    topExtensions: [],
    errorMessage: null,
    lastUpdatedAt: 2,
    sizeSemantics: "allocated",
    ...overrides,
  };
}

const accounting = {
  measuredFiles: 3,
  measuredBytes: 1_000,
  cloneFiles: 2,
  cloneBytes: 600,
  clonePrivateBytes: 0,
  cloneDuplicateBytes: 200,
};

describe("Overview storage total presentation", () => {
  it("keeps bytesSeen as scanned file bytes and subtracts only known full-clone repeats", () => {
    const display = overviewStorageTotal(scan({ storageAccounting: accounting }));
    expect(display.primaryBytes).toBe(1_000);
    expect(display.primaryLabel).toBe("scanned file bytes");
    expect(display.primaryTitle).toMatch(/shared clone blocks count for each file/i);
    expect(display.adjustedBytes).toBe(800);
    expect(display.adjustedLabel).toBe("after known clone repeats");
    expect(display.adjustedTitle).toMatch(/estimate.*not physical disk usage/i);
  });

  it("omits the estimate without measured clone groups, including old and unfinished scans", () => {
    expect(overviewStorageTotal(scan()).adjustedBytes).toBeNull();
    const legacy = overviewStorageTotal(scan({ sizeSemantics: undefined }));
    expect(legacy.primaryTitle).toMatch(/older scan.*rescan/i);
    expect(overviewStorageTotal(scan({ storageAccounting: {
      ...accounting, cloneDuplicateBytes: null,
    } })).adjustedBytes).toBeNull();
    expect(overviewStorageTotal(scan({ storageAccounting: {
      ...accounting, measuredFiles: 0,
    } })).adjustedBytes).toBeNull();
  });

  it("shows a zero-repeat estimate when group tracking completed", () => {
    const display = overviewStorageTotal(scan({ storageAccounting: {
      ...accounting, cloneDuplicateBytes: 0,
    } }));
    expect(display.adjustedBytes).toBe(1_000);
    expect(display.adjustedTitle).toMatch(/known full-clone repeats/i);
  });

  it("qualifies partial clone measurements and skipped entries", () => {
    const display = overviewStorageTotal(scan({
      skippedEntries: 2,
      storageAccounting: { ...accounting, measuredBytes: 700 },
    }));
    expect(display.primaryTitle).toMatch(/skipped entries/i);
    expect(display.adjustedBytes).toBe(800);
    expect(display.adjustedTitle).toMatch(/clone attributes were not measured for all scanned bytes/i);
    expect(display.adjustedTitle).toMatch(/skipped entries/i);
  });

  it("qualifies a truncated clone-group count as a lower bound on repeats", () => {
    const display = overviewStorageTotal(scan({ storageAccounting: {
      ...accounting, approximate: true,
    } }));
    expect(display.adjustedBytes).toBe(800);
    expect(display.adjustedTitle).toMatch(/known full-clone repeats are a lower bound/i);
    expect(display.adjustedTitle).toMatch(/truncated.*may be high/i);
  });
});
