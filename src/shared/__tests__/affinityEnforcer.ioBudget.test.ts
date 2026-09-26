import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AffinityApplyResult } from "../../affinityRuleEngine";
import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { createAffinityEnforcer, type AffinityEnforcer } from "../affinityEnforcer";
import { defaultSettings, type AffinityRule, type ProcessInfo } from "../contracts";
import { createSettingsStore } from "../settingsStore";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));

const paths = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: () => paths.userData } }));

const HOUR = 3_600_000;
/** SystemWidget's memory poll; MemoryView's 2 s setting is throttled to it. */
const POLL_MS = 4_000;

const GAME = { pid: 4242, name: "game.exe" };
const DEFENDER = { pid: 3108, name: "MsMpEng.exe" };

function rule(id: string, pattern: string, mask: number): AffinityRule {
  return {
    id,
    name: pattern,
    enabled: true,
    matchType: "exe_name",
    matchPattern: pattern,
    affinityMask: mask,
    createdAt: Date.parse("2026-08-01T09:00:00Z"),
    lastAppliedAt: Date.parse("2026-09-24T18:30:00Z"),
    appliedCount: 37,
  };
}

/** A settings.json a Windows user with a few rules and scans has: ~3.3 KB. */
function seedSettings(): void {
  const settings = defaultSettings();
  settings.recentScans = ["C:\\", "D:\\", "E:\\Games", "C:\\Users\\alex\\Downloads"].map((path, i) => ({
    path,
    scannedAt: Date.parse("2026-09-24T12:00:00Z") - i * HOUR,
    filesFound: 1_234_567 - i * 100_000,
    bytesFound: 987_654_321_000 - i * 10_000_000_000,
  }));
  settings.affinityRules = [
    rule("6f1d2c3a-0b8e-4c55-9a1e-2f7d8e9c0a11", GAME.name, 0x00ff),
    rule("8a2e3d4b-1c9f-4d66-8b2f-3e8f9fad1b22", DEFENDER.name.toLowerCase(), 0x0003),
    rule("9b3f4e5c-2da0-4e77-9c3a-4f9a0bbe2c33", "obs64.exe", 0xff00),
    rule("ac405f6d-3eb1-4f88-8d4b-5a0b1ccf3d44", "chrome.exe", 0x0ff0),
    rule("bd516a7e-4fc2-4099-9e5c-6b1c2dd04e55", "code.exe", 0xf000),
  ];
  FS.writeFileSync(Path.join(paths.userData, "settings.json"), JSON.stringify(settings, null, 2));
}

function proc({ pid, name }: { pid: number; name: string }): ProcessInfo {
  return {
    pid,
    name,
    memoryBytes: 512 * 1024 * 1024,
    cpuPercent: 3.5,
    cpuPercentPerCore: 28,
    userOwned: true,
    exePath: `C:\\Program Files\\${name}`,
  };
}

/** Stands in for the PowerShell engine: `outcome` for each matched pid it is handed. */
function engine(outcome: Pick<AffinityApplyResult, "ok" | "error">) {
  return async (rules: AffinityRule[], processes: ProcessInfo[]): Promise<AffinityApplyResult[]> =>
    processes.flatMap((p) => {
      const matched = rules.find((r) => r.enabled && r.matchPattern === p.name.toLowerCase());
      if (!matched) return [];
      return [{ ruleId: matched.id, pid: p.pid, processName: p.name, previousMask: 0xffff, newMask: matched.affinityMask, ...outcome }];
    });
}

async function launch(outcome: Pick<AffinityApplyResult, "ok" | "error">): Promise<AffinityEnforcer> {
  seedSettings();
  const settings = await createSettingsStore();
  const crashLog = Path.join(paths.userData, "crash.log");
  return createAffinityEnforcer({
    settings,
    enforce: engine(outcome),
    // writeCrashLog's I/O per line: a mkdir, a sync append, and a stat
    // to check for rotation.
    log: (tag, message) => {
      FS.mkdirSync(paths.userData, { recursive: true });
      FS.appendFileSync(crashLog, `[${new Date().toISOString()}] [${tag}] ${message}\n`);
      void FSP.stat(crashLog);
    },
    isSupported: () => true,
  });
}

