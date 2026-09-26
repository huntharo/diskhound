import { describe, expect, it } from "vitest";

import { defaultSettings, normalizeAppSettings } from "../../shared/contracts";
import { resolveDiagnosticsConfig } from "../diagnosticsConfig";

const MB = 1024 * 1024;
const defaults = () => defaultSettings().diagnostics;

describe("diagnostics settings", () => {
  it("default to everything off, with the gate at 1.2 GB", () => {
    expect(defaults()).toEqual({
      hotCpuProfiling: false,
      hotCpuThresholdPercent: 50,
      heapDiagnostics: false,
      heapSnapshots: false,
      heapGateMb: 1200,
    });
    const config = resolveDiagnosticsConfig(defaults(), {});
    expect(config.hotCpu.enabled).toBe(false);
    expect(config.heap).toMatchObject({
      enabled: false, snapshots: false, gateBytes: 1200 * MB, watchBytes: 0, snapshotMaxBytes: 512 * MB,
    });
    expect(config.envOverrides).toEqual([]);
  });

  it("clamp out-of-range values and fill in a settings.json from before diagnostics", () => {
    const normalized = normalizeAppSettings({
      diagnostics: { hotCpuThresholdPercent: 400, heapGateMb: 20, heapDiagnostics: "yes" as unknown as boolean },
    } as never);
    expect(normalized.diagnostics).toEqual({
      hotCpuProfiling: false,
      hotCpuThresholdPercent: 100,
      heapDiagnostics: true,
      heapSnapshots: false,
      heapGateMb: 128,
    });
    expect(normalizeAppSettings({}).diagnostics).toEqual(defaults());
  });

  it("keeps the PwrAgnt trigger defaults: 2 s samples, 2 in a row, 15 s after, 60 s apart, 5 a launch", () => {
    const { hotCpu } = resolveDiagnosticsConfig({ ...defaults(), hotCpuProfiling: true }, {});
    expect(hotCpu).toMatchObject({
      enabled: true, intervalMs: 2_000, thresholdPercent: 50, consecutiveSamples: 2,
      profileDurationMs: 15_000, cooldownMs: 60_000, maxProfiles: 5, recordingWindowMs: 30_000,
    });
  });

  it("let env vars override Settings for one launch and report which did", () => {
    const config = resolveDiagnosticsConfig(defaults(), {
      DISKHOUND_HOT_CPU_PROFILING: "1",
      DISKHOUND_HOT_CPU_PROFILING_THRESHOLD_PERCENT: "5",
      DISKHOUND_HOT_CPU_PROFILING_WINDOW_MS: "5000",
      DISKHOUND_HEAP_GATE_MB: "200",
      DISKHOUND_HEAP_SNAPSHOTS: "true",
      DISKHOUND_HEAP_SNAPSHOT_GAP_MS: "2000",
      DISKHOUND_HEAP_SNAPSHOT_MAX_MB: "700",
      DISKHOUND_HEAP_MAX_GATES_PER_DAY: "garbage",
    });
    expect(config.hotCpu).toMatchObject({ enabled: true, thresholdPercent: 5, recordingWindowMs: 5_000 });
    expect(config.heap).toMatchObject({
      enabled: true, snapshots: true, gateBytes: 200 * MB, watchBytes: 0, snapshotGapMs: 2_000,
      snapshotMaxBytes: 700 * MB, maxGatesPerDay: 1,
    });
    expect(config.envOverrides).toEqual([
      "DISKHOUND_HOT_CPU_PROFILING=1",
      "DISKHOUND_HOT_CPU_PROFILING_THRESHOLD_PERCENT=5",
      "DISKHOUND_HOT_CPU_PROFILING_WINDOW_MS=5000",
      "DISKHOUND_HEAP_GATE_MB=200",
      "DISKHOUND_HEAP_SNAPSHOTS=true",
      "DISKHOUND_HEAP_SNAPSHOT_GAP_MS=2000",
      "DISKHOUND_HEAP_SNAPSHOT_MAX_MB=700",
    ]);
  });

  it("let an env var force a Settings toggle off, and keep snapshots behind the gate", () => {
    const on = { ...defaults(), hotCpuProfiling: true, heapDiagnostics: true, heapSnapshots: true };
    const config = resolveDiagnosticsConfig(on, { DISKHOUND_HOT_CPU_PROFILING: "0", DISKHOUND_HEAP_DIAGNOSTICS: "off" });
    expect(config.hotCpu.enabled).toBe(false);
    expect(config.heap).toMatchObject({ enabled: false, snapshots: false });
    expect(resolveDiagnosticsConfig({ ...defaults(), heapSnapshots: true }, {}).heap.snapshots).toBe(false);
  });

  it("never watches above the gate", () => {
    const { heap } = resolveDiagnosticsConfig(defaults(), { DISKHOUND_HEAP_GATE_MB: "300", DISKHOUND_HEAP_WATCH_MB: "900" });
    expect(heap.watchBytes).toBe(300 * MB);
  });
});
