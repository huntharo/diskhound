import * as FS from "node:fs";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import type { HeapGateConfig } from "../diagnosticsConfig";
import { HeapMonitor } from "../heapMonitor";
import {
  crashLogLike,
  fakeInspector,
  heapConfig,
  heapReading,
  realisticHeapProfile,
  session as makeSession,
  tempDir,
} from "./diagnosticsTestKit";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));

/** 720 samples at the 5 s interval. */
const HOUR_OF_TICKS = 720;
/**
 * v8.writeHeapSnapshot writes from C++, outside node:fs, so the harness
 * can't see it. The stand-in writes through node:fs so each snapshot
 * counts as the one file it is, with a 1 MB body in place of the real
 * 1.5–2.3x the heap (up to ~1.2 GB at the 512 MB snapshot ceiling).
 */
const SNAPSHOT_STAND_IN_BYTES = 1024 * 1024;

const cleanups: Array<() => Promise<void>> = [];
const monitors: HeapMonitor[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const monitor of monitors.splice(0)) monitor.stop();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function launch(config: Partial<HeapGateConfig> = {}, root?: string, startAt = new Date(2026, 8, 25, 12, 0).getTime()) {
  let dir = root;
  if (!dir) {
    const created = await tempDir("diskhound-heap-io-");
    cleanups.push(created.cleanup);
    dir = created.path;
  }
  const heap = { usedMb: 400 };
  const clock = { wall: startAt };
  const { inspector } = fakeInspector({ samplingProfile: () => realisticHeapProfile() });
  const session = makeSession(dir, "heap", new Date(startAt));
  const crash = crashLogLike(dir);
  const monitor = new HeapMonitor({
    config: heapConfig(config),
    session,
    statePath: Path.join(dir, "heap-gate-state.json"),
    appVersion: "0.6.2",
    inspector,
    readHeap: (at) => heapReading(heap.usedMb, at),
    readWorkerHeaps: async () => [{ label: "scan", threadId: 1, usedBytes: 60 * 1024 * 1024, limitBytes: 4096 * 1024 * 1024 }],
    liveWorkerCount: () => 1,
    writeHeapSnapshot: (filePath) => {
      FS.writeFileSync(filePath, Buffer.alloc(SNAPSHOT_STAND_IN_BYTES));
      return filePath;
    },
    observeMajorGc: () => () => {},
    now: () => clock.wall,
    log: crash,
  });
  monitors.push(monitor);
  const run = async (usedMb: number, ticks = 1) => {
    for (let index = 0; index < ticks; index += 1) {
      heap.usedMb = usedMb;
      clock.wall += 5_000;
      await monitor.tick();
      await monitor.whenIdle();
    }
  };
  /**
   * Setup's crash.log lines go out first; the work's lines get the flush
   * the 2 s timer would give them.
   */
  const measure = <T>(work: () => Promise<T>) => {
    crash.flush();
    return measureFsIo(async () => {
      const result = await work();
      crash.flush();
      return result;
    });
  };
  return { dir, heap, clock, session, monitor, run, crash, measure };
}