/** The memory poll for an hour, with `target` in each sample among other processes. */
async function pollForAnHour(enforcer: AffinityEnforcer, target: { pid: number; name: string }): Promise<void> {
  const processes = [proc(target), proc({ pid: 1200, name: "explorer.exe" }), proc({ pid: 7788, name: "svchost.exe" })];
  const poll = setInterval(() => void enforcer.maybeEnforce(processes), POLL_MS);
  try {
    await vi.advanceTimersByTimeAsync(HOUR);
  } finally {
    clearInterval(poll);
  }
}

const savedRules = (): AffinityRule[] =>
  JSON.parse(FS.readFileSync(Path.join(paths.userData, "settings.json"), "utf8")).affinityRules;

beforeEach(async () => {
  paths.userData = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-affinity-io-"));
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  await FSP.rm(paths.userData, { recursive: true, force: true });
});

describe("affinity enforcer", () => {
  it("writes no settings and one log line in an hour for a process it is denied", async () => {
    const enforcer = await launch({ ok: false, error: "Exception setting \"ProcessorAffinity\": \"Access is denied\"" });

    const { io } = await measureFsIo(() => pollForAnHour(enforcer, DEFENDER));

    expectIoBudget({
      scenario: "affinity-enforcer-failing-rule-hour",
      note: "an hour of 4 s polls with a rule that can never apply (access denied): 9 attempts on a backoff to 30 min, 1 crash.log line (a mkdir, an append and a stat), 0 settings writes; about 24 lines/day and no settings writes at any refresh setting; was 900 attempts, 900 crash.log lines and 900 no-op settings saves broadcast to every window, 21,600/day",
      io,
    });
    expect(savedRules()[1]!.appliedCount).toBe(37);
  });

  it("saves the counters every 15 min for a process that resets its own affinity", async () => {
    const enforcer = await launch({ ok: true });

    const { io } = await measureFsIo(() => pollForAnHour(enforcer, GAME));

    expectIoBudget({
      scenario: "affinity-enforcer-fighting-process-hour",
      note: "an hour of 4 s polls, the process undoing the rule before each: 900 applies counted in memory, 3 settings.json rewrites (~3.3 KB) at 15, 30 and 45 min, 1 crash.log line; at most 96 rewrites/day (~0.3 MB/day) and 24 lines/day at any refresh setting; was 900 rewrites and 900 lines an hour, 21,600/day and ~70 MB/day",
      io,
    });
    expect(savedRules()[0]!.appliedCount).toBe(37 + 678);
    expect(enforcer.rules()[0]!.appliedCount).toBe(37 + 900);
  });

  it("writes the unsaved counters once at quit", async () => {
    const enforcer = await launch({ ok: true });
    await pollForAnHour(enforcer, GAME);

    const { io } = await measureFsIo(() => enforcer.flush());

    expectIoBudget({
      scenario: "affinity-enforcer-quit",
      note: "before-quit flush with counts since the last 15-minute save: 1 settings.json rewrite (~3.3 KB) per session",
      io,
    });
    expect(savedRules()[0]!.appliedCount).toBe(37 + 900);
  });

  it("writes nothing at quit when no rule applied since the last save", async () => {
    const enforcer = await launch({ ok: false, error: "Access is denied" });
    await pollForAnHour(enforcer, DEFENDER);

    const { io } = await measureFsIo(() => enforcer.flush());

    expectIoBudget({
      scenario: "affinity-enforcer-quit-clean",
      note: "before-quit flush with no counts pending: 0 writes",
      io,
    });
  });
});
