import { describe, expect, it } from "vitest";

import { defaultSettings, normalizeAppSettings } from "../contracts";
import {
  DEFAULT_POWER_EFFICIENCY,
  effectivePowerEfficiency,
  offeredPowerEfficiencies,
  POWER_EFFICIENCY_PRESETS,
  powerEfficiencyLabel,
  powerEfficiencySignal,
  powerEfficiencyWorkers,
  type PowerEfficiency,
} from "../powerEfficiency";

/** Offered presets at each CPU count, 1 to 18: each must add workers. */
const OFFERED: Record<number, PowerEfficiency[]> = {};
for (let cpus = 1; cpus <= 18; cpus++) {
  OFFERED[cpus] = cpus <= 2 ? ["miser"]
    : cpus <= 4 ? ["miser", "balanced"]
    : cpus <= 8 ? ["miser", "balanced", "aggressive"]
    : ["miser", "balanced", "aggressive", "drain-my-battery"];
}

describe("Power Efficiency presets", () => {
  it("run 2, 4, 8 and every CPU, capped by the CPU count", () => {
    expect(POWER_EFFICIENCY_PRESETS.map((p) => powerEfficiencyWorkers(p, 18))).toEqual([2, 4, 8, 18]);
    expect(POWER_EFFICIENCY_PRESETS.map((p) => powerEfficiencyWorkers(p, 6))).toEqual([2, 4, 6, 6]);
    expect(POWER_EFFICIENCY_PRESETS.map((p) => powerEfficiencyWorkers(p, 3))).toEqual([2, 3, 3, 3]);
    expect(POWER_EFFICIENCY_PRESETS.map((p) => powerEfficiencyWorkers(p, 1))).toEqual([1, 1, 1, 1]);
    // No count detected still runs one worker.
    expect(powerEfficiencyWorkers("drain-my-battery", 0)).toBe(1);
    expect(powerEfficiencyLabel("drain-my-battery", 18)).toBe("Drain My Battery (18 workers)");
    expect(powerEfficiencyLabel("miser", 1)).toBe("Miser (1 worker)");
  });

  it.each(Object.entries(OFFERED).map(([cpus, offered]) => [Number(cpus), offered] as const))(
    "at %i CPUs offer %j",
    (cpus, offered) => {
      expect(offeredPowerEfficiencies(cpus)).toEqual(offered);
      // Each offered preset runs more workers than the one before it,
      // and each one left out runs no more than the one below it.
      const counts = offered.map((p) => powerEfficiencyWorkers(p, cpus));
      expect(counts).toEqual([...new Set(counts)].sort((a, b) => a - b));
      for (const [index, preset] of POWER_EFFICIENCY_PRESETS.entries()) {
        if (offered.includes(preset)) continue;
        expect(powerEfficiencyWorkers(preset, cpus))
          .toBe(powerEfficiencyWorkers(POWER_EFFICIENCY_PRESETS[index - 1], cpus));
      }
    },
  );

  it("light the gauge by offered presets at or below the worker count", () => {
    expect(powerEfficiencySignal(2, 18)).toBe(1);
    expect(powerEfficiencySignal(4, 18)).toBe(2);
    expect(powerEfficiencySignal(8, 18)).toBe(3);
    expect(powerEfficiencySignal(18, 18)).toBe(4);
    // A custom count reads on the same scale.
    expect(powerEfficiencySignal(12, 18)).toBe(3);
    expect(powerEfficiencySignal(1, 18)).toBe(1);
    // A small machine running all it has is as full as its menu allows.
    expect(powerEfficiencySignal(4, 4)).toBe(2);
    expect(powerEfficiencySignal(8, 8)).toBe(3);
    expect(powerEfficiencySignal(2, 2)).toBe(1);
  });

  it("run a preset this machine doesn't offer as the one below it", () => {
    expect(effectivePowerEfficiency("drain-my-battery", 8)).toBe("aggressive");
    expect(effectivePowerEfficiency("drain-my-battery", 4)).toBe("balanced");
    expect(effectivePowerEfficiency("aggressive", 2)).toBe("miser");
    expect(effectivePowerEfficiency("aggressive", 18)).toBe("aggressive");
    expect(effectivePowerEfficiency("miser", 1)).toBe("miser");
  });
});

describe("the saved Power Efficiency setting", () => {
  it("defaults, survives normalizing, and drops unknown values", () => {
    expect(defaultSettings().scanning.powerEfficiency).toBe(DEFAULT_POWER_EFFICIENCY);
    // Settings saved before the setting existed.
    const old = defaultSettings() as unknown as { scanning: Record<string, unknown> };
    delete old.scanning.powerEfficiency;
    expect(normalizeAppSettings(old as never).scanning.powerEfficiency).toBe(DEFAULT_POWER_EFFICIENCY);
    for (const preset of POWER_EFFICIENCY_PRESETS) {
      const saved = { ...defaultSettings(), scanning: { ...defaultSettings().scanning, powerEfficiency: preset } };
      expect(normalizeAppSettings(JSON.parse(JSON.stringify(saved))).scanning.powerEfficiency).toBe(preset);
    }
    const bad = { ...defaultSettings(), scanning: { ...defaultSettings().scanning, powerEfficiency: "turbo" } };
    expect(normalizeAppSettings(bad as never).scanning.powerEfficiency).toBe(DEFAULT_POWER_EFFICIENCY);
  });
});