describe("heap monitor disk writes", () => {
  it("writes nothing in an hour with the gate off, the default", async () => {
    const { run, measure } = await launch({ enabled: false });
    const { io } = await measure(() => run(400, HOUR_OF_TICKS));
    expectIoBudget({
      scenario: "heap-monitor-idle-hour",
      note: "gate off (the default), 720 samples at 5 s: 0 writes; readings stay in a 120-entry ring in memory",
      io,
    });
  });

  it("writes nothing in an hour of sampling below the gate", async () => {
    const { run, measure } = await launch();
    const { io } = await measure(() => run(1000, HOUR_OF_TICKS));
    expectIoBudget({
      scenario: "heap-gate-watching-hour",
      note: "gate on, sampling, heap under the 1.2 GB gate for an hour: 0 writes (the sampling heap profile stays in V8) and 1 read of heap-gate-state.json per launch",
      io,
    });
  });

  it("writes an allocation profile at the gate", async () => {
    const { run, measure } = await launch();
    await run(1000);
    const { io } = await measure(() => run(1250));
    expectIoBudget({
      scenario: "heap-gate-capture",
      note: "the gate fires, snapshots off: the session folder, the .heapprofile (~1.6 MB for 30k sampled allocations; 0.6 MB measured at a 470 MB heap), heap-gate-state.json, samples.ndjson, events.ndjson, session.json and a crash.log line. Off by default: 0/day. On: at most 1 per app version per day at any gate (128 MB is the most aggressive): 7 write calls, ~1.7 MB/day",
      io,
    });
  });

  it("adds two snapshot files 20 s apart when snapshots are on", async () => {
    // Snapshots stop at 512 MB, so they need a lower gate.
    const { run, monitor, measure } = await launch({ snapshots: true, gateBytes: 400 * 1024 * 1024, watchBytes: 300 * 1024 * 1024 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await run(350);
    const { io } = await measure(async () => {
      await run(420);
      await vi.advanceTimersByTimeAsync(20_000);
      await monitor.whenIdle();
    });
    expectIoBudget({
      scenario: "heap-gate-snapshot-pair",
      note: "a 400 MB gate with snapshots on: the gate capture plus snapshots A and B (1 file each, written by V8 outside node:fs; a 1 MB stand-in here), each with a session.json rewrite, events, a sync crash.log line before V8 blocks and a buffered one after. Measured on Electron 40.6, a snapshot is 1.5-2.3x the heap and blocks main 17-50 ms/MB: up to ~0.9 GB and ~20 s each at 400 MB, up to ~2.4 GB per pair at the 512 MB ceiling. At most 1 pair per app version per day; the 6 GB retention cap keeps two. Off by default, opt-in behind that warning",
      io,
    });
  });

  it("writes nothing for the rest of the day once the gate has fired", async () => {
    const { run, measure } = await launch();
    await run(1000);
    await run(1250);
    const { io } = await measure(() => run(1400, HOUR_OF_TICKS));
    expectIoBudget({
      scenario: "heap-gate-capped-hour",
      note: "an hour above the gate after today's capture, same launch: 0 writes",
      io,
    });
  });

  it("writes one crash.log line when a later launch passes the gate on a capped day", async () => {
    const first = await launch();
    await first.run(1000);
    await first.run(1250);
    first.monitor.stop();
    first.crash.flush();
    const later = await launch({}, first.dir, new Date(2026, 8, 25, 20, 0).getTime());
    const { io } = await later.measure(() => later.run(1400, HOUR_OF_TICKS));
    expectIoBudget({
      scenario: "heap-gate-capped-next-launch-hour",
      note: "a second launch the same day, an hour above the gate: 1 read of heap-gate-state.json and 1 crash.log line saying today's capture is done",
      io,
    });
  });

  it("writes one crash.log line near the heap limit with the gate off", async () => {
    const { run, measure } = await launch({ enabled: false });
    await run(2500);
    const { io } = await measure(() => run(3500, 60));
    expectIoBudget({
      scenario: "heap-near-limit-gate-off",
      note: "the one write with everything off: 1 sync crash.log append when main + workers pass 85% of the heap limit, then none until they fall below 68%; 5 min at the limit here",
      io,
    });
  });

  it("saves the running allocation profile synchronously near the limit", async () => {
    const { run, measure } = await launch();
    await run(1000);
    await run(1250);
    await run(2500);
    const { io } = await measure(() => run(3500));
    expectIoBudget({
      scenario: "heap-near-limit-sampling",
      note: "gate on and sampling, main + workers pass 85% of the limit: the breadcrumb, a sync .heapprofile (~1.6 MB), samples, events and session.json; once per approach to the limit",
      io,
    });
  });

  it("writes one snapshot file when the user takes one", async () => {
    const { run, monitor, measure } = await launch({ enabled: false });
    await run(400);
    const { io, result } = await measure(() => monitor.captureManualSnapshot());
    expect(result.ok).toBe(true);
    expectIoBudget({
      scenario: "heap-manual-snapshot",
      note: "Settings > Take heap snapshot, per click: the session folder, 1 snapshot file (V8 writes it; a 1 MB stand-in here, 1.5-2.3x the heap for real, refused above 512 MB), events, session.json, a sync crash.log line before V8 blocks and a buffered one after",
      io,
    });
  });
});
