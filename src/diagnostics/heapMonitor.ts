import * as FS from "node:fs/promises";
import * as FS_SYNC from "node:fs";
import { constants as perfConstants, PerformanceObserver } from "node:perf_hooks";
import { getHeapStatistics, writeHeapSnapshot } from "node:v8";

import type { WorkerHeapReading } from "../shared/workerHeapRegistry";
import type { HeapGateConfig } from "./diagnosticsConfig";
import type { DiagnosticsArtifactRecord, DiagnosticsSession } from "./diagnosticsSession";
import type { InspectorTarget } from "./mainInspector";

const MB = 1024 * 1024;
/** V8's default: one sample per 32 KB allocated. */
const SAMPLING_INTERVAL_BYTES = 32 * 1024;
/** 10 minutes of 5 s samples, written next to a capture. */
const SAMPLE_RING_SIZE = 120;
const WORKER_READ_TIMEOUT_MS = 1_000;
/** Watch a major-GC hook for the near-limit check above this cage fill. */
const GC_HOOK_ON_FRACTION = 0.6;
const GC_HOOK_OFF_FRACTION = 0.5;
/** Re-arm the gate, sampling and near-limit once the heap falls this far below. */
const REARM_FRACTION = 0.8;

export interface HeapReading {
  capturedAtMs: number;
  usedBytes: number;
  totalBytes: number;
  limitBytes: number;
  rssBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  mallocedBytes: number;
}

export function readMainHeap(capturedAtMs = Date.now()): HeapReading {
  const heap = getHeapStatistics();
  const memory = process.memoryUsage();
  return {
    capturedAtMs,
    usedBytes: heap.used_heap_size,
    totalBytes: heap.total_heap_size,
    limitBytes: heap.heap_size_limit,
    rssBytes: memory.rss,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    mallocedBytes: heap.malloced_memory,
  };
}

export interface SnapshotHeadroom {
  ok: boolean;
  reason: string;
  cageUsedBytes: number;
  neededBytes: number;
  budgetBytes: number;
}

const mb = (bytes: number) => `${Math.round(bytes / MB).toLocaleString("en-US")} MB`;

