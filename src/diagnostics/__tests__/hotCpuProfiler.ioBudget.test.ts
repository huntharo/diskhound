import * as FS from "node:fs";
import * as FSP from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { HotCpuProfiler } from "../hotCpuProfiler";
import {
  crashLogLike,
  deferred,
  fakeInspector,
  hotCpuConfig,
  realisticWindow,
  session as makeSession,
  tempDir,
} from "./diagnosticsTestKit";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));

const HOUR = 3_600_000;

const cleanups: Array<() => Promise<void>> = [];
const profilers: HotCpuProfiler[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(profilers.splice(0).map((profiler) => profiler.stop("test-cleanup")));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * A profiler on fake time whose inspector returns windows the size V8
 * records: 1 ms samples for as long as the window ran.
 */
async function launch(options: { maxProfiles?: number; thresholdPercent?: number } = {}) {
  const dir = await tempDir("diskhound-hot-cpu-io-");
  cleanups.push(dir.cleanup);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let recordingStart = Date.now();
  const { inspector, post, calls } = fakeInspector();
  const answer = post.getMockImplementation()!;
  post.mockImplementation(async (method: string) => {
    if (method === "Profiler.start") recordingStart = Date.now();
    if (method === "Profiler.stop") {
      const seconds = Math.max(1, Math.round((Date.now() - recordingStart) / 1000));
      return { profile: realisticWindow({ startTime: recordingStart * 1000, seconds }) };
    }
    return answer(method);
  });
  const cpu = { percent: 1, micros: 0, lastAt: Date.now() };
  const written = { next: deferred() };
  const session = makeSession(dir.path, "hot-cpu");
  const profiler = new HotCpuProfiler({
    config: hotCpuConfig({ maxProfiles: options.maxProfiles ?? 5, thresholdPercent: options.thresholdPercent ?? 50 }),
    session,
    inspector,
    readCpu: () => {
      const now = Date.now();
      cpu.micros += (now - cpu.lastAt) * 10 * cpu.percent;
      cpu.lastAt = now;
      return { threadMicros: cpu.micros, processMicros: cpu.micros };
    },
    readHeapUsed: () => 180 * 1024 * 1024,
    now: Date.now,
    monotonicNow: Date.now,
    log: crashLogLike(dir.path),
    onProfileWritten: () => {
      written.next.resolve();
      written.next = deferred();
    },
  });
  profilers.push(profiler);
  // Setup: arming logs one crash.log line per launch.
  await profiler.start();
  return { dir: dir.path, cpu, written, session, profiler, calls };
}

describe("hot-CPU profiler disk writes", () => {
  it("writes nothing while the main thread idles for an hour", async () => {
    const { calls, session } = await launch();
    const { io } = await measureFsIo(() => vi.advanceTimersByTimeAsync(HOUR));

    expectIoBudget({
      scenario: "hot-cpu-idle-hour",
      note: "profiler on, main thread idle for an hour (1,785 samples 2 s apart, ~119 rotations of the 30 s window): 0 writes; samples and events stay in memory, recordings stay in V8. 0/day at any threshold, including the 5% minimum",
      io,
    });
    expect(calls("Profiler.stop")).toBeGreaterThanOrEqual(115);
    expect(FS.existsSync(session.directoryPath)).toBe(false);
  });

  it("writes one joined profile, its samples and events, and a crash.log line per capture", async () => {
    const { cpu, written, session } = await launch();
    // Windows rotate at 30, 60 and 90 s. Going hot at 116 s triggers at
    // 120 s, just before the next rotation: the longest lookback, the
    // 60–90 s window plus 30 s of the live one.
    await vi.advanceTimersByTimeAsync(116_000);
    const { io } = await measureFsIo(async () => {
      cpu.percent = 95;
      const done = written.next.promise;
      await vi.advanceTimersByTimeAsync(4_000 + 15_000);
      await done;
    });

    expectIoBudget({
      scenario: "hot-cpu-capture",
      note: "the first capture of a launch (a 75 s joined profile of 1 ms samples, ~1.6 MB): the session folder, the .cpuprofile, samples.ndjson, events.ndjson, session.json and a crash.log line with its path; later captures skip the folder. Off by default: 0/day. On: at most 5 per launch, 60 s apart, at any threshold (5% is the most aggressive): <= 35 write calls (5 captures plus the armed and capped crash.log lines) and ~8.5 MB per launch, which in the tray usually spans a day or more",
      io,
    });
    const profile = JSON.parse(await FSP.readFile(session.artifactPath("main-hot-0001.cpuprofile"), "utf8"));
    // 30 s + 30 s before the trigger, 15 s after.
    expect(Math.round((profile.endTime - profile.startTime) / 1e6)).toBe(75);
  });

  it("writes nothing once the per-launch cap is reached, however hot the main thread runs", async () => {
    const { cpu, written, profiler } = await launch({ maxProfiles: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    cpu.percent = 100;
    const done = written.next.promise;
    await vi.advanceTimersByTimeAsync(20_000);
    await done;
    expect(profiler.status().state).toBe("capped");

    const { io } = await measureFsIo(() => vi.advanceTimersByTimeAsync(HOUR));

    expectIoBudget({
      scenario: "hot-cpu-capped-hour",
      note: "an hour at 100% main-thread CPU after the launch's last allowed capture: 0 writes; the profiler has stopped sampling and recording",
      io,
    });
  });
});
