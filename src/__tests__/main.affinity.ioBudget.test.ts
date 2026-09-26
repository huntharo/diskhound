import * as FS from "node:fs";
import "node:fs/promises";
import * as Path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { defaultSettings, type AffinityRule, type ProcessInfo } from "../shared/contracts";
import { expectIoBudget, measureFsIo } from "../test/ioBudget";
import { bootMainProcess, type MainProcess } from "../test/mainProcessHarness";
import * as elevation from "../elevation";
import { sampleSystemMemory } from "../shared/processMonitor";
import { enforceAffinityRules } from "../affinityRuleEngine";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFsPromises(await importOriginal()));
vi.mock("node:child_process", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentChildProcess(await importOriginal()));
vi.mock("node:worker_threads", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentWorkerThreads(await importOriginal()));
vi.mock("electron", async () =>
  (await import("../test/mainProcessHarness")).fakeElectron());
vi.mock("../shared/crashLog", async (importOriginal) =>
  (await import("../test/mainProcessHarness")).settledCrashLog(await importOriginal()));

// These OS boundaries must never launch PowerShell or change host affinity.
vi.mock("../elevation", () => ({
  isElevated: vi.fn(async () => false),
  hasScheduledTask: vi.fn(async () => true),
  runScheduledTaskNow: vi.fn(async () => { throw new Error("real handoff attempted"); }),
}));
vi.mock("../shared/diskMonitor", async (importOriginal) => ({
  ...await importOriginal<typeof import("../shared/diskMonitor")>(),
  checkDiskDeltas: vi.fn(async () => ({ drives: [], deltas: [], lastCheckedAt: null, lastFullScanAt: null })),
}));
vi.mock("../shared/processMonitor", () => ({ sampleSystemMemory: vi.fn(), killProcess: vi.fn() }));
vi.mock("../affinityRuleEngine", () => ({ enforceAffinityRules: vi.fn(async () => []) }));

const platform = process.platform;
const argv = process.argv;
const originalTimeout = globalThis.setTimeout;
const originalInterval = globalThis.setInterval;
const rule: AffinityRule = {
  id: "test-game", name: "Game", enabled: true, matchType: "exe_name",
  matchPattern: "game.exe", affinityMask: 3, createdAt: 1, appliedCount: 0, lastAppliedAt: null,
};
let main: MainProcess;
let processes: ProcessInfo[] = [];
let now = Date.now();
let tick: () => void;

beforeAll(async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.mocked(sampleSystemMemory).mockImplementation(async () => ({
    totalBytes: 16e9, freeBytes: 8e9, usedBytes: 8e9, usedPercent: 50,
    cpuCount: 8, loadAvg: null, processes, sampledAt: now,
  }));
  main = await bootMainProcess({ seed: (userData) => {
    const settings = defaultSettings();
    settings.monitoring.enabled = false;
    FS.writeFileSync(Path.join(userData, "settings.json"), JSON.stringify(settings));
  } });
  // Drive main's real 4 s callback without wall-clock waits. Its actual
  // interval is cleared here so it cannot race the controlled ticks.
  const timer = vi.mocked(globalThis.setInterval);
  const index = timer.mock.calls.findIndex(([, delay]) => delay === 4_000);
  expect(index).toBeGreaterThanOrEqual(0);
  tick = timer.mock.calls[index]![0] as () => void;
  clearInterval(timer.mock.results[index]!.value);
  main.send("diskhound:minimize-to-tray");
});

afterAll(() => {
  Object.defineProperty(process, "platform", { value: platform });
  vi.restoreAllMocks();
});

async function advance() {
  now += 4_000;
  tick();
  // Includes the async dynamic import of the real enforcer's OS boundary.
  await new Promise((resolve) => setImmediate(resolve));
}

it("suppresses Windows startup handoff even with a registered task", () => {
  expect(process.argv).toContain("--launched-by-task");
  expect(elevation.isElevated).not.toHaveBeenCalled();
  expect(elevation.hasScheduledTask).not.toHaveBeenCalled();
  expect(elevation.runScheduledTaskNow).not.toHaveBeenCalled();
});

it("does no background sampling without enabled rules", async () => {
  await advance();
  expect(sampleSystemMemory).not.toHaveBeenCalled();
  await main.invoke("diskhound:upsert-affinity-rule", { ...rule, enabled: false });
  await advance();
  expect(sampleSystemMemory).not.toHaveBeenCalled();
});

it("keeps enforcing while hidden, sharing fresh UI samples without writes", async () => {
  await main.invoke("diskhound:upsert-affinity-rule", rule);
  expect(await main.invoke("diskhound:is-window-shown")).toBe(false);
  processes = [{ pid: 42, name: "game.exe", memoryBytes: 100, cpuPercent: 0, cpuPercentPerCore: 0, userOwned: true }];
  const { io } = await measureFsIo(async () => {
    for (let i = 0; i < 15; i++) {
      // A process launched while hidden must appear in the next pass too.
      if (i === 14) processes = [...processes, { ...processes[0]!, pid: 43 }];
      await advance();
    }
  }, { countProcesses: true });
  expect(sampleSystemMemory).toHaveBeenCalledTimes(15);
  expect(enforceAffinityRules).toHaveBeenCalledTimes(15);
  expect(enforceAffinityRules).toHaveBeenLastCalledWith([rule], processes);
  expectIoBudget({
    scenario: "main-affinity-hidden-stable-minute",
    note: "15 main-process ticks over a hidden minute with one enabled rule: no fs I/O. The sampler and affinity OS engine are stubbed; existing affinity-enforcer budgets cover apply counters, failures and quit. Stable rules cost 0 writes/day and 0 MB/day at default and 1-minute monitoring.",
    io,
  });
  // A visible renderer's sample also feeds enforcement; the background
  // tick must not start a second sample while that result is fresh.
  now += 4_000;
  await main.invoke("diskhound:get-memory-snapshot");
  tick();
  expect(sampleSystemMemory).toHaveBeenCalledTimes(16);
  await main.invoke("diskhound:delete-affinity-rule", rule.id);
  await advance();
  expect(sampleSystemMemory).toHaveBeenCalledTimes(16);
});

it("stops the harness and deletes its entire profile, restoring argv and timers", async () => {
  const root = Path.dirname(main.userData);
  expect(FS.existsSync(root)).toBe(true);
  await main.dispose();
  expect(FS.existsSync(root)).toBe(false);
  expect(process.argv).toBe(argv);
  expect(globalThis.setTimeout).toBe(originalTimeout);
  expect(globalThis.setInterval).toBe(originalInterval);
  await advance();
  expect(sampleSystemMemory).toHaveBeenCalledTimes(16);
});
