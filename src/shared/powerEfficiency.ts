// Power Efficiency: how many workers the native scanner walks with.
//
// Four fixed presets, each capped by the machine's logical CPU count.
// The choice is saved in settings.json and read when a scan starts, so it
// changes the next scan and never a running one.

export type PowerEfficiency = "miser" | "balanced" | "aggressive" | "drain-my-battery";

/** Least to most workers. The gauge and the menu both read this order. */
export const POWER_EFFICIENCY_PRESETS: readonly PowerEfficiency[] = [
  "miser",
  "balanced",
  "aggressive",
  "drain-my-battery",
];

/**
 * Settings without a saved choice get this. On an 18-CPU M5 Max, a whole
 * `/` scan (20.8M files, two warm rounds) took 258 s and 674 CPU-s at 4
 * workers, 248 s and 849 CPU-s at 8 (the scanner's old cap), 264 s and
 * 1,085 CPU-s at 18, and 344 s and 572 CPU-s at 2. Past 4 the walk
 * barely gets faster; the CPU keeps climbing.
 */
export const DEFAULT_POWER_EFFICIENCY: PowerEfficiency = "balanced";

const NAMES: Record<PowerEfficiency, string> = {
  miser: "Miser",
  balanced: "Balanced",
  aggressive: "Aggressive",
  "drain-my-battery": "Drain My Battery",
};

export function isPowerEfficiency(value: unknown): value is PowerEfficiency {
  return typeof value === "string" && (POWER_EFFICIENCY_PRESETS as readonly string[]).includes(value);
}

export function powerEfficiencyName(preset: PowerEfficiency): string {
  return NAMES[preset];
}

/** Workers the preset runs on a machine with `cpus` logical CPUs. */
export function powerEfficiencyWorkers(preset: PowerEfficiency, cpus: number): number {
  const limit = Math.max(1, Math.floor(cpus) || 1);
  switch (preset) {
    case "miser": return Math.min(2, limit);
    case "balanced": return Math.min(4, limit);
    case "aggressive": return Math.min(8, limit);
    case "drain-my-battery": return limit;
  }
}

/**
 * A preset that would run no more workers than the one below it on this
 * machine is a duplicate here: shown, so the scale reads the same on every
 * machine, but not offered.
 */
export function powerEfficiencyAvailable(preset: PowerEfficiency, cpus: number): boolean {
  const index = POWER_EFFICIENCY_PRESETS.indexOf(preset);
  if (index <= 0) return true;
  return powerEfficiencyWorkers(preset, cpus)
    > powerEfficiencyWorkers(POWER_EFFICIENCY_PRESETS[index - 1], cpus);
}

export function offeredPowerEfficiencies(cpus: number): PowerEfficiency[] {
  return POWER_EFFICIENCY_PRESETS.filter((preset) => powerEfficiencyAvailable(preset, cpus));
}

/**
 * The saved choice, or the nearest offered preset below it. A choice made
 * on a bigger machine (settings copied over, or a VM given fewer CPUs)
 * runs as what it is here.
 */
export function effectivePowerEfficiency(preset: PowerEfficiency, cpus: number): PowerEfficiency {
  for (let index = POWER_EFFICIENCY_PRESETS.indexOf(preset); index > 0; index--) {
    const candidate = POWER_EFFICIENCY_PRESETS[index];
    if (powerEfficiencyAvailable(candidate, cpus)) return candidate;
  }
  return POWER_EFFICIENCY_PRESETS[0];
}

/**
 * How many of the four gauge bars `workers` lights: the offered presets
 * that run no more than that, so a custom count reads on the same scale.
 */
export function powerEfficiencySignal(workers: number, cpus: number): number {
  const lit = offeredPowerEfficiencies(cpus)
    .filter((preset) => powerEfficiencyWorkers(preset, cpus) <= workers)
    .length;
  return Math.max(1, lit);
}

export function formatWorkers(count: number): string {
  return `${count} ${count === 1 ? "worker" : "workers"}`;
}

export function powerEfficiencyLabel(preset: PowerEfficiency, cpus: number): string {
  return `${powerEfficiencyName(preset)} (${formatWorkers(powerEfficiencyWorkers(preset, cpus))})`;
}
