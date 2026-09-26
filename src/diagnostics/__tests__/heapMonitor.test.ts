import * as FS from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkerHeapReading } from "../../shared/workerHeapRegistry";
import { HEAP_DEFAULTS, type HeapGateConfig } from "../diagnosticsConfig";
import { checkSnapshotHeadroom, HeapMonitor } from "../heapMonitor";
import {
  fakeInspector,
  heapConfig,
  heapReading,
  MB,
  realisticHeapProfile,
  session as makeSession,
  tempDir,
} from "./diagnosticsTestKit";

const cleanups: Array<() => Promise<void>> = [];
const monitors: HeapMonitor[] = [];

/** Snapshots need a gate under the 512 MB ceiling. */
const SNAPSHOT_GATE: Partial<HeapGateConfig> = { snapshots: true, gateBytes: 400 * MB, watchBytes: 300 * MB };

afterEach(async () => {
  vi.useRealTimers();
  for (const monitor of monitors.splice(0)) monitor.stop();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture(options: {
  config?: Partial<HeapGateConfig>;
  root?: string;
  appVersion?: string;
  startAt?: number;
} = {}) {
  let root = options.root;
  if (!root) {
    const dir = await tempDir();
    cleanups.push(dir.cleanup);
    root = dir.path;
  }
  const heap = { usedMb: 100, workers: [] as WorkerHeapReading[] };
  const clock = { wall: options.startAt ?? new Date(2026, 8, 25, 12, 0).getTime(), mono: 0 };
  const { inspector, calls } = fakeInspector({ samplingProfile: () => realisticHeapProfile(200) });
  const snapshots: string[] = [];
  const writeHeapSnapshot = vi.fn((filePath: string) => {
    writeFileSync(filePath, `{"snapshot":{"meta":{}},"used":${heap.usedMb}}`);
    snapshots.push(Path.basename(filePath));
    clock.mono += 6_200; // the main thread is blocked while V8 writes
    return filePath;
  });
  const gcHooks = { on: 0, off: 0, fire: null as (() => void) | null };
  const log = vi.fn();
  const afterBlockingCapture = vi.fn();
  // Each launch gets its own session directory.
  const session = makeSession(root, "heap", new Date(clock.wall));
  const monitor = new HeapMonitor({
    config: heapConfig(options.config),
    session,
    statePath: Path.join(root, "heap-gate-state.json"),
    appVersion: options.appVersion ?? "0.6.2",
    inspector,
    readHeap: (at) => heapReading(heap.usedMb, at),
    readWorkerHeaps: async () => heap.workers,
    liveWorkerCount: () => heap.workers.length,
    writeHeapSnapshot,
    observeMajorGc: (onMajorGc) => {
      gcHooks.on += 1;
      gcHooks.fire = onMajorGc;
      return () => {
        gcHooks.off += 1;
        gcHooks.fire = null;
      };
    },
    now: () => clock.wall,
    monotonicNow: () => clock.mono,
    log,
    afterBlockingCapture,
  });
  monitors.push(monitor);
  /** One tick per `usedMb`, then waits for the capture it started. */
  const run = async (...usedMbs: number[]) => {
    for (const usedMb of usedMbs) {
      heap.usedMb = usedMb;
      clock.wall += 5_000;
      await monitor.tick();
      await monitor.whenIdle();
    }
  };
  const logged = (tag: string) => log.mock.calls.filter(([name]) => name === tag).map(([, message]) => message as string);
  return { root, heap, clock, inspector, calls, snapshots, writeHeapSnapshot, gcHooks, log, logged, afterBlockingCapture, session, monitor, run };
}

describe("checkSnapshotHeadroom", () => {
  const worker = (usedMb: number | null, label = "folder-tree"): WorkerHeapReading =>
    ({ label, threadId: 7, usedBytes: usedMb === null ? null : usedMb * MB, limitBytes: 4096 * MB });

  it("refuses above the snapshot ceiling, whatever the headroom", () => {
    const result = checkSnapshotHeadroom(heapReading(600), [], 0.9, 512 * MB);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("main heap 600 MB is over the 512 MB snapshot ceiling (Electron 40 crashed writing one at ~600 MB)");
    expect(checkSnapshotHeadroom(heapReading(500), [], 0.9, 512 * MB).ok).toBe(true);
  });

  it("needs main × 2 under 90% of the 4 GB limit with no workers", () => {
    expect(checkSnapshotHeadroom(heapReading(1200), [], 0.9).ok).toBe(true);
    // 0.9 × 4,096 MB = 3,686.4 MB
    expect(checkSnapshotHeadroom(heapReading(1844), [], 0.9).ok).toBe(false);
    expect(checkSnapshotHeadroom(heapReading(1843), [], 0.9).ok).toBe(true);
  });

  it("counts worker heaps, which share the cage", () => {
    const result = checkSnapshotHeadroom(heapReading(1200), [worker(1300)], 0.9);
    expect(result).toMatchObject({ ok: false, cageUsedBytes: 2500 * MB, neededBytes: 3700 * MB });
    expect(result.reason).toBe(
      "main 1,200 MB + 1 worker 1,300 MB + ~1,200 MB for the snapshot would exceed 90% of the 4,096 MB heap limit",
    );
  });

  it("fails when a worker's heap is unknown", () => {
    const result = checkSnapshotHeadroom(heapReading(300), [worker(null, "dev-artifacts")], 0.9);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("worker dev-artifacts did not report its heap");
  });
});

describe("HeapMonitor", () => {
  it("stays quiet below the watch mark: no profiler, no files", async () => {
    const f = await fixture();
    await f.run(...Array.from({ length: 50 }, () => 500));
    expect(f.inspector.attach).not.toHaveBeenCalled();
    expect(existsSync(f.session.directoryPath)).toBe(false);
    expect(f.monitor.status()).toMatchObject({ state: "watching", usedBytes: 500 * MB, gatesToday: 0 });
    expect(f.log).not.toHaveBeenCalled();
  });

  it("runs the sampling heap profiler from the watch mark until the heap falls well below it", async () => {
    const f = await fixture();
    await f.run(950); // watch is 900 MB
    expect(f.calls("HeapProfiler.startSampling")).toBe(1);
    expect(f.monitor.status().state).toBe("sampling");
    await f.run(800, 750); // above 80% of watch: keep going
    expect(f.calls("HeapProfiler.stopSampling")).toBe(0);
    await f.run(700);
    expect(f.calls("HeapProfiler.stopSampling")).toBe(1);
    expect(f.inspector.isAttached()).toBe(false);
    expect(existsSync(f.session.directoryPath)).toBe(false);
  });

  it("saves the allocation profile at the gate and counts the day, with no snapshot when they're off", async () => {
    const f = await fixture();
    await f.run(950, 1100, 1250);
    expect(f.writeHeapSnapshot).not.toHaveBeenCalled();
    const files = (await FS.readdir(f.session.directoryPath)).sort();
    expect(files).toEqual(["events.ndjson", "main-gate-0001.heapprofile", "samples.ndjson", "session.json"]);
    const profile = JSON.parse(await FS.readFile(f.session.artifactPath("main-gate-0001.heapprofile"), "utf8"));
    expect(profile.samples).toHaveLength(200);
    const manifest = JSON.parse(await FS.readFile(f.session.artifactPath("session.json"), "utf8"));
    expect(manifest.artifacts).toEqual([expect.objectContaining({
      filename: "main-gate-0001.heapprofile",
      kind: "heapprofile",
      summary: "live allocations at 1,250 MB, sampled for 10 s from 950 MB",
    })]);
    const samples = (await FS.readFile(f.session.artifactPath("samples.ndjson"), "utf8")).trim().split("\n");
    expect(samples).toHaveLength(3);
    const events = (await FS.readFile(f.session.artifactPath("events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line).type);
    expect(events).toEqual(["sampling-started", "gate-triggered"]);
    expect(JSON.parse(await FS.readFile(Path.join(f.root, "heap-gate-state.json"), "utf8"))).toMatchObject({
      appVersion: "0.6.2", day: "2026-09-25", count: 1,
    });
    expect(f.logged("heap-gate")).toEqual([
      `main heap 1,250 MB of 4,096 MB passed the 1,200 MB gate (no workers); saved ${f.session.artifactPath("main-gate-0001.heapprofile")}`,
    ]);
    // The profiler keeps sampling after the gate, for a near-limit dump.
    expect(f.monitor.status()).toMatchObject({ state: "capped", gatesToday: 1 });
    expect(f.calls("HeapProfiler.stopSampling")).toBe(0);
  });

  it("samples from the first check by default, so a spike past the gate in one check still has a profile", async () => {
    const f = await fixture({ config: { watchBytes: HEAP_DEFAULTS.watchFraction * 1200 * MB } });
    await f.run(30);
    expect(f.calls("HeapProfiler.startSampling")).toBe(1);
    await f.run(1250);
    const manifest = JSON.parse(await FS.readFile(f.session.artifactPath("session.json"), "utf8"));
    expect(manifest.artifacts).toEqual([expect.objectContaining({
      filename: "main-gate-0001.heapprofile",
      summary: "live allocations at 1,250 MB, sampled for 5 s from 30 MB",
    })]);
  });

  it("writes no empty profile when sampling starts in the gate's own check", async () => {
    const f = await fixture();
    await f.run(1250); // past the 900 MB watch mark and the gate at once
    expect(f.calls("HeapProfiler.startSampling")).toBe(1);
    expect(f.calls("HeapProfiler.getSamplingProfile")).toBe(0);
    expect(existsSync(f.session.artifactPath("main-gate-0001.heapprofile"))).toBe(false);
    expect(f.logged("heap-gate")).toEqual([
      "main heap 1,250 MB of 4,096 MB passed the 1,200 MB gate (no workers); no allocation profile: sampling started in this same check",
    ]);
  });

  it("writes snapshot A at the gate and B 20 s later, logging each pause", async () => {
    const f = await fixture({ config: SNAPSHOT_GATE });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await f.run(350, 420);
    expect(f.snapshots).toEqual(["main-gate-0001-a.heapsnapshot"]);
    expect(f.monitor.hasPendingSnapshot()).toBe(true);
    expect(f.monitor.status().state).toBe("capturing");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(f.snapshots).toHaveLength(1);
    f.heap.usedMb = 450;
    await vi.advanceTimersByTimeAsync(1);
    await f.monitor.whenIdle();
    expect(f.snapshots).toEqual(["main-gate-0001-a.heapsnapshot", "main-gate-0001-b.heapsnapshot"]);
    expect(f.afterBlockingCapture).toHaveBeenCalledTimes(2);
    const manifest = JSON.parse(await FS.readFile(f.session.artifactPath("session.json"), "utf8"));
    expect(manifest.artifacts.map((artifact: { filename: string }) => artifact.filename)).toEqual([
      "main-gate-0001.heapprofile", "main-gate-0001-a.heapsnapshot", "main-gate-0001-b.heapsnapshot",
    ]);
    expect(manifest.artifacts[2]).toMatchObject({
      summary: expect.stringMatching(/^gate snapshot B at 450 MB heap: 0 MB file, main thread paused 6\.2 s$/),
      detail: expect.objectContaining({ pauseMs: 6_200 }),
    });
    const lines = f.logged("heap-snapshot");
    const pathA = f.session.artifactPath("main-gate-0001-a.heapsnapshot");
    expect(lines).toHaveLength(4);
    // Each snapshot's first line goes to disk before V8 blocks the thread.
    expect(lines[0]).toBe(`writing ${pathA} at 420 MB heap; if DiskHound exits before the next line, the snapshot killed it`);
    const writing = f.log.mock.calls.filter(([tag, message]) => tag === "heap-snapshot" && String(message).startsWith("writing "));
    expect(writing.map(([, , options]) => options)).toEqual([{ sync: true }, { sync: true }]);
    expect(lines[1]).toMatch(new RegExp(`^saved ${pathA.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")} \\(0 MB\\); main thread paused 6200 ms; main 420 MB`));
    expect(f.monitor.status().state).toBe("capped");
  });

  it("skips snapshots above the ceiling at the default 1.2 GB gate, and says why", async () => {
    const f = await fixture({ config: { snapshots: true } });
    await f.run(950, 1250);
    expect(f.writeHeapSnapshot).not.toHaveBeenCalled();
    expect(f.monitor.hasPendingSnapshot()).toBe(false);
    expect(f.logged("heap-snapshot")).toEqual([
      "gate snapshot A skipped: main heap 1,250 MB is over the 512 MB snapshot ceiling (Electron 40 crashed writing one at ~600 MB)",
    ]);
    // The allocation profile needs no headroom.
    expect(existsSync(f.session.artifactPath("main-gate-0001.heapprofile"))).toBe(true);
    expect(f.monitor.status().lastEvent).toContain("gate snapshot A skipped");
  });

  it("skips B when the cage has filled within the 20 s", async () => {
    const f = await fixture({ config: SNAPSHOT_GATE });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await f.run(350, 420);
    f.heap.workers = [{ label: "folder-tree", threadId: 3, usedBytes: 2900 * MB, limitBytes: 4096 * MB }];
    await vi.advanceTimersByTimeAsync(20_000);
    await f.monitor.whenIdle();
    expect(f.snapshots).toEqual(["main-gate-0001-a.heapsnapshot"]);
    expect(f.logged("heap-snapshot").at(-1)).toBe(
      "gate snapshot B skipped: main 420 MB + 1 worker 2,900 MB + ~420 MB for the snapshot would exceed 90% of the 4,096 MB heap limit",
    );
  });

  it("skips B when the heap has grown past the ceiling within the 20 s", async () => {
    const f = await fixture({ config: SNAPSHOT_GATE });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await f.run(350, 420);
    f.heap.usedMb = 700;
    await vi.advanceTimersByTimeAsync(20_000);
    await f.monitor.whenIdle();
    expect(f.snapshots).toEqual(["main-gate-0001-a.heapsnapshot"]);
    expect(f.logged("heap-snapshot").at(-1)).toMatch(/^gate snapshot B skipped: main heap 700 MB is over the 512 MB snapshot ceiling/);
  });

  it("notes worker heaps at the gate and refuses a snapshot when one doesn't report", async () => {
    const f = await fixture({ config: SNAPSHOT_GATE });
    f.heap.workers = [
      { label: "scan", threadId: 1, usedBytes: 180 * MB, limitBytes: 4096 * MB },
      { label: "dev-artifacts", threadId: 2, usedBytes: null, limitBytes: null, error: "no answer in 1000 ms" },
    ];
    await f.run(350, 420);
    expect(f.logged("heap-gate")[0]).toContain("(scan 180 MB, dev-artifacts ?)");
    expect(f.logged("heap-snapshot")).toEqual([
      "gate snapshot A skipped: worker dev-artifacts did not report its heap, so the cage's free space is unknown",
    ]);
    const events = (await FS.readFile(f.session.artifactPath("events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.find((event) => event.type === "gate-triggered").detail.workers).toEqual([
      { label: "scan", threadId: 1, usedBytes: 180 * MB },
      { label: "dev-artifacts", threadId: 2, usedBytes: null, error: "no answer in 1000 ms" },
    ]);
  });

  it("allows one gate capture per app version per day, across restarts", async () => {
    const first = await fixture();
    await first.run(950, 1250);
    first.monitor.stop();

    const sameDay = await fixture({ root: first.root, startAt: new Date(2026, 8, 25, 18, 0).getTime() });
    await sameDay.run(950, 1250, 1300, 1350);
    expect(existsSync(sameDay.session.directoryPath) && (await FS.readdir(sameDay.session.directoryPath))).toBeFalsy();
    expect(sameDay.logged("heap-gate")).toEqual([
      "main heap 1,250 MB passed the 1,200 MB gate, but today's 1 capture(s) for 0.6.2 are done",
    ]);
    // Sampling still runs on a capped day, for a near-limit dump.
    expect(sameDay.calls("HeapProfiler.startSampling")).toBe(1);
    sameDay.monitor.stop();

    const nextDay = await fixture({ root: first.root, startAt: new Date(2026, 8, 26, 9, 0).getTime() });
    await nextDay.run(950, 1250);
    expect(nextDay.logged("heap-gate")[0]).toMatch(/passed the 1,200 MB gate/);
    expect(nextDay.logged("heap-gate")[0]).toContain("saved");
    nextDay.monitor.stop();

    const upgraded = await fixture({ root: first.root, appVersion: "0.6.3", startAt: new Date(2026, 8, 26, 10, 0).getTime() });
    await upgraded.run(950, 1250);
    expect(upgraded.logged("heap-gate")[0]).toContain("saved");
  });

  it("re-arms only after the heap falls well below the gate, and honors the cooldown", async () => {
    const f = await fixture({ config: { maxGatesPerDay: 5, cooldownMs: 60_000 } });
    await f.run(950, 1250, 1300, 1350);
    expect(f.session.writtenCount("heapprofile")).toBe(1);
    await f.run(900, 1250); // re-armed, but 20 s after the first: inside the cooldown
    expect(f.session.writtenCount("heapprofile")).toBe(1);
    await f.run(...Array.from({ length: 7 }, () => 1250));
    expect(f.session.writtenCount("heapprofile")).toBe(1);
    await f.run(1250); // 60 s after the first
    expect(f.session.writtenCount("heapprofile")).toBe(2);
    expect(await FS.readdir(f.session.directoryPath)).toContain("main-gate-0002.heapprofile");
  });

  it("leaves one near-limit breadcrumb, saves the running sampling profile, and re-arms after recovery", async () => {
    const f = await fixture();
    await f.run(950, 1250, 2500, 3500);
    expect(f.logged("heap-near-limit")).toEqual([
      "main 3,500 MB = 85% of the 4,096 MB heap limit. If DiskHound exits now, V8 ran out of heap; its abort skips every crash handler.",
      `saved ${f.session.artifactPath("main-near-limit-0001.heapprofile")}`,
    ]);
    await f.run(3600, 3500);
    expect(f.logged("heap-near-limit")).toHaveLength(2);
    // Both on disk before tick returns: V8's OOM abort skips every flush.
    expect(f.log.mock.calls.filter(([tag]) => tag === "heap-near-limit").map(([, , options]) => options))
      .toEqual([{ sync: true }, { sync: true }]);
    await f.run(2700, 3500);
    expect(f.logged("heap-near-limit")).toHaveLength(4);
    expect(f.session.writtenCount("heapprofile")).toBe(3);
  });

  it("leaves the breadcrumb even with the gate off, counting worker heaps, and writes nothing else", async () => {
    const f = await fixture({ config: { enabled: false } });
    f.heap.workers = [{ label: "folder-tree", threadId: 4, usedBytes: 1700 * MB, limitBytes: 4096 * MB }];
    await f.run(1900); // worker heaps arrive with this tick's refresh
    await f.run(1900);
    expect(f.logged("heap-near-limit")).toEqual([
      "main 1,900 MB + workers (folder-tree 1,700 MB) = 88% of the 4,096 MB heap limit. If DiskHound exits now, V8 ran out of heap; its abort skips every crash handler.",
    ]);
    expect(f.inspector.attach).not.toHaveBeenCalled();
    expect(existsSync(f.session.directoryPath)).toBe(false);
    expect(f.monitor.status().state).toBe("off");
  });

  it("hooks major GCs for the near-limit check only while the cage is past 60% full", async () => {
    const f = await fixture({ config: { enabled: false } });
    await f.run(2000);
    expect(f.gcHooks.on).toBe(0);
    await f.run(2500);
    expect(f.gcHooks.on).toBe(1);
    // Between ticks, a major GC finds the heap at the limit.
    f.heap.usedMb = 3600;
    f.gcHooks.fire!();
    expect(f.logged("heap-near-limit")).toHaveLength(1);
    await f.run(2200);
    expect(f.gcHooks.off).toBe(0);
    await f.run(2000);
    expect(f.gcHooks.off).toBe(1);
  });

  it("takes a manual snapshot on request, unless the heap lacks headroom", async () => {
    const f = await fixture({ config: { enabled: false } });
    await f.run(400);
    const taken = await f.monitor.captureManualSnapshot();
    expect(taken).toMatchObject({ ok: true, path: f.session.artifactPath("main-manual-0001.heapsnapshot") });
    f.heap.usedMb = 600;
    const refused = await f.monitor.captureManualSnapshot();
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/^manual snapshot skipped: main heap 600 MB is over the 512 MB snapshot ceiling/);
    expect(f.snapshots).toEqual(["main-manual-0001.heapsnapshot"]);
  });

  it("describes the cage for the [memory] crash.log line", async () => {
    const f = await fixture();
    f.heap.workers = [{ label: "scan", threadId: 1, usedBytes: 120 * MB, limitBytes: 4096 * MB }];
    await f.run(600, 600);
    expect(f.monitor.describe()).toBe("cage: main 600 MB + 1 worker 120 MB of 4,096 MB, heap gate 1,200 MB watching");
    f.monitor.reconfigure(heapConfig({ enabled: false }));
    expect(f.monitor.describe()).toBe("cage: main 600 MB + 1 worker 120 MB of 4,096 MB");
  });
});
