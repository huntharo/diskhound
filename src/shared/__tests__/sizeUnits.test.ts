import { describe, expect, it } from "vitest";
import { defaultSettings, normalizeAppSettings } from "../contracts";
import { formatSizeBytes, resolveSizeUnitBase } from "../sizeUnits";

describe("size units", () => {
  it.each(["darwin", "win32", "linux"])("uses the %s default unless explicitly overridden", (platform) => {
    expect(resolveSizeUnitBase(undefined, platform)).toBe(platform === "darwin" ? 1000 : 1024);
    expect(resolveSizeUnitBase("decimal", platform)).toBe(1000);
    expect(resolveSizeUnitBase("binary", platform)).toBe(1024);
  });

  it("omits the override from both new and normalized default configurations", () => {
    expect(defaultSettings().general).not.toHaveProperty("sizeUnits");
    expect(normalizeAppSettings().general).not.toHaveProperty("sizeUnits");
    for (const sizeUnits of [undefined, null, "platform", "invalid", 1000]) {
      const settings = defaultSettings();
      Object.assign(settings.general, { sizeUnits });
      expect(normalizeAppSettings(settings).general).not.toHaveProperty("sizeUnits");
    }
    for (const sizeUnits of ["decimal", "binary"] as const) {
      const settings = defaultSettings();
      settings.general.sizeUnits = sizeUnits;
      expect(normalizeAppSettings(settings).general.sizeUnits).toBe(sizeUnits);
    }
  });

  it.each([
    [0, "0 B", "0 B"], [1000, "1.0 KB", "1000 B"],
    [32 * 1024 ** 2, "33.6 MB", "32.0 MB"],
    [686.22e9, "686 GB", "639 GB"], [723.5e9, "724 GB", "674 GB"],
    [2e12, "2.0 TB", "1.8 TB"],
  ])("formats %i bytes using decimal or legacy binary labels", (bytes, decimal, binary) => {
    expect(formatSizeBytes(bytes, 1000)).toBe(decimal);
    expect(formatSizeBytes(bytes, 1024)).toBe(binary);
  });
});
