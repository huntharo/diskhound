import type { DiagnosticsSettings } from "../shared/contracts";

const MB = 1024 * 1024;

/**
 * Hot-CPU profiler defaults, from PwrAgnt's hot-cpu-profile-config.ts.
 * Two 2 s samples at or above 50% of one core start a capture, which
 * keeps recording for 15 s more. Captures are at least 60 s apart and
 * at most 5 per launch.
 */
export const HOT_CPU_DEFAULTS = {
  // Boot is hot on purpose (snapshot rehydrate, folder-tree pre-warm).
  startDelayMs: 30_000,
  intervalMs: 2_000,
  consecutiveSamples: 2,
  profileDurationMs: 15_000,
  cooldownMs: 60_000,
  maxProfiles: 5,
  // The profiler keeps the last finished window and the live one, so a
  // capture reaches back one to two windows (30–60 s) before its trigger.
  recordingWindowMs: 30_000,
} as const;

export const HEAP_DEFAULTS = {
  intervalMs: 5_000,
  // The sampling heap profiler starts at this fraction of the gate, so
  // the saved profile shows what grew the heap. 0 samples from the first
  // check: a scan took the main heap from 30 to 83 MB inside one 5 s
  // check, so a higher watch mark starts sampling only after the growth.
  // At 32 KB it cost nothing measurable on an allocation-heavy 470 MB
  // workload (within run-to-run noise) and held a ~580 KB profile.
  watchFraction: 0,
  snapshotGapMs: 20_000,
  // A snapshot needs about the main heap's size again, inside the one
  // cage main and its workers share. Take one only while
  // (cage used + main used) stays under this fraction of the limit.
  headroomFraction: 0.9,
  // Measured on Electron 40.6 with a folder-tree-shaped heap (a Map of
  // path strings to small records): v8.writeHeapSnapshot finished at
  // 556 MB and killed the process with SIGTRAP inside TakeHeapSnapshot
  // at 602 MB, leaving an empty file and no crash.log line. Snapshots
  // above this are skipped. The main thread blocked 35–50 ms per MB and
  // the file was ~2.3x the heap; DiskHound's own heap after a scan took
  // 17 ms per MB and 1.55x.
  snapshotMaxBytes: 512 * MB,
  maxGatesPerDay: 1,
  cooldownMs: 10 * 60_000,
  // Crash-log breadcrumb when main nears the limit: V8's OOM abort
  // bypasses every JS handler, so nothing else would record it.
  nearLimitFraction: 0.85,
} as const;

export interface HotCpuConfig {
  enabled: boolean;
  startDelayMs: number;
  intervalMs: number;
  thresholdPercent: number;
  consecutiveSamples: number;
  profileDurationMs: number;
  cooldownMs: number;
  maxProfiles: number;
  recordingWindowMs: number;
}

export interface HeapGateConfig {
  /** Gate, sampling heap profiler and .heapprofile capture. */
  enabled: boolean;
  /** Full .heapsnapshot pair at the gate. Needs `enabled`. */
  snapshots: boolean;
  intervalMs: number;
  gateBytes: number;
  watchBytes: number;
  snapshotGapMs: number;
  headroomFraction: number;
  /** No snapshot above this much main heap, whatever the headroom. */
  snapshotMaxBytes: number;
  maxGatesPerDay: number;
  cooldownMs: number;
  nearLimitFraction: number;
}

export interface DiagnosticsConfig {
  hotCpu: HotCpuConfig;
  heap: HeapGateConfig;
  /** `NAME=value` for every env var that changed the config. */
  envOverrides: string[];
}

type Env = Record<string, string | undefined>;

/**
 * Settings, then env. The env vars are for testing and for asking a
 * user to reproduce something for one launch:
 *
 * - `DISKHOUND_HOT_CPU_PROFILING=1|0` forces the CPU profiler on or off.
 *   `_THRESHOLD_PERCENT`, `_INTERVAL_MS`, `_CONSECUTIVE_SAMPLES`,
 *   `_DURATION_MS`, `_COOLDOWN_MS`, `_MAX_PROFILES`, `_START_DELAY_MS`
 *   and `_WINDOW_MS` tune it.
 * - `DISKHOUND_HEAP_DIAGNOSTICS=1|0` forces the heap gate on or off.
 *   `DISKHOUND_HEAP_GATE_MB` sets the gate and `DISKHOUND_HEAP_SNAPSHOTS=1`
 *   adds snapshots; either one turns the gate on unless
 *   `DISKHOUND_HEAP_DIAGNOSTICS=0`. `DISKHOUND_HEAP_WATCH_MB`,
 *   `_SNAPSHOT_GAP_MS`, `_SNAPSHOT_MAX_MB`, `_INTERVAL_MS`,
 *   `_MAX_GATES_PER_DAY` and `_COOLDOWN_MS` tune it.
 */