function describeWorkers(count: number, bytes: number): string {
  return count === 0 ? "no workers" : `${count} worker${count === 1 ? "" : "s"} ${mb(bytes)}`;
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/**
 * Can main take a heap snapshot without taking the app down?
 *
 * Two limits, both of which end the process with no log line:
 *
 * - `maxMainBytes`: V8's snapshot generator itself crashed Electron 40
 *   at ~600 MB of a folder-tree-shaped heap (see HEAP_DEFAULTS), so no
 *   snapshot above 512 MB by default.
 * - The cage: a snapshot needs about the main heap's size again, from
 *   the same pointer-compression cage the workers use. So main +
 *   workers + main again must stay under `fraction` of the limit. A
 *   worker that never reported counts as unknown, which fails.
 */
export function checkSnapshotHeadroom(
  main: HeapReading,
  workers: readonly WorkerHeapReading[],
  fraction: number,
  maxMainBytes = Number.POSITIVE_INFINITY,
): SnapshotHeadroom {
  const workerBytes = workers.reduce((sum, worker) => sum + (worker.usedBytes ?? 0), 0);
  const cageUsedBytes = main.usedBytes + workerBytes;
  const neededBytes = cageUsedBytes + main.usedBytes;
  const budgetBytes = main.limitBytes * fraction;
  const base = { cageUsedBytes, neededBytes, budgetBytes };
  if (main.usedBytes > maxMainBytes) {
    return {
      ...base,
      ok: false,
      reason: `main heap ${mb(main.usedBytes)} is over the ${mb(maxMainBytes)} snapshot ceiling (Electron 40 crashed writing one at ~600 MB)`,
    };
  }
  const silent = workers.filter((worker) => worker.usedBytes === null);
  if (silent.length > 0) {
    return {
      ...base,
      ok: false,
      reason: `worker ${silent.map((worker) => worker.label).join(", ")} did not report its heap, so the cage's free space is unknown`,
    };
  }
  const sum = `main ${mb(main.usedBytes)} + ${describeWorkers(workers.length, workerBytes)} + ~${mb(main.usedBytes)} for the snapshot`;
  const limit = `${Math.round(fraction * 100)}% of the ${mb(main.limitBytes)} heap limit`;
  return neededBytes < budgetBytes
    ? { ...base, ok: true, reason: `${sum} fits under ${limit}` }
    : { ...base, ok: false, reason: `${sum} would exceed ${limit}` };
}

/** Gate captures so far today, per app version (`heap-gate-state.json`). */
interface GateDayState {
  appVersion: string;
  day: string;
  count: number;
  lastGateAt: string | null;
}

export type HeapMonitorState = "off" | "watching" | "sampling" | "capturing" | "capped";

export interface HeapMonitorStatus {
  enabled: boolean;
  snapshots: boolean;
  state: HeapMonitorState;
  usedBytes: number;
  limitBytes: number;
  gateBytes: number;
  watchBytes: number;
  workers: Array<{ label: string; usedBytes: number | null }>;
  gatesToday: number;
  maxGatesPerDay: number;
  lastEvent: string | null;
}

export interface HeapCapture {
  path: string;
  kind: DiagnosticsArtifactRecord["kind"];
  bytes: number;
  summary: string;
}

type Timer = ReturnType<typeof setTimeout>;

function localDay(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function observeMajorGc(onMajorGc: () => void): () => void {
  const observer = new PerformanceObserver((list) => {
    const major = list.getEntries().some(
      (entry) => (entry as { detail?: { kind?: number } }).detail?.kind === perfConstants.NODE_PERFORMANCE_GC_MAJOR,
    );
    if (major) onMajorGc();
  });
  observer.observe({ entryTypes: ["gc"] });
  return () => observer.disconnect();
}

/**
 * Main-process heap watcher.
 *
 * Every `intervalMs` (5 s) it reads the heap into an in-memory ring;
 * nothing is written per tick. With the gate enabled:
 *
 * 1. From `watchBytes` (0 by default, so from the first check) V8's
 *    sampling heap profiler runs, so the profile saved later shows
 *    which code allocated what the heap holds.
 * 2. At `gateBytes` (1.2 GB) it saves that profile as a .heapprofile,
 *    then, with snapshots on, writes snapshot A if checkSnapshotHeadroom
 *    allows it and snapshot B `snapshotGapMs` (20 s) later if it still
 *    does, for a DevTools comparison. At most `maxGatesPerDay` per app
 *    version. Snapshots stop at 512 MB, so they need a lower gate.
 *
 * Whether or not the gate is on, a main + workers heap past
 * `nearLimitFraction` of the limit writes one crash.log breadcrumb,
 * and a running sampling profile is saved synchronously next to it:
 * V8's out-of-memory abort skips every JS handler, so this is the last
 * chance to record anything. Heap snapshots near the limit are never
 * attempted (Node's --heapsnapshot-near-heap-limit would need room the
 * shared cage doesn't have).
 */
export class HeapMonitor {
  private config: HeapGateConfig;
  private readonly session: DiagnosticsSession;
  private readonly statePath: string;
  private readonly appVersion: string;
  private readonly inspector: InspectorTarget | null;
  private readonly readHeap: (capturedAtMs: number) => HeapReading;
  private readonly readWorkerHeaps: (timeoutMs: number) => Promise<WorkerHeapReading[]>;
  private readonly liveWorkerCount: () => number;
  private readonly writeHeapSnapshot: (filePath: string) => string;
  private readonly observeMajorGc: (onMajorGc: () => void) => () => void;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly log: (tag: string, message: string) => void;
  private readonly onCapture?: (capture: HeapCapture) => void | Promise<void>;
  private readonly afterBlockingCapture?: () => void;

  private tickTimer: Timer | null = null;
  private snapshotBTimer: Timer | null = null;
  private stopGcHook: (() => void) | null = null;
  private stopped = false;
  private started = false;
  private lastReading: HeapReading | null = null;
  private readonly samples: HeapReading[] = [];
  private flushedThroughMs = Number.NEGATIVE_INFINITY;
  private workerRefresh: Promise<void> | null = null;
  private workers = new Map<number, WorkerHeapReading>();
  private sampling = false;
  private samplingSince: { atMs: number; usedBytes: number } | null = null;
  private samplingFailed = false;
  private gateFired = false;
  private cappedNoted = false;
  private nearLimitLogged = false;
  private busy: Promise<unknown> | null = null;
  private dayState: GateDayState | null = null;
  private lastEvent: string | null = null;

  constructor(options: {
    config: HeapGateConfig;
    session: DiagnosticsSession;
    /** `<userData>/diagnostics/heap-gate-state.json` */
    statePath: string;
    appVersion: string;
    inspector?: InspectorTarget | null;
    readHeap?: (capturedAtMs: number) => HeapReading;
    readWorkerHeaps?: (timeoutMs: number) => Promise<WorkerHeapReading[]>;
    liveWorkerCount?: () => number;
    /** v8.writeHeapSnapshot, which writes from C++ and blocks main throughout. */
    writeHeapSnapshot?: (filePath: string) => string;
    observeMajorGc?: (onMajorGc: () => void) => () => void;
    now?: () => number;
    monotonicNow?: () => number;
    log?: (tag: string, message: string) => void;
    onCapture?: (capture: HeapCapture) => void | Promise<void>;
    /** Right after a snapshot, so the CPU profiler doesn't count that pause as hot. */
    afterBlockingCapture?: () => void;
  }) {
    this.config = options.config;
    this.session = options.session;
    this.statePath = options.statePath;
    this.appVersion = options.appVersion;
    this.inspector = options.inspector ?? null;
    this.readHeap = options.readHeap ?? readMainHeap;
    this.readWorkerHeaps = options.readWorkerHeaps ?? (async () => []);
    this.liveWorkerCount = options.liveWorkerCount ?? (() => 0);
    this.writeHeapSnapshot = options.writeHeapSnapshot ?? writeHeapSnapshot;
    this.observeMajorGc = options.observeMajorGc ?? observeMajorGc;
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.log = options.log ?? (() => {});
    this.onCapture = options.onCapture;
    this.afterBlockingCapture = options.afterBlockingCapture;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    // The first check runs now, so sampling covers startup too.
    void this.tick()
      .catch((error: unknown) => this.note("heap-gate", `sample failed: ${serializeError(error)}`))
      .finally(() => this.scheduleTick());
  }

  stop(): void {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.snapshotBTimer) clearTimeout(this.snapshotBTimer);
    this.tickTimer = null;
    this.snapshotBTimer = null;
    this.stopSampling("stopped");
    this.stopGcHook?.();
    this.stopGcHook = null;
    this.session.flushEventsSync();
  }

  reconfigure(config: HeapGateConfig): void {
    this.config = config;
    if (!config.enabled) this.stopSampling("disabled");
    this.samplingFailed = false;
  }

  /** Resolves once the running capture has finished. Snapshot B waits on its own timer. */
  async whenIdle(): Promise<void> {
    while (this.busy) await this.busy;
  }

  /** True while snapshot B is scheduled. */
  hasPendingSnapshot(): boolean {
    return this.snapshotBTimer !== null;
  }

  /** One sample. Exposed so tests can drive the monitor without timers. */
  async tick(): Promise<void> {
    const reading = this.readHeap(this.now());
    this.lastReading = reading;
    this.samples.push(reading);
    if (this.samples.length > SAMPLE_RING_SIZE) this.samples.shift();
    this.refreshWorkers();
    this.checkNearLimit(reading);
    this.updateGcHook(reading);
    if (!this.config.enabled) return;

    await this.loadDayState();
    const { usedBytes } = reading;
    if (this.gateFired && usedBytes < this.config.gateBytes * REARM_FRACTION) this.gateFired = false;
    // Sampling continues on a capped day too, for the near-limit dump.
    if (usedBytes >= this.config.watchBytes) {
      this.startSampling(reading);
    } else if (this.sampling && !this.busy && usedBytes < this.config.watchBytes * REARM_FRACTION) {
      this.stopSampling("below-watch");
    }
    if (usedBytes >= this.config.gateBytes && !this.gateFired && !this.busy) this.fireGate(reading);
  }

  status(): HeapMonitorStatus {
    const reading = this.lastReading ?? this.readHeap(this.now());
    return {
      enabled: this.config.enabled,
      snapshots: this.config.snapshots,
      state: this.state(),
      usedBytes: reading.usedBytes,
      limitBytes: reading.limitBytes,
      gateBytes: this.config.gateBytes,
      watchBytes: this.config.watchBytes,
      workers: [...this.workers.values()].map((worker) => ({ label: worker.label, usedBytes: worker.usedBytes })),
      gatesToday: this.gatesToday(),
      maxGatesPerDay: this.config.maxGatesPerDay,
      lastEvent: this.lastEvent,
    };
  }

  /** A fragment for main.ts's periodic `[memory]` crash.log line. */
  describe(): string {
    const reading = this.lastReading;
    if (!reading) return "cage: not sampled yet";
    const workers = [...this.workers.values()];
    const workerBytes = workers.reduce((sum, worker) => sum + (worker.usedBytes ?? 0), 0);
    const cage = `cage: main ${mb(reading.usedBytes)} + ${describeWorkers(workers.length, workerBytes)} of ${mb(reading.limitBytes)}`;
    return this.config.enabled ? `${cage}, heap gate ${mb(this.config.gateBytes)} ${this.state()}` : cage;
  }

  /** Settings → "Take heap snapshot". Not capped: the user asked for it. */
  async captureManualSnapshot(): Promise<{ ok: boolean; message: string; path?: string }> {
    if (this.busy) return { ok: false, message: "A heap capture is already running. Try again in a moment." };
    const index = this.session.allocateIndex("main-manual");
    const work = this.takeSnapshot(`main-manual-${String(index).padStart(4, "0")}`, "manual snapshot");
    this.busy = work;
    try {
      const outcome = await work;
      return outcome.path
        ? { ok: true, message: outcome.message, path: outcome.path }
        : { ok: false, message: outcome.message };
    } finally {
      if (this.busy === work) this.busy = null;
    }
  }

  private state(): HeapMonitorState {
    if (!this.config.enabled) return "off";
    if (this.busy || this.snapshotBTimer) return "capturing";
    if (this.isCapped()) return "capped";
    return this.sampling ? "sampling" : "watching";
  }

  private scheduleTick(): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.tickTimer = null;
      void this.tick()
        .catch((error: unknown) => this.note("heap-gate", `sample failed: ${serializeError(error)}`))
        .finally(() => this.scheduleTick());
    }, this.config.intervalMs);
    timer.unref?.();
    this.tickTimer = timer;
  }

  private refreshWorkers(): void {
    if (this.liveWorkerCount() === 0) {
      this.workers.clear();
      return;
    }
    if (this.workerRefresh) return;
    this.workerRefresh = this.readWorkerHeaps(WORKER_READ_TIMEOUT_MS)
      .then((readings) => {
        this.workers = this.mergeWorkers(readings);
      })
      .catch(() => undefined)
      .finally(() => {
        this.workerRefresh = null;
      });
  }

  /** Fresh readings, keeping a worker's last known heap when it didn't answer. */
  private mergeWorkers(readings: readonly WorkerHeapReading[]): Map<number, WorkerHeapReading> {
    return new Map(readings.map((reading) => {
      const known = this.workers.get(reading.threadId);
      return [reading.threadId, reading.usedBytes === null && known?.usedBytes != null ? known : reading];
    }));
  }

  private async freshWorkers(): Promise<WorkerHeapReading[]> {
    if (this.liveWorkerCount() === 0) return [];
    this.workers = this.mergeWorkers(await this.readWorkerHeaps(WORKER_READ_TIMEOUT_MS));
    return [...this.workers.values()];
  }

  private cageUsed(reading: HeapReading): number {
    let total = reading.usedBytes;
    for (const worker of this.workers.values()) total += worker.usedBytes ?? 0;
    return total;
  }

  private updateGcHook(reading: HeapReading): void {
    const fraction = this.cageUsed(reading) / reading.limitBytes;
    if (!this.stopGcHook && fraction >= GC_HOOK_ON_FRACTION) {
      this.stopGcHook = this.observeMajorGc(() => this.checkNearLimit(this.readHeap(this.now())));
    } else if (this.stopGcHook && fraction < GC_HOOK_OFF_FRACTION) {
      this.stopGcHook();
      this.stopGcHook = null;
    }
  }

  private checkNearLimit(reading: HeapReading): void {
    const cageUsed = this.cageUsed(reading);
    const fraction = cageUsed / reading.limitBytes;
    if (this.nearLimitLogged) {
      if (fraction < this.config.nearLimitFraction * REARM_FRACTION) this.nearLimitLogged = false;
      return;
    }
    if (fraction < this.config.nearLimitFraction) return;
    this.nearLimitLogged = true;
    const workers = [...this.workers.values()]
      .map((worker) => `${worker.label} ${worker.usedBytes === null ? "?" : mb(worker.usedBytes)}`)
      .join(", ");
    this.note(
      "heap-near-limit",
      `main ${mb(reading.usedBytes)}${workers ? ` + workers (${workers})` : ""} = ${Math.round(fraction * 100)}% of the ${mb(reading.limitBytes)} heap limit. `
        + "If DiskHound exits now, V8 ran out of heap; its abort skips every crash handler.",
    );
    if (!this.sampling || !this.inspector) return;
    // Synchronously: the process may not get another turn.
    try {
      const { profile } = this.inspector.postSync<{ profile: unknown }>("HeapProfiler.getSamplingProfile");
      const filename = `main-near-limit-${String(this.session.allocateIndex("main-near-limit")).padStart(4, "0")}.heapprofile`;
      const text = JSON.stringify(profile);
      this.session.prepareSync();
      FS_SYNC.writeFileSync(this.session.artifactPath(filename), text, "utf8");
      const summary = `${this.sampledSummary(reading)}, at ${Math.round(fraction * 100)}% of the heap limit`;
      this.session.commitSync({
        artifacts: [{ filename, kind: "heapprofile", bytes: Buffer.byteLength(text), capturedAt: new Date(this.now()).toISOString(), summary }],
        samples: this.takeUnflushedSamples(),
      });
      this.note("heap-near-limit", `saved ${this.session.artifactPath(filename)}`);
    } catch (error) {
      this.note("heap-near-limit", `allocation profile failed: ${serializeError(error)}`);
    }
  }

  private sampledSummary(reading: HeapReading): string {
    const since = this.samplingSince;
    if (!since) return `live allocations at ${mb(reading.usedBytes)}`;
    return `live allocations at ${mb(reading.usedBytes)}, sampled for ${duration(reading.capturedAtMs - since.atMs)} from ${mb(since.usedBytes)}`;
  }

  private startSampling(reading: HeapReading): void {
    if (this.sampling || this.samplingFailed || !this.inspector) return;
    try {
      if (!this.inspector.isAttached()) this.inspector.attach();
      this.inspector.postSync("HeapProfiler.enable");
      this.inspector.postSync("HeapProfiler.startSampling", { samplingInterval: SAMPLING_INTERVAL_BYTES });
      this.sampling = true;
      this.samplingSince = { atMs: reading.capturedAtMs, usedBytes: reading.usedBytes };
      this.recordEvent("sampling-started", { watchBytes: this.config.watchBytes, usedBytes: reading.usedBytes });
    } catch (error) {
      this.samplingFailed = true;
      this.detachInspector();
      this.note("heap-gate", `sampling heap profiler failed to start: ${serializeError(error)}`);
    }
  }

  private stopSampling(reason: string): void {
    if (!this.sampling) return;
    this.sampling = false;
    this.samplingSince = null;
    try {
      this.inspector?.postSync("HeapProfiler.stopSampling");
    } catch {
      // Detaching stops it too.
    }
    this.detachInspector();
    this.recordEvent("sampling-stopped", { reason });
  }

  private detachInspector(): void {
    try {
      if (this.inspector?.isAttached()) this.inspector.detach();
    } catch {
      // In-process sessions detach cleanly.
    }
  }

  private fireGate(reading: HeapReading): void {
    if (this.isCapped()) {
      if (!this.cappedNoted) {
        this.cappedNoted = true;
        this.note(
          "heap-gate",
          `main heap ${mb(reading.usedBytes)} passed the ${mb(this.config.gateBytes)} gate, but today's ${this.config.maxGatesPerDay} capture(s) for ${this.appVersion} are done`,
        );
      }
      return;
    }
    const last = this.dayState?.lastGateAt ? Date.parse(this.dayState.lastGateAt) : null;
    if (last !== null && this.now() - last < this.config.cooldownMs) return;
    this.gateFired = true;
    const work = this.captureGate(reading).catch((error: unknown) => {
      this.note("heap-gate", `capture failed: ${serializeError(error)}`);
    });
    this.busy = work;
    void work.finally(() => {
      if (this.busy === work) this.busy = null;
    });
  }

  private async captureGate(reading: HeapReading): Promise<void> {
    const prefix = `main-gate-${String(this.session.allocateIndex("main-gate")).padStart(4, "0")}`;
    const workers = await this.freshWorkers();
    this.recordEvent("gate-triggered", {
      usedBytes: reading.usedBytes,
      limitBytes: reading.limitBytes,
      gateBytes: this.config.gateBytes,
      rssBytes: reading.rssBytes,
      workers: workers.map(({ label, threadId, usedBytes, error }) => ({ label, threadId, usedBytes, error })),
    });
    await this.session.prepare();

    // The allocation profile first: it is small, and it is on disk
    // before a snapshot could take the app down.
    const artifacts: DiagnosticsArtifactRecord[] = [];
    let saved = "no allocation profile (the sampling heap profiler isn't running)";
    if (this.sampling && this.samplingSince && this.samplingSince.atMs >= reading.capturedAtMs) {
      // It would be empty: the heap passed the watch mark and the gate
      // inside one check.
      saved = "no allocation profile: sampling started in this same check";
    } else if (this.sampling && this.inspector) {
      try {
        const { profile } = this.inspector.postSync<{ profile: unknown }>("HeapProfiler.getSamplingProfile");
        const filename = `${prefix}.heapprofile`;
        const text = JSON.stringify(profile);
        await FS.writeFile(this.session.artifactPath(filename), text, "utf8");
        const summary = this.sampledSummary(reading);
        artifacts.push({ filename, kind: "heapprofile", bytes: Buffer.byteLength(text), capturedAt: new Date(this.now()).toISOString(), summary });
        saved = `saved ${this.session.artifactPath(filename)}`;
      } catch (error) {
        saved = `allocation profile failed: ${serializeError(error)}`;
      }
    }
    await this.countGate();
    await this.session.commit({ artifacts, samples: this.takeUnflushedSamples() });
    const workerNote = workers.length === 0
      ? "no workers"
      : workers.map((worker) => `${worker.label} ${worker.usedBytes === null ? "?" : mb(worker.usedBytes)}`).join(", ");
    this.note("heap-gate", `main heap ${mb(reading.usedBytes)} of ${mb(reading.limitBytes)} passed the ${mb(this.config.gateBytes)} gate (${workerNote}); ${saved}`);
    for (const artifact of artifacts) {
      await this.onCapture?.({ path: this.session.artifactPath(artifact.filename), kind: artifact.kind, bytes: artifact.bytes, summary: artifact.summary ?? "" });
    }

    if (!this.config.snapshots) return;
    const first = await this.takeSnapshot(`${prefix}-a`, "gate snapshot A");
    if (!first.path || this.stopped) return;
    // B only if the cage still has room then, so the pair can be diffed.
    const timer = setTimeout(() => {
      this.snapshotBTimer = null;
      const work = this.takeSnapshot(`${prefix}-b`, "gate snapshot B").catch((error: unknown) => {
        this.note("heap-snapshot", `gate snapshot B failed: ${serializeError(error)}`);
      });
      this.busy = work;
      void work.finally(() => {
        if (this.busy === work) this.busy = null;
      });
    }, this.config.snapshotGapMs);
    timer.unref?.();
    this.snapshotBTimer = timer;
  }

  private async takeSnapshot(basename: string, label: string): Promise<{ message: string; path?: string }> {
    const reading = this.readHeap(this.now());
    const headroom = checkSnapshotHeadroom(
      reading,
      await this.freshWorkers(),
      this.config.headroomFraction,
      this.config.snapshotMaxBytes,
    );
    if (!headroom.ok) {
      const message = `${label} skipped: ${headroom.reason}`;
      this.recordEvent("snapshot-skipped", { label, reason: headroom.reason, usedBytes: reading.usedBytes });
      if (this.session.exists) await this.session.commit();
      this.note("heap-snapshot", message);
      return { message };
    }
    await this.session.prepare();
    const filename = `${basename}.heapsnapshot`;
    const filePath = this.session.artifactPath(filename);
    const startedAt = this.monotonicNow();
    this.writeHeapSnapshot(filePath);
    const pauseMs = Math.round(this.monotonicNow() - startedAt);
    this.afterBlockingCapture?.();
    let bytes = 0;
    try {
      bytes = (await FS.stat(filePath)).size;
    } catch {
      // Report what we can.
    }
    const summary = `${label} at ${mb(reading.usedBytes)} heap: ${mb(bytes)} file, main thread paused ${(pauseMs / 1000).toFixed(1)} s`;
    this.recordEvent("snapshot-written", { label, filename, bytes, pauseMs, usedBytes: reading.usedBytes });
    await this.session.commit({
      artifacts: [{ filename, kind: "heapsnapshot", bytes, capturedAt: new Date(this.now()).toISOString(), summary, detail: { pauseMs, usedBytes: reading.usedBytes, headroom: headroom.reason } }],
      samples: this.takeUnflushedSamples(),
    });
    this.note("heap-snapshot", `saved ${filePath} (${mb(bytes)}); main thread paused ${pauseMs} ms; ${headroom.reason}`);
    await this.onCapture?.({ path: filePath, kind: "heapsnapshot", bytes, summary });
    return { message: summary, path: filePath };
  }

  private isCapped(): boolean {
    return this.gatesToday() >= this.config.maxGatesPerDay;
  }

  private gatesToday(): number {
    const state = this.dayState;
    if (!state || state.appVersion !== this.appVersion || state.day !== localDay(this.now())) return 0;
    return state.count;
  }

  private async loadDayState(): Promise<void> {
    if (this.dayState) return;
    try {
      const parsed = JSON.parse(await FS.readFile(this.statePath, "utf8")) as Partial<GateDayState>;
      this.dayState = {
        appVersion: String(parsed.appVersion ?? ""),
        day: String(parsed.day ?? ""),
        count: Number.isFinite(parsed.count) ? Number(parsed.count) : 0,
        lastGateAt: typeof parsed.lastGateAt === "string" ? parsed.lastGateAt : null,
      };
    } catch {
      this.dayState = { appVersion: this.appVersion, day: localDay(this.now()), count: 0, lastGateAt: null };
    }
  }

  /** One small write per gate capture, so the daily cap survives restarts. */
  private async countGate(): Promise<void> {
    const nowMs = this.now();
    this.dayState = {
      appVersion: this.appVersion,
      day: localDay(nowMs),
      count: this.gatesToday() + 1,
      lastGateAt: new Date(nowMs).toISOString(),
    };
    try {
      await FS.writeFile(this.statePath, `${JSON.stringify(this.dayState)}\n`, "utf8");
    } catch (error) {
      this.note("heap-gate", `could not record today's gate count: ${serializeError(error)}`);
    }
  }

  private takeUnflushedSamples(): Array<Record<string, unknown>> {
    const pending = this.samples.filter((sample) => sample.capturedAtMs > this.flushedThroughMs);
    const last = pending.at(-1);
    if (last) this.flushedThroughMs = last.capturedAtMs;
    return pending.map(({ capturedAtMs, ...rest }) => ({ capturedAt: new Date(capturedAtMs).toISOString(), ...rest }));
  }

  private recordEvent(type: string, detail: Record<string, unknown>): void {
    this.session.recordEvent({ capturedAt: new Date(this.now()).toISOString(), type, detail });
  }

  /** crash.log line, also shown as the status's last event. */
  private note(tag: string, message: string): void {
    this.lastEvent = message;
    this.log(tag, message);
  }
}
