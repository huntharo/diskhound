import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AffinityApplyResult } from "../../affinityRuleEngine";
import {
  AFFINITY_COUNTER_FLUSH_MS,
  createAffinityEnforcer,
  upsertAffinityRule,
} from "../affinityEnforcer";
import { defaultSettings, type AffinityRule, type AppSettings, type ProcessInfo } from "../contracts";

const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

function rule(overrides: Partial<AffinityRule> = {}): AffinityRule {
  return {
    id: "rule-game",
    name: "game.exe",
    enabled: true,
    matchType: "exe_name",
    matchPattern: "game.exe",
    affinityMask: 0b1111,
    createdAt: 1_000,
    lastAppliedAt: null,
    appliedCount: 0,
    ...overrides,
  };
}

function proc(pid: number, name = "game.exe"): ProcessInfo {
  return {
    pid,
    name,
    memoryBytes: 1,
    cpuPercent: null,
    cpuPercentPerCore: null,
    userOwned: true,
    exePath: `C:\\Games\\${name}`,
  };
}

/** What the fake engine does to each pid it is handed. */
type Outcome = { ok: true } | { ok: false; error: string };

function setup(rules: AffinityRule[], options: { isSupported?: boolean } = {}) {
  let settings: AppSettings = { ...defaultSettings(), affinityRules: rules };
  const store = {
    get: () => settings,
    set: vi.fn(async (next: AppSettings) => {
      settings = next;
    }),
  };
  const outcomes = new Map<number, Outcome>();
  /** Fake time of each pass and the pids it was handed. */
  const passes: Array<{ at: number; pids: number[] }> = [];
  const enforce = vi.fn(async (passRules: AffinityRule[], processes: ProcessInfo[]) => {
    passes.push({ at: Date.now(), pids: processes.map((p) => p.pid) });
    const results: AffinityApplyResult[] = [];
    for (const p of processes) {
      const outcome = outcomes.get(p.pid);
      const matched = passRules.find((r) => r.enabled && r.matchPattern === p.name);
      if (!outcome || !matched) continue;
      results.push({
        ruleId: matched.id,
        pid: p.pid,
        processName: p.name,
        previousMask: 0xffff,
        newMask: matched.affinityMask,
        ...outcome,
      });
    }
    return results;
  });
  const log = vi.fn<(tag: string, message: string) => void>();
  const enforcer = createAffinityEnforcer({
    settings: store,
    enforce,
    log,
    isSupported: () => options.isSupported ?? true,
  });
  return {
    enforcer,
    store,
    outcomes,
    passes,
    enforce,
    log,
    /** The rules as settings.json would hold them. */
    saved: () => settings.affinityRules,
    editRules: (next: AffinityRule[]) => {
      settings = { ...settings, affinityRules: next };
    },
  };
}

/** Samples every `every` ms for `duration` ms, like the widget's memory poll. */
async function poll(
  enforcer: ReturnType<typeof createAffinityEnforcer>,
  processes: () => ProcessInfo[],
  duration: number,
  every = 4 * SECOND,
): Promise<void> {
  for (let elapsed = 0; elapsed < duration; elapsed += every) {
    await vi.advanceTimersByTimeAsync(every);
    await enforcer.maybeEnforce(processes());
  }
}

