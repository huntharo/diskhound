import { describe, expect, it } from "vitest";

import { defaultSettings, normalizeAppSettings } from "../contracts";

describe("experimental permanent delete setting", () => {
  it("keeps the existing walker for default and older settings", () => {
    expect(defaultSettings().cleanup.fastPermanentDelete).toBe(false);
    const old = JSON.parse(JSON.stringify(defaultSettings()));
    delete old.cleanup.fastPermanentDelete;
    expect(normalizeAppSettings(old).cleanup.fastPermanentDelete).toBe(false);
  });

  it("requires an explicit boolean opt-in", () => {
    const settings = defaultSettings();
    expect(normalizeAppSettings({
      ...settings, cleanup: { ...settings.cleanup, fastPermanentDelete: true },
    }).cleanup.fastPermanentDelete).toBe(true);
    const malformed = JSON.parse(JSON.stringify(settings));
    malformed.cleanup.fastPermanentDelete = "true";
    expect(normalizeAppSettings(malformed).cleanup.fastPermanentDelete).toBe(false);
  });
});
