import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createUpdaterStateStore } from "../updaterStateStore";
import { BETA_UPDATE_INTERVAL_MS as BETA, STABLE_UPDATE_INTERVAL_MS as STABLE,
  UPDATE_STARTUP_DELAY_MS as GRACE, createUpdateScheduler, updateRetryAfter } from "../updateScheduler";

let root: string;
let enabled: boolean;
let interval: number;
const schedulers: ReturnType<typeof createUpdateScheduler>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T03:00:00Z"));
  root = FS.mkdtempSync(Path.join(OS.tmpdir(), "update-scheduler-"));
  enabled = true;
  interval = STABLE;
});
afterEach(() => {
  schedulers.splice(0).forEach(s => s.stop());
  vi.useRealTimers();
  FS.rmSync(root, { recursive: true, force: true });
});
function boot(check = vi.fn(async () => undefined), profile = "state.json") {
  const state = createUpdaterStateStore(Path.join(root, profile));
  const scheduler = createUpdateScheduler({ state, enabled: () => enabled, interval: () => interval, check });
  schedulers.push(scheduler);
  scheduler.schedule();
  return { state, scheduler, check };
}

it("makes zero checks during 20 screenshot restarts/minute, including fresh profiles", async () => {
  const check = vi.fn(async () => undefined);
  for (let launch = 0; launch < 20; launch++) {
    const same = boot(check);
    const fresh = boot(check, `fresh-${launch}.json`);
    await vi.advanceTimersByTimeAsync(3000);
    same.scheduler.stop();
    fresh.scheduler.stop();
  }
  expect(check).not.toHaveBeenCalled();
  const { scheduler } = boot(check, "new-profile.json");
  await vi.advanceTimersByTimeAsync(GRACE - 1);
  expect(check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(check).toHaveBeenCalledTimes(1);
  scheduler.stop();
});

it.each([STABLE, BETA])("persists the %i ms interval across restarts and version/channel changes", async cadence => {
  interval = cadence;
  const { scheduler, check, state } = boot();
  await vi.advanceTimersByTimeAsync(GRACE);
  const attempted = Date.now();
  expect(state.get()).toMatchObject({ lastAttemptAt: attempted, lastSuccessAt: attempted });
  scheduler.stop();
  for (let launch = 0; launch < 20; launch++) {
    const next = boot(check);
    await vi.advanceTimersByTimeAsync(3000);
    next.scheduler.stop();
  }
  interval = BETA; // Changing channels does not erase a persisted reservation.
  boot(check);
  await vi.advanceTimersByTimeAsync(cadence - 60_000 - 1);
  expect(check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(check).toHaveBeenCalledTimes(2);
});

it("reserves before I/O so a crash mid-check still throttles the next process", async () => {
  const { scheduler } = boot(vi.fn(() => new Promise<undefined>(() => {})));
  await vi.advanceTimersByTimeAsync(GRACE);
  scheduler.stop();
  const next = boot();
  expect(next.state.get().lastAttemptAt).toBe(Date.now());
  expect(next.state.get().lastSuccessAt).toBeNull();
  await vi.advanceTimersByTimeAsync(STABLE - 1);
  expect(next.check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(next.check).toHaveBeenCalledTimes(1);
});

it("migrates lastCheckedAt without an immediate request or a startup write", async () => {
  FS.writeFileSync(Path.join(root, "state.json"), JSON.stringify({ lastCheckedAt: Date.now() }));
  const { check } = boot();
  await vi.advanceTimersByTimeAsync(STABLE - 1);
  expect(check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(check).toHaveBeenCalledTimes(1);
});

it("persists reset headers and exponential failure backoff, then clears them on success", async () => {
  interval = BETA;
  const reset = Date.now() + GRACE + 2 * BETA;
  const check = vi.fn(async () => undefined)
    .mockRejectedValueOnce(new Error(`403 Forbidden\nHeaders: {"x-ratelimit-reset":["${reset / 1000}"]}`))
    .mockRejectedValueOnce(new Error("offline"));
  const first = boot(check);
  await vi.advanceTimersByTimeAsync(GRACE);
  expect(first.state.get().retryAfterAt).toBe(reset + 1000);
  first.scheduler.stop();
  const next = boot(check);
  await vi.advanceTimersByTimeAsync(2 * BETA + 999);
  expect(check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(check).toHaveBeenCalledTimes(2);
  expect(next.state.get().consecutiveFailures).toBe(2);
  next.scheduler.stop();
  const last = boot(check);
  await vi.advanceTimersByTimeAsync(2 * BETA - 1);
  expect(check).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(check).toHaveBeenCalledTimes(3);
  expect(last.state.get()).toMatchObject({ consecutiveFailures: 0, retryAfterAt: null, lastSuccessAt: Date.now() });
});

it("keeps manual checks immediate with auto-update disabled and coalesces concurrent clicks", async () => {
  enabled = false;
  let complete!: () => void;
  const check = vi.fn(() => new Promise<undefined>(resolve => { complete = () => resolve(undefined); }));
  const { scheduler } = boot(check);
  const first = scheduler.checkNow();
  expect(scheduler.checkNow()).toBe(first);
  await Promise.resolve();
  expect(check).toHaveBeenCalledTimes(1);
  complete();
  await first;
  enabled = true;
  scheduler.schedule();
  await vi.advanceTimersByTimeAsync(STABLE - 1);
  expect(check).toHaveBeenCalledTimes(1);
  scheduler.stop();
  await vi.advanceTimersByTimeAsync(STABLE);
  expect(check).toHaveBeenCalledTimes(1);
});

it("parses Retry-After seconds/dates without trusting malformed headers", () => {
  const now = Date.now();
  expect(updateRetryAfter(new Error('429 Headers: {"retry-after":"120"}'), now)).toBe(now + 121_000);
  expect(updateRetryAfter(new Error(`429 Headers: {"retry-after":"${new Date(now + 120_000).toUTCString()}"}`), now)).toBe(now + 121_000);
  expect(updateRetryAfter(new Error('Headers: {"x-ratelimit-reset":"NaN"}'), now)).toBeNull();
});

it.each([[STABLE, 6], [BETA, 48]])("bounds six independent profiles for a day (interval=%i)", async (cadence, daily) => {
  interval = cadence;
  const check = vi.fn(async () => undefined);
  for (let machine = 0; machine < 6; machine++) boot(check, `machine-${machine}.json`);
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
  expect(check).toHaveBeenCalledTimes(6 * daily);
});

it("caps repeated failures at one automatic attempt per day", async () => {
  interval = BETA;
  const { scheduler, state } = boot(vi.fn(async () => { throw new Error("offline"); }));
  for (let attempt = 0; attempt < 10; attempt++) await scheduler.checkNow();
  expect(state.get().nextCheckAt).toBe(Date.now() + 24 * 60 * 60 * 1000);
  expect(state.get().lastSuccessAt).toBeNull();
});
