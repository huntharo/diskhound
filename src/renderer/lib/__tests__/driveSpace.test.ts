import { describe, expect, it } from "vitest";
import { driveSpaceLabel, driveUsedPercent, formatDriveSpace } from "../driveSpace";

const drive = { totalBytes: 2e12, freeBytes: 37.28e9, usedPercent: 98.136 };

describe("drive space presentation", () => {
  it("retains the raw-free label and usage for Linux, Windows, and macOS fallback", () => {
    expect(driveSpaceLabel(drive)).toBe("free");
    expect(formatDriveSpace(drive)).toBe("34.7 GB free");
    expect(driveUsedPercent(drive)).toBe(drive.usedPercent);
  });

  it("includes purgeable in Available and excludes it from the pressure bar", () => {
    const mac = { ...drive, availableBytes: 723.5e9, purgeableBytes: 686.22e9 };
    expect(formatDriveSpace(mac)).toBe("674 GB available · 639 GB purgeable");
    expect(driveUsedPercent(mac)).toBeCloseTo(63.825);
  });

  it("distinguishes missing purgeable data from a known zero", () => {
    expect(formatDriveSpace({ ...drive, availableBytes: 0 })).toBe("0 B available");
    expect(formatDriveSpace({ ...drive, availableBytes: 0, purgeableBytes: 0 }))
      .toBe("0 B available · 0 B purgeable");
  });
});