const passTimes = (passes: Array<{ at: number; pids: number[] }>, pid: number, start: number) =>
  passes.filter((pass) => pass.pids.includes(pid)).map((pass) => (pass.at - start) / SECOND);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("affinity enforcer", () => {
  it("does nothing off Windows", async () => {
    const t = setup([rule()], { isSupported: false });
    t.outcomes.set(10, { ok: true });

    await poll(t.enforcer, () => [proc(10)], MINUTE);

    expect(t.enforce).not.toHaveBeenCalled();
  });

  it("runs at most one pass per 4 s however often the sampler runs", async () => {
    const t = setup([rule()]);

    await poll(t.enforcer, () => [proc(10)], MINUTE, SECOND);

    expect(t.enforce).toHaveBeenCalledTimes(15);
  });

  it("skips a sample while the previous pass is still running", async () => {
    const t = setup([rule()]);
    let finish: (results: AffinityApplyResult[]) => void = () => undefined;
    t.enforce.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));

    const first = t.enforcer.maybeEnforce([proc(10)]);
    await vi.advanceTimersByTimeAsync(10 * SECOND);
    await t.enforcer.maybeEnforce([proc(10)]);
    finish([]);
    await first;

    expect(t.enforce).toHaveBeenCalledTimes(1);
  });

  it("backs off a process whose apply keeps failing, and never saves settings for it", async () => {
    const t = setup([rule()]);
    t.outcomes.set(10, { ok: false, error: "Access is denied" });
    const start = Date.now();

    await poll(t.enforcer, () => [proc(10)], 2 * HOUR);

    // Doubling from 8 s, capped at 30 min: 9 attempts in the first
    // hour's 900 samples.
    expect(passTimes(t.passes, 10, start)).toEqual([
      4, 12, 28, 60, 124, 252, 508, 1020, 2044, 3844, 5644,
    ]);
    expect(t.store.set).not.toHaveBeenCalled();
    expect(t.enforcer.rules()).toEqual(t.saved());
    // The first failure, then one summary once an hour had passed.
    expect(t.log.mock.calls).toEqual([
      ["affinity-rule-error", "rule=rule-game pid=10 name=game.exe: Access is denied; retrying in 8 s"],
      [
        "affinity-rule-error",
        "rule=rule-game pid=10 name=game.exe: Access is denied; retrying in 30 min (9 times since the last line 64 min ago)",
      ],
    ]);
  });

  it("logs a failing process again at once when its error changes", async () => {
    const t = setup([rule()]);
    t.outcomes.set(10, { ok: false, error: "Access is denied" });
    await poll(t.enforcer, () => [proc(10)], MINUTE);
    t.outcomes.set(10, { ok: false, error: "timeout" });

    // The next retry is at 124 s.
    await poll(t.enforcer, () => [proc(10)], 2 * MINUTE);

    expect(t.log.mock.calls.map(([, message]) => message)).toEqual([
      "rule=rule-game pid=10 name=game.exe: Access is denied; retrying in 8 s",
      "rule=rule-game pid=10 name=game.exe: timeout; retrying in 2 min",
    ]);
  });

  it("tries a failing process's successor at once, and the process again once its rule changes", async () => {
    const t = setup([rule()]);
    t.outcomes.set(10, { ok: false, error: "Access is denied" });
    await poll(t.enforcer, () => [proc(10)], 10 * MINUTE);

    // The game restarted as pid 11: tried on the next pass.
    t.outcomes.set(11, { ok: true });
    await poll(t.enforcer, () => [proc(10), proc(11)], 4 * SECOND);
    expect(t.passes.at(-1)?.pids).toEqual([11]);

    // The user picks other CPUs: pid 10 is tried again at once too.
    t.editRules([rule({ affinityMask: 0b11 })]);
    await poll(t.enforcer, () => [proc(10), proc(11)], 4 * SECOND);
    expect(t.passes.at(-1)?.pids).toEqual([10, 11]);
  });

  it("counts a process that keeps resetting its affinity in memory and saves the counts every 15 min", async () => {
    const t = setup([rule()]);
    t.outcomes.set(10, { ok: true });

    await poll(t.enforcer, () => [proc(10)], 14 * MINUTE);
    // Visible to the renderer at once, not saved yet.
    expect(t.enforcer.rules()[0]).toMatchObject({ appliedCount: 210, lastAppliedAt: Date.now() });
    expect(t.store.set).not.toHaveBeenCalled();

    await poll(t.enforcer, () => [proc(10)], HOUR - 14 * MINUTE);

    // At 15, 30 and 45 min after the first apply.
    expect(t.store.set).toHaveBeenCalledTimes(3);
    expect(t.saved()[0]!.appliedCount).toBe(675);
    expect(t.enforcer.rules()[0]!.appliedCount).toBe(900);
    // Quit.
    await t.enforcer.flush();
    expect(t.store.set).toHaveBeenCalledTimes(4);
    expect(t.saved()[0]).toMatchObject({ appliedCount: 900, lastAppliedAt: Date.now() });
    // The first apply, then a summary at most once an hour.
    expect(t.log).toHaveBeenCalledTimes(1);
    await poll(t.enforcer, () => [proc(10)], 4 * SECOND);
    expect(t.log.mock.calls.at(-1)).toEqual([
      "affinity-rule-applied",
      "rule=rule-game pid=10 name=game.exe prevMask=65535 newMask=15 (900 times since the last line 60 min ago)",
    ]);
  });

  it("saves counts into rules edited since, and skips the save for a deleted rule", async () => {
    const t = setup([rule(), rule({ id: "rule-other", matchPattern: "other.exe" })]);
    t.outcomes.set(10, { ok: true });
    await poll(t.enforcer, () => [proc(10)], 4 * SECOND);
    t.editRules([rule({ appliedCount: 5, enabled: false }), rule({ id: "rule-other", matchPattern: "other.exe" })]);

    await t.enforcer.flush();

    expect(t.saved()[0]).toMatchObject({ appliedCount: 6, enabled: false });
    expect(t.saved()[1]!.appliedCount).toBe(0);

    t.editRules([rule({ appliedCount: 6 }), rule({ id: "rule-other", matchPattern: "other.exe" })]);
    await poll(t.enforcer, () => [proc(10)], 4 * SECOND);
    expect(t.enforcer.rules()[0]!.appliedCount).toBe(7);
    t.editRules([rule({ id: "rule-other", matchPattern: "other.exe" })]);
    await t.enforcer.flush();

    expect(t.store.set).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AFFINITY_COUNTER_FLUSH_MS);
    expect(t.store.set).toHaveBeenCalledTimes(1);
  });

  it("retries a failed counter save on the next interval, and at quit", async () => {
    const t = setup([rule()]);
    t.outcomes.set(10, { ok: true });
    await poll(t.enforcer, () => [proc(10)], 4 * SECOND);
    t.store.set.mockImplementationOnce(async (next) => {
      t.editRules(next.affinityRules);
      throw new Error("ENOSPC: no space left on device");
    });
    t.outcomes.clear();

    await t.enforcer.flush();
    expect(t.log.mock.calls.at(-1)).toEqual([
      "affinity-rule-error",
      "saving rule counters failed: ENOSPC: no space left on device",
    ]);
    // The process is satisfied now, so nothing new is counted.
    await vi.advanceTimersByTimeAsync(AFFINITY_COUNTER_FLUSH_MS);

    expect(t.store.set).toHaveBeenCalledTimes(2);
    expect(t.saved()[0]!.appliedCount).toBe(1);
    await t.enforcer.flush();
    expect(t.store.set).toHaveBeenCalledTimes(2);
  });

  it("logs a repeat after an hour without a count when nothing was held back", async () => {
    const t = setup([rule()]);
    t.outcomes.set(10, { ok: true });
    await poll(t.enforcer, () => [proc(10)], 4 * SECOND);
    t.outcomes.clear();
    await poll(t.enforcer, () => [proc(10)], 2 * HOUR);
    t.outcomes.set(10, { ok: true });

    await poll(t.enforcer, () => [proc(10)], 4 * SECOND);

    expect(t.log.mock.calls.map(([, message]) => message)).toEqual([
      "rule=rule-game pid=10 name=game.exe prevMask=65535 newMask=15",
      "rule=rule-game pid=10 name=game.exe prevMask=65535 newMask=15",
    ]);
  });

  it("keeps the saved counters when the renderer saves a rule", () => {
    const saved = [rule({ appliedCount: 7, lastAppliedAt: 5_000 })];
    // The renderer's copy carries counts from rules(), not saved yet.
    const edited = rule({ enabled: false, appliedCount: 40, lastAppliedAt: 9_000 });
    const added = rule({ id: "rule-new", matchPattern: "new.exe" });

    expect(upsertAffinityRule(saved, edited)).toEqual([
      rule({ enabled: false, appliedCount: 7, lastAppliedAt: 5_000 }),
    ]);
    expect(upsertAffinityRule(saved, added)).toEqual([saved[0], added]);
  });
});
