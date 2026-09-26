import * as FS from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Profiler } from "node:inspector";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HotCpuProfiler, type CpuReading } from "../hotCpuProfiler";
import { createMainInspector } from "../mainInspector";
import {
  deferred,
  fakeInspector,
  hotCpuConfig,
  sampleTracker,
  session as makeSession,
  tempDir,
} from "./diagnosticsTestKit";

// The profiler tests are ported from PwrAgnt's
// renderer-hot-cpu-profiler.test.ts. PwrAgnt reads the CPU from
// app.getAppMetrics(); DiskHound reads the main thread's own CPU time,
// so the fakes below drive `readCpu` instead.

/** CPU readings where each hot sample used `percent` of the wall time since the last. */
function cpuSource(clock: () => number) {
  let micros = 0;
  let processMicros = 0;
  let lastAt = clock();
  const state = { threadPercent: 0, processPercent: 0 };
  const read = (): CpuReading => {
    const now = clock();
    const wallMicros = (now - lastAt) * 1000;
    micros += wallMicros * (state.threadPercent / 100);
    processMicros += wallMicros * (Math.max(state.threadPercent, state.processPercent) / 100);
    lastAt = now;
    return { threadMicros: micros, processMicros };
  };
  return { read, state };
}

describe("HotCpuProfiler", () => {
  const cleanups: Array<() => Promise<void>> = [];
  const profilers: HotCpuProfiler[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(profilers.splice(0).map((profiler) => profiler.stop("test-cleanup")));
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  function track(profiler: HotCpuProfiler): HotCpuProfiler {
    profilers.push(profiler);
    return profiler;
  }

  it("captures a real main-thread burst that finishes before the trigger is evaluated", async () => {
    const dir = await tempDir();
    cleanups.push(dir.cleanup);
    const session = makeSession(dir.path, "hot-cpu");
    const written = deferred();
    const samples = sampleTracker();
    let burstFinished = false;
    let micros = 0;
    const profiler = track(new HotCpuProfiler({
      config: hotCpuConfig({ startDelayMs: 0, intervalMs: 5, consecutiveSamples: 1, profileDurationMs: 10, maxProfiles: 1 }),
      session,
      inspector: createMainInspector(),
      // Hot only once the burst has run, like a sample evaluated after it.
      readCpu: () => {
        if (burstFinished) micros += 1e9;
        return { threadMicros: micros, processMicros: micros };
      },
      onProfileWritten: () => written.resolve(),
      onSampleCaptured: samples.onSampleCaptured,
    }));
    await profiler.start();
    await samples.waitForCount(1);
    // The inspector samples this synchronous function, but the timer
    // can't evaluate the trigger until it has returned.
    function preTriggerCpuBurst(): void {
      const end = performance.now() + 150;
      while (performance.now() < end) Math.sqrt(Math.random());
    }
    preTriggerCpuBurst();
    burstFinished = true;
    await written.promise;
    await profiler.stop();

    const profile = JSON.parse(await FS.readFile(session.artifactPath("main-hot-0001.cpuprofile"), "utf8")) as Profiler.Profile;
    const burstIds = new Set(profile.nodes
      .filter((node) => node.callFrame.functionName === "preTriggerCpuBurst")
      .map((node) => node.id));
    expect(burstIds.size).toBeGreaterThan(0);
    expect(profile.samples!.some((id) => burstIds.has(id))).toBe(true);
  });

  it.each([false, true])("bounds history across rotations and capture limits (failing reads: %s)", async (failingReads) => {
    const dir = await tempDir();
    cleanups.push(dir.cleanup);
    const session = makeSession(dir.path, "hot-cpu");
    vi.useFakeTimers();
    let recordingStart = 0;
    let windowIndex = 0;
    const frame = { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 };
    const { inspector, post } = fakeInspector();
    post.mockImplementation(async (method: string) => {
      if (method === "Profiler.start") recordingStart = Date.now() * 1_000;
      if (method !== "Profiler.stop") return {};
      const endTime = Date.now() * 1_000;
      const name = ["expiredHistory", "burstBeforeRotation", "burstAfterRotation"][windowIndex++];
      return { profile: {
        nodes: [
          { id: 1, callFrame: frame, children: [2] },
          { id: 2, callFrame: { ...frame, functionName: name } },
        ],
        startTime: recordingStart,
        endTime,
        samples: [2],
        timeDeltas: [endTime - recordingStart],
      } };
    });
    const cpu = cpuSource(Date.now);
    const written = deferred();
    const samples = sampleTracker();
    const config = hotCpuConfig({ startDelayMs: 0, intervalMs: 30_000, consecutiveSamples: 1, profileDurationMs: 10, maxProfiles: 1 });
    const profiler = track(new HotCpuProfiler({
      config,
      session,
      inspector,
      readCpu: cpu.read,
      // Fails the sample after its CPU reading, like PwrAgnt's missing metric.
      readHeapUsed: () => {
        if (failingReads && cpu.state.threadPercent === 0) throw new Error("fixture read failure");
        return 0;
      },
      now: Date.now,
      monotonicNow: Date.now,
      onProfileWritten: () => written.resolve(),
      onSampleCaptured: samples.onSampleCaptured,
    }));
    await profiler.start();
    expect(post).toHaveBeenCalledWith("Profiler.start");
    await vi.advanceTimersByTimeAsync(0);
    await samples.waitForCount(1);
    for (let count = 2; count <= 3; count += 1) {
      await vi.advanceTimersByTimeAsync(config.intervalMs);
      await samples.waitForCount(count);
    }
    expect(windowIndex).toBe(2);
    // Nothing on disk until a capture: not even the session directory.
    expect(existsSync(session.directoryPath)).toBe(false);
    cpu.state.threadPercent = 80;
    await vi.advanceTimersByTimeAsync(config.intervalMs);
    await samples.waitForCount(4);
    // Detection happens before rotation: the still-running window is
    // frozen for the post-trigger duration, not discarded at the boundary.
    expect(windowIndex).toBe(2);
    await vi.advanceTimersByTimeAsync(config.profileDurationMs);
    await written.promise;
    await profiler.stop();
    const profile = JSON.parse(await FS.readFile(session.artifactPath("main-hot-0001.cpuprofile"), "utf8")) as Profiler.Profile;
    const names = profile.nodes.map((node) => node.callFrame.functionName);
    expect(names).toContain("burstBeforeRotation");
    expect(names).toContain("burstAfterRotation");
    expect(names).not.toContain("expiredHistory");
    // 30 s of the previous window, 30 s of the live one, 10 ms after.
    expect(profile.endTime - profile.startTime).toBe(60_010_000);
    expect(post.mock.calls.filter(([method]) => method === "Profiler.start")).toHaveLength(3);
    expect(post.mock.calls.filter(([method]) => method === "Profiler.stop")).toHaveLength(3);
    expect(inspector.isAttached()).toBe(false);
    const manifest = JSON.parse(await FS.readFile(session.artifactPath("session.json"), "utf8"));
    expect(manifest.artifacts).toEqual([expect.objectContaining({
      filename: "main-hot-0001.cpuprofile",
      kind: "cpuprofile",
      detail: expect.objectContaining({ lookbackMs: 60_000, triggerCpuPercent: 80 }),
    })]);
  });

  it("discards an untriggered recorder and waits for an in-flight start during shutdown", async () => {
    const dir = await tempDir();
    cleanups.push(dir.cleanup);
    const session = makeSession(dir.path, "hot-cpu");
    const { inspector, post } = fakeInspector();
    const startEntered = deferred();
    const releaseStart = deferred();
    const answer = post.getMockImplementation()!;
    post.mockImplementation(async (method: string) => {
      if (method === "Profiler.start") {
        startEntered.resolve();
        await releaseStart.promise;
      }
      return answer(method);
    });
    const onProfileWritten = vi.fn();
    const profiler = track(new HotCpuProfiler({
      config: hotCpuConfig(),
      session,
      inspector,
      readCpu: () => ({ threadMicros: 0, processMicros: 0 }),
      onProfileWritten,
    }));
    const started = profiler.start();
    await startEntered.promise;
    let stopped = false;
    const stopping = profiler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseStart.resolve();
    await Promise.all([started, stopping]);
    expect(post).toHaveBeenCalledWith("Profiler.stop");
    expect(inspector.isAttached()).toBe(false);
    expect(onProfileWritten).not.toHaveBeenCalled();
    expect(existsSync(session.directoryPath)).toBe(false);
  });

  it("needs consecutive hot samples, honors the cooldown, and stops at the per-launch cap", async () => {
    const dir = await tempDir();
    cleanups.push(dir.cleanup);
    const session = makeSession(dir.path, "hot-cpu");
    vi.useFakeTimers();
    const { inspector, calls } = fakeInspector();
    const cpu = cpuSource(Date.now);
    const samples = sampleTracker();
    const log = vi.fn();
    const config = hotCpuConfig({
      startDelayMs: 0, intervalMs: 1_000, consecutiveSamples: 2, profileDurationMs: 500, cooldownMs: 10_000, maxProfiles: 2,
    });
    const profiler = track(new HotCpuProfiler({
      config, session, inspector, readCpu: cpu.read, now: Date.now, monotonicNow: Date.now, log,
      onSampleCaptured: samples.onSampleCaptured,
    }));
    await profiler.start();
    const step = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    await step(0); // baseline
    cpu.state.threadPercent = 90;
    await step(1_000); // one hot sample: not yet
    expect(session.writtenCount("cpuprofile")).toBe(0);
    await step(1_000); // second: trigger
    await step(500); // post-trigger duration
    await vi.waitUntil(() => session.writtenCount("cpuprofile") === 1);
    // Still hot, but inside the cooldown.
    await step(5_000);
    expect(session.writtenCount("cpuprofile")).toBe(1);
    await step(6_000);
    await vi.waitUntil(() => session.writtenCount("cpuprofile") === 2);
    expect(profiler.status().state).toBe("capped");
    const startsAtCap = calls("Profiler.start");
    const samplesAtCap = samples.count();
    await step(60_000);
    // Capped: no recorder, no sampling timer.
    expect(calls("Profiler.start")).toBe(startsAtCap);
    expect(samples.count()).toBe(samplesAtCap);
    expect(inspector.isAttached()).toBe(false);
    expect(log).toHaveBeenCalledWith("hot-cpu", expect.stringContaining("2 profiles captured this launch"));
    expect((await FS.readdir(session.directoryPath)).sort()).toEqual([
      "events.ndjson", "main-hot-0001.cpuprofile", "main-hot-0002.cpuprofile", "samples.ndjson", "session.json",
    ]);
  });

  it("triggers on the main thread's CPU only, not on busy workers", async () => {
    const dir = await tempDir();
    cleanups.push(dir.cleanup);
    const session = makeSession(dir.path, "hot-cpu");
    vi.useFakeTimers();
    const { inspector } = fakeInspector();
    const cpu = cpuSource(Date.now);
    const samples = sampleTracker();
    const profiler = track(new HotCpuProfiler({
      config: hotCpuConfig({ startDelayMs: 0, intervalMs: 1_000, profileDurationMs: 500 }),
      session, inspector, readCpu: cpu.read, now: Date.now, monotonicNow: Date.now,
      onSampleCaptured: samples.onSampleCaptured,
    }));
    await profiler.start();
    await vi.advanceTimersByTimeAsync(0);
    // A scan worker pegs a core; the main thread idles.
    cpu.state.processPercent = 180;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(samples.count()).toBe(11);
    expect(session.writtenCount("cpuprofile")).toBe(0);
    expect(profiler.status().lastCpuPercent).toBe(0);

    cpu.state.threadPercent = 95;
    await vi.advanceTimersByTimeAsync(2_500);
    await vi.waitUntil(() => session.writtenCount("cpuprofile") === 1);
    const lines = (await FS.readFile(session.artifactPath("samples.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.some((sample) => sample.processCpuPercent === 180 && sample.cpuPercent === 0)).toBe(true);
    expect(lines.at(-1)).toMatchObject({ cpuPercent: 95, consecutiveHotSamples: 2 });
  });

  it("pauses sampling while a capture records and writes samples and events only beside it", async () => {
    const dir = await tempDir();
    cleanups.push(dir.cleanup);
    const session = makeSession(dir.path, "hot-cpu");
    vi.useFakeTimers();
    const { inspector } = fakeInspector();
    const cpu = cpuSource(Date.now);
    const samples = sampleTracker();
    const written = deferred();
    const profiler = track(new HotCpuProfiler({
      config: hotCpuConfig({ startDelayMs: 0, intervalMs: 1_000, profileDurationMs: 15_000 }),
      session, inspector, readCpu: cpu.read, now: Date.now, monotonicNow: Date.now,
      onSampleCaptured: samples.onSampleCaptured,
      onProfileWritten: () => written.resolve(),
    }));
    await profiler.start();
    await vi.advanceTimersByTimeAsync(0);
    cpu.state.threadPercent = 70;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(profiler.status().state).toBe("profiling");
    const atTrigger = samples.count();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(samples.count()).toBe(atTrigger);
    await vi.advanceTimersByTimeAsync(1_000);
    await written.promise;
    const events = (await FS.readFile(session.artifactPath("events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line).type);
    expect(events).toEqual(["monitor-started", "profile-started", "profile-written"]);
    const sampleLines = (await FS.readFile(session.artifactPath("samples.ndjson"), "utf8")).trim().split("\n");
    expect(sampleLines).toHaveLength(atTrigger);
    // Sampling resumes, from a fresh baseline.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(samples.count()).toBeGreaterThan(atTrigger);
    expect(profiler.status().state).toBe("recording");
  });

  it("does not read a deliberate main-thread pause as hot", async () => {
    const dir = await tempDir();
    cleanups.push(dir.cleanup);
    const session = makeSession(dir.path, "hot-cpu");
    vi.useFakeTimers();
    const { inspector } = fakeInspector();
    let micros = 0;
    const samples = sampleTracker();
    const profiler = track(new HotCpuProfiler({
      config: hotCpuConfig({ startDelayMs: 0, intervalMs: 1_000, consecutiveSamples: 1 }),
      session, inspector,
      readCpu: () => ({ threadMicros: micros, processMicros: micros }),
      now: Date.now, monotonicNow: Date.now,
      onSampleCaptured: samples.onSampleCaptured,
    }));
    await profiler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    // A heap snapshot holds the main thread for 800 ms of CPU.
    micros += 800_000;
    profiler.discountBlockedInterval();
    await vi.advanceTimersByTimeAsync(500);
    expect(samples.count()).toBe(2);
    expect(profiler.status().lastCpuPercent).toBe(0);
    expect(profiler.status().state).toBe("recording");
  });
});
