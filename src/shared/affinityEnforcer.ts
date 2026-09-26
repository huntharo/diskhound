import type { AffinityApplyResult } from "../affinityRuleEngine";
import type { AffinityRule, AppSettings, ProcessInfo } from "./contracts";

/**
 * Drives the affinity-rule engine from the memory sampler, and keeps
 * what it learns off the disk unless something changed.
 *
 * The renderer asks for a memory sample every 2-5 s (SystemWidget
 * every 4 s, even while hidden), and each sample offers a pass here,
 * for as long as the app runs in the tray. Saving settings.json and
 * writing a crash.log line for every result of every pass cost a save
 * and a synchronous append every 4 s for a process that resets its
 * own affinity, or one DiskHound is denied access to: about 21,600 of
 * each a day. So:
 *
 * - Failed applies are never persisted. A process that keeps failing
 *   is retried on a backoff that doubles from 8 s to 30 min.
 * - `appliedCount` / `lastAppliedAt` are counted in memory. `rules()`
 *   shows them to the renderer at once; `flush()` writes them to
 *   settings.json at most once per 15 min, and main.ts calls it at
 *   quit. A crash loses at most 15 min of counts.
 * - A process's log line is written when its outcome changes. Repeats
 *   of the same outcome are counted and summarized at most once an
 *   hour.
 */

/** One pass per 4 s however often the sampler runs. Affinity reads and
 *  writes shell out to PowerShell, so this bounds that cost too. */
const AFFINITY_ENFORCE_INTERVAL_MS = 4_000;
/** Unflushed counters are written this long after the first one. */
export const AFFINITY_COUNTER_FLUSH_MS = 15 * 60_000;
/** Longest wait between retries of a process whose apply keeps failing. */
const AFFINITY_MAX_BACKOFF_MS = 30 * 60_000;
/** A process that repeats its last logged outcome is logged at most this often. */
const AFFINITY_LOG_REPEAT_MS = 60 * 60_000;

export interface AffinityEnforcerDeps {
  settings: {
    get: () => AppSettings;
    set: (next: AppSettings) => Promise<void>;
  };
  enforce: (rules: AffinityRule[], processes: ProcessInfo[]) => Promise<AffinityApplyResult[]>;
  /** writeCrashLog in main.ts. */
  log: (tag: string, message: string) => void;
  /** Affinity rules only apply on Windows. */
  isSupported: () => boolean;
  now?: () => number;
}

export interface AffinityEnforcer {
  /** Offers a pass against a fresh process sample. Runs one when due. */
  maybeEnforce: (processes: ProcessInfo[]) => Promise<void>;
  /** The saved rules with the counts not flushed yet added. */
  rules: () => AffinityRule[];
  /** Writes the unflushed counts to settings.json, if there are any. */
  flush: () => Promise<void>;
}

interface PendingCount {
  count: number;
  lastAppliedAt: number;
}

/** What the enforcer remembers about one process a rule acted on. */
interface TrackedProcess {
  name: string;
  ruleId: string;
  mask: number;
  /** Consecutive failed applies. */
  failures: number;
  /** A failing process is skipped until then. */
  retryAt: number;
  /** "applied", or "failed: <error>", as last logged. */
  loggedOutcome: string;
  loggedAt: number;
  /** Times `loggedOutcome` happened again without a log line. */
  repeats: number;
}

