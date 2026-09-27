import { afterEach, describe, expect, it, vi } from "vitest";

import { formatBytes, formatBytesRange, setSizeUnitPreference, subscribeSizeUnits } from "../format";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

describe("formatBytesRange", () => {
  it("shares the unit when both ends have it", () => {
    expect(formatBytesRange(684 * GiB, 694 * GiB)).toBe("684–694 GB");
  });

  it("spells out both ends when the units differ", () => {
    expect(formatBytesRange(0, 32 * MiB)).toBe("0 B – 32.0 MB");
    expect(formatBytesRange(900 * MiB, 1.5 * GiB)).toBe("900 MB – 1.5 GB");
  });

  it("gives one value when both ends format alike", () => {
    expect(formatBytesRange(684 * GiB, 684.2 * GiB)).toBe("684 GB");
  });
});


afterEach(() => {
  setSizeUnitPreference(undefined);
  vi.unstubAllGlobals();
});

it("uses the renderer platform and updates ranges when the preference changes", () => {
  vi.stubGlobal("window", { diskhound: { platform: "darwin" } });
  expect(formatBytes(686.22e9)).toBe("686 GB");
  expect(formatBytesRange(0, 32 * MiB)).toBe("0 B – 33.6 MB");
  const listener = vi.fn();
  const unsubscribe = subscribeSizeUnits(listener);
  setSizeUnitPreference("binary");
  expect(listener).toHaveBeenCalledTimes(1);
  expect(formatBytes(686.22e9)).toBe("639 GB");
  expect(formatBytesRange(0, 32 * MiB)).toBe("0 B – 32.0 MB");
  setSizeUnitPreference("binary");
  expect(listener).toHaveBeenCalledTimes(1);
  setSizeUnitPreference(undefined);
  expect(listener).toHaveBeenCalledTimes(2);
  expect(formatBytes(686.22e9)).toBe("686 GB");
  unsubscribe();
});