export function resolveDiagnosticsConfig(
  settings: DiagnosticsSettings,
  env: Env = process.env,
): DiagnosticsConfig {
  const overrides: string[] = [];
  const read = <T>(name: string, parse: (raw: string) => T | undefined): T | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const value = parse(raw);
    if (value !== undefined) overrides.push(`${name}=${raw}`);
    return value;
  };
  const flag = (name: string) => read(name, parseFlag);
  const positive = (name: string) => read(name, (raw) => parseNumber(raw, (n) => n > 0));
  const nonNegative = (name: string) => read(name, (raw) => parseNumber(raw, (n) => n >= 0));

  const cpu = "DISKHOUND_HOT_CPU_PROFILING";
  const hotCpu: HotCpuConfig = {
    enabled: flag(cpu) ?? settings.hotCpuProfiling,
    thresholdPercent: positive(`${cpu}_THRESHOLD_PERCENT`) ?? settings.hotCpuThresholdPercent,
    startDelayMs: nonNegative(`${cpu}_START_DELAY_MS`) ?? HOT_CPU_DEFAULTS.startDelayMs,
    intervalMs: positive(`${cpu}_INTERVAL_MS`) ?? HOT_CPU_DEFAULTS.intervalMs,
    consecutiveSamples: Math.round(positive(`${cpu}_CONSECUTIVE_SAMPLES`) ?? HOT_CPU_DEFAULTS.consecutiveSamples),
    profileDurationMs: positive(`${cpu}_DURATION_MS`) ?? HOT_CPU_DEFAULTS.profileDurationMs,
    cooldownMs: nonNegative(`${cpu}_COOLDOWN_MS`) ?? HOT_CPU_DEFAULTS.cooldownMs,
    maxProfiles: Math.round(positive(`${cpu}_MAX_PROFILES`) ?? HOT_CPU_DEFAULTS.maxProfiles),
    recordingWindowMs: positive(`${cpu}_WINDOW_MS`) ?? HOT_CPU_DEFAULTS.recordingWindowMs,
  };

  const heapFlag = flag("DISKHOUND_HEAP_DIAGNOSTICS");
  const gateMb = positive("DISKHOUND_HEAP_GATE_MB");
  const snapshotsFlag = flag("DISKHOUND_HEAP_SNAPSHOTS");
  const gateBytes = (gateMb ?? settings.heapGateMb) * MB;
  const watchMb = positive("DISKHOUND_HEAP_WATCH_MB");
  const enabled = heapFlag ?? (gateMb !== undefined || snapshotsFlag === true || settings.heapDiagnostics);
  const heap: HeapGateConfig = {
    enabled,
    snapshots: enabled && (snapshotsFlag ?? settings.heapSnapshots),
    intervalMs: positive("DISKHOUND_HEAP_INTERVAL_MS") ?? HEAP_DEFAULTS.intervalMs,
    gateBytes,
    watchBytes: Math.min(gateBytes, watchMb !== undefined ? watchMb * MB : gateBytes * HEAP_DEFAULTS.watchFraction),
    snapshotGapMs: nonNegative("DISKHOUND_HEAP_SNAPSHOT_GAP_MS") ?? HEAP_DEFAULTS.snapshotGapMs,
    headroomFraction: HEAP_DEFAULTS.headroomFraction,
    snapshotMaxBytes: (positive("DISKHOUND_HEAP_SNAPSHOT_MAX_MB") ?? HEAP_DEFAULTS.snapshotMaxBytes / MB) * MB,
    maxGatesPerDay: Math.round(positive("DISKHOUND_HEAP_MAX_GATES_PER_DAY") ?? HEAP_DEFAULTS.maxGatesPerDay),
    cooldownMs: nonNegative("DISKHOUND_HEAP_COOLDOWN_MS") ?? HEAP_DEFAULTS.cooldownMs,
    nearLimitFraction: HEAP_DEFAULTS.nearLimitFraction,
  };

  return { hotCpu, heap, envOverrides: overrides };
}

function parseFlag(raw: string): boolean | undefined {
  const value = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

function parseNumber(raw: string, valid: (n: number) => boolean): number | undefined {
  const value = Number(raw);
  return Number.isFinite(value) && valid(value) ? value : undefined;
}
