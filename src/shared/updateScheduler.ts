import type { UpdaterStateStore } from "./updaterStateStore";

export const UPDATE_STARTUP_DELAY_MS = 10 * 60 * 1000;
export const STABLE_UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const BETA_UPDATE_INTERVAL_MS = 30 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

/** electron-updater wraps HTTP errors, retaining response headers in the message. */
export function updateRetryAfter(error: unknown, now: number): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const header = (name: string) => {
    const match = new RegExp(`"${name}"\\s*:\\s*(?:\\[\\s*)?(?:"([^"]+)"|([^\\]\\r\\n,}]+))`, "i").exec(message);
    return (match?.[1] ?? match?.[2])?.trim();
  };
  const reset = Number(header("x-ratelimit-reset")) * 1000;
  const retry = header("retry-after");
  const retryAt = retry === undefined ? NaN
    : /^\d+$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry);
  const until = Math.max(Number.isFinite(reset) ? reset : 0, Number.isFinite(retryAt) ? retryAt : 0);
  return until > now ? until + 1000 : null;
}

export function createUpdateScheduler(options: {
  state: UpdaterStateStore;
  enabled: () => boolean;
  interval: () => number;
  check: () => Promise<unknown>;
}) {
  // Every process gets a grace period, including an overdue existing profile.
  // Short screenshot/agent launches therefore never perform automatic checks.
  const startupAt = Date.now() + UPDATE_STARTUP_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = false;

  const clear = () => { clearTimeout(timer); timer = undefined; };
  const dueAt = () => {
    const state = options.state.get();
    // Migrate old profiles conservatively: lastCheckedAt used to record both
    // successful checks and failures, but was never used for scheduling.
    const attempted = state.lastAttemptAt ?? state.lastCheckedAt;
    return Math.max(startupAt, state.nextCheckAt ?? (attempted === null ? 0 : attempted + options.interval()),
      state.retryAfterAt ?? 0);
  };
  const schedule = () => {
    clear();
    if (stopped || inFlight || !options.enabled()) return;
    timer = setTimeout(() => { timer = undefined; void run(false); },
      Math.min(2_147_483_647, Math.max(0, dueAt() - Date.now())));
    timer.unref?.();
  };
  const run = (manual: boolean): Promise<void> => {
    if (inFlight) return inFlight;
    if (stopped || (!manual && !options.enabled())) return Promise.resolve();
    // A very distant server deadline may require several timer segments.
    if (!manual && dueAt() > Date.now()) {
      schedule();
      return Promise.resolve();
    }
    clear();
    const now = Date.now();
    // Reserve before I/O, so a crash or quit mid-request cannot reset the budget.
    options.state.update({ lastAttemptAt: now, lastCheckedAt: now, nextCheckAt: now + options.interval() });
    inFlight = Promise.resolve().then(options.check).then(() => {
      options.state.update({ lastSuccessAt: Date.now(), nextCheckAt: Date.now() + options.interval(),
        retryAfterAt: null, consecutiveFailures: 0 });
    }, (error: unknown) => {
      const failures = Math.min(10, options.state.get().consecutiveFailures + 1);
      const retryAt = Math.max(options.state.get().retryAfterAt ?? 0, updateRetryAfter(error, Date.now()) ?? 0);
      const retryAfterAt = retryAt > Date.now() ? retryAt : null;
      options.state.update({ consecutiveFailures: failures, retryAfterAt,
        nextCheckAt: Math.max(Date.now() + Math.min(MAX_BACKOFF_MS, options.interval() * 2 ** (failures - 1)), retryAfterAt ?? 0) });
    }).finally(() => { inFlight = undefined; schedule(); });
    return inFlight;
  };
  return {
    schedule,
    // Installation may fail without quitting. Only cancel the pending timer;
    // manual checks and schedule() must remain usable in that process.
    cancelPending: clear,
    // An explicit user action bypasses automatic delays/backoff; concurrent
    // actions share one request. It also advances the automatic schedule.
    checkNow: () => run(true),
    stop: () => { stopped = true; clear(); },
  };
}
