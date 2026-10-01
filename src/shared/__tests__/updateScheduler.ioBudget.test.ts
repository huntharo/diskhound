import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { createUpdaterStateStore } from "../updaterStateStore";
import { createUpdateScheduler, STABLE_UPDATE_INTERVAL_MS, UPDATE_STARTUP_DELAY_MS } from "../updateScheduler";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));

let root: string;
let scheduler: ReturnType<typeof createUpdateScheduler>;
beforeEach(async () => {
  root = await FSP.mkdtemp(Path.join(OS.tmpdir(), "updater-scheduler-io-"));
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T03:00:00Z"));
});
afterEach(() => {
  scheduler.stop();
  vi.useRealTimers();
  FS.rmSync(root, { recursive: true, force: true });
});

it.each([false, true])("budgets the whole automatic check (failure=%s)", async failure => {
  const check = vi.fn(async () => { if (failure) throw new Error("offline"); });
  const state = createUpdaterStateStore(Path.join(root, "updater-state.json"));
  scheduler = createUpdateScheduler({ state, check, enabled: () => true, interval: () => STABLE_UPDATE_INTERVAL_MS });
  const { io: startup } = await measureFsIo(() => scheduler.schedule());
  expectIoBudget({ scenario: "updater-schedule-startup", note: "Scheduling a launch from loaded state: zero reads/writes, even at 20 launches/minute.", io: startup });
  const { io } = await measureFsIo(async () => { await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY_MS); });
  expect(check).toHaveBeenCalledTimes(1);
  expectIoBudget({ scenario: failure ? "updater-scheduled-failure" : "updater-scheduled-success",
    note: "One complete automatic attempt: 2 small JSON writes (reservation + result), zero reads. Stable: 12 writes/day, <0.01 MB/day; beta (30 min): 96 writes/day, <0.05 MB/day. Errors back off further. Manual checks add 2 writes/click; no 1-minute mode.", io });
});
