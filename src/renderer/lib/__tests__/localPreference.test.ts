import { describe, expect, it, vi } from "vitest";

import { saveLocalPreference } from "../localPreference";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

describe("saveLocalPreference", () => {
  it("writes nothing when a view remounts with the preferences it stored", () => {
    // What Overview persists on mount: six keys, all unchanged since last time.
    const stored = {
      "diskhound:treemap-mode": "condensed",
      "diskhound:treemap-layout": "size",
      "diskhound:ext-sidebar-collapsed": "0",
      "diskhound:treemap-recent-on": "0",
      "diskhound:treemap-recent-window": "30d",
      "diskhound:treemap-folders": "1",
    };
    const storage = memoryStorage(stored);

    for (let mount = 0; mount < 50; mount++) {
      for (const [key, value] of Object.entries(stored)) saveLocalPreference(key, value, storage);
    }

    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("writes once when the value changes or was never stored", () => {
    const storage = memoryStorage({ "diskhound:treemap-mode": "condensed" });

    saveLocalPreference("diskhound:treemap-mode", "all", storage);
    saveLocalPreference("diskhound:treemap-mode", "all", storage);
    saveLocalPreference("diskhound:new-key", "1", storage);

    expect(storage.setItem.mock.calls).toEqual([
      ["diskhound:treemap-mode", "all"],
      ["diskhound:new-key", "1"],
    ]);
  });

  it("swallows storage errors", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => saveLocalPreference("k", "v", storage)).not.toThrow();
  });
});