export function createAffinityEnforcer(deps: AffinityEnforcerDeps): AffinityEnforcer {
  const now = deps.now ?? Date.now;
  let lastPassAt = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  let pending = new Map<string, PendingCount>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** A save failed: the store holds the counts in memory, not on disk. */
  let saveFailed = false;
  /** Keyed by pid; dropped when the pid leaves the sample. */
  const tracked = new Map<number, TrackedProcess>();

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, AFFINITY_COUNTER_FLUSH_MS);
    flushTimer.unref?.();
  };

  const flush = async () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pending.size === 0 && !saveFailed) return;
    const counts = pending;
    pending = new Map();
    const current = deps.settings.get();
    const affinityRules = withCounts(current.affinityRules, counts);
    // Every counted rule was deleted since, and nothing is left to retry.
    if (affinityRules === current.affinityRules && !saveFailed) return;
    try {
      await deps.settings.set({ ...current, affinityRules });
      saveFailed = false;
    } catch (error) {
      // The store applied the counts in memory before the write failed,
      // so retrying is saving its current settings again.
      saveFailed = true;
      scheduleFlush();
      deps.log("affinity-rule-error", `saving rule counters failed: ${errorText(error)}`);
    }
  };

  /** False when a failing process is still backing off. */
  const isDue = (proc: ProcessInfo, rules: AffinityRule[], at: number): boolean => {
    const state = tracked.get(proc.pid);
    if (!state) return true;
    const rule = rules.find((r) => r.id === state.ruleId);
    // A reused pid, or a rule edited since: start over.
    if (state.name !== proc.name || !rule?.enabled || rule.affinityMask !== state.mask) {
      tracked.delete(proc.pid);
      return true;
    }
    return at >= state.retryAt;
  };

  const logOutcome = (state: TrackedProcess, outcome: string, tag: string, message: string, at: number) => {
    const repeat = state.loggedOutcome === outcome;
    if (repeat && at - state.loggedAt < AFFINITY_LOG_REPEAT_MS) {
      state.repeats += 1;
      return;
    }
    const minutes = Math.round((at - state.loggedAt) / 60_000);
    const summary = repeat && state.repeats > 0
      ? ` (${state.repeats + 1} times since the last line ${minutes} min ago)`
      : "";
    deps.log(tag, `${message}${summary}`);
    state.loggedOutcome = outcome;
    state.loggedAt = at;
    state.repeats = 0;
  };

  const record = (result: AffinityApplyResult, at: number) => {
    let state = tracked.get(result.pid);
    if (!state || state.ruleId !== result.ruleId || state.name !== result.processName) {
      state = {
        name: result.processName,
        ruleId: result.ruleId,
        mask: result.newMask,
        failures: 0,
        retryAt: 0,
        loggedOutcome: "",
        loggedAt: at,
        repeats: 0,
      };
      tracked.set(result.pid, state);
    }
    const subject = `rule=${result.ruleId} pid=${result.pid} name=${result.processName}`;

    if (result.ok) {
      state.failures = 0;
      state.retryAt = 0;
      const count = pending.get(result.ruleId);
      pending.set(result.ruleId, { count: (count?.count ?? 0) + 1, lastAppliedAt: at });
      scheduleFlush();
      logOutcome(
        state,
        "applied",
        "affinity-rule-applied",
        `${subject} prevMask=${result.previousMask} newMask=${result.newMask}`,
        at,
      );
      return;
    }

    state.failures += 1;
    const backoff = Math.min(AFFINITY_ENFORCE_INTERVAL_MS * 2 ** state.failures, AFFINITY_MAX_BACKOFF_MS);
    state.retryAt = at + backoff;
    const error = result.error ?? "unknown error";
    logOutcome(
      state,
      `failed: ${error}`,
      "affinity-rule-error",
      `${subject}: ${error}; retrying in ${formatDuration(backoff)}`,
      at,
    );
  };

  return {
    maybeEnforce: async (processes) => {
      if (!deps.isSupported()) return;
      if (inFlight) return;
      const startedAt = now();
      if (startedAt - lastPassAt < AFFINITY_ENFORCE_INTERVAL_MS) return;
      const rules = deps.settings.get().affinityRules;
      if (rules.length === 0) return;

      inFlight = true;
      try {
        const live = new Set(processes.map((proc) => proc.pid));
        for (const pid of tracked.keys()) {
          if (!live.has(pid)) tracked.delete(pid);
        }
        const due = processes.filter((proc) => isDue(proc, rules, startedAt));
        const results = await deps.enforce(rules, due);
        const finishedAt = now();
        for (const result of results) record(result, finishedAt);
      } finally {
        lastPassAt = now();
        inFlight = false;
      }
    },
    rules: () => withCounts(deps.settings.get().affinityRules, pending),
    flush,
  };
}

/**
 * The rules after the renderer saves `rule`. The enforcer owns
 * `appliedCount` and `lastAppliedAt`: the renderer's copy came from
 * `rules()` and includes counts not flushed yet, so saving it as-is
 * would count them again at the next flush.
 */
export function upsertAffinityRule(rules: AffinityRule[], rule: AffinityRule): AffinityRule[] {
  const index = rules.findIndex((r) => r.id === rule.id);
  if (index < 0) return [...rules, rule];
  const saved = rules[index]!;
  const next = rules.slice();
  next[index] = { ...rule, appliedCount: saved.appliedCount, lastAppliedAt: saved.lastAppliedAt };
  return next;
}

/** `rules` with `counts` added; the same array when no rule has a count. */
function withCounts(rules: AffinityRule[], counts: Map<string, PendingCount>): AffinityRule[] {
  if (counts.size === 0 || !rules.some((rule) => counts.has(rule.id))) return rules;
  return rules.map((rule) => {
    const count = counts.get(rule.id);
    if (!count) return rule;
    return {
      ...rule,
      appliedCount: rule.appliedCount + count.count,
      lastAppliedAt: Math.max(rule.lastAppliedAt ?? 0, count.lastAppliedAt),
    };
  });
}

function formatDuration(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
