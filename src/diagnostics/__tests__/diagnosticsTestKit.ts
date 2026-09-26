import * as FS_SYNC from "node:fs";
import * as FS from "node:fs/promises";
import type { Profiler } from "node:inspector";
import * as OS from "node:os";
import * as Path from "node:path";

import { vi } from "vitest";

import { HEAP_DEFAULTS, HOT_CPU_DEFAULTS, type HeapGateConfig, type HotCpuConfig } from "../diagnosticsConfig";
import { DiagnosticsSession, type DiagnosticsVersions } from "../diagnosticsSession";
import type { HeapReading } from "../heapMonitor";
import type { InspectorTarget } from "../mainInspector";

export const MB = 1024 * 1024;
export const LIMIT = 4096 * MB;

export const TEST_VERSIONS: DiagnosticsVersions = {
  appVersion: "0.6.2",
  electronVersion: "40.6.0",
  chromeVersion: "144.0.0.0",
  nodeVersion: "24.13.1",
  platform: "darwin",
  arch: "arm64",
};

export async function tempDir(prefix = "diskhound-diagnostics-"): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await FS.mkdtemp(Path.join(OS.tmpdir(), prefix));
  return { path, cleanup: () => FS.rm(path, { recursive: true, force: true }) };
}

/**
 * main.ts's writeCrashLog, call for call: a sync mkdir and append, then
 * an async stat for the size-based rotation. Budget tests log through
 * this so each capture's crash.log line is counted.
 */
export function crashLogLike(dir: string): (tag: string, message: string) => void {
  const logPath = Path.join(dir, "crash.log");
  return (tag, message) => {
    const line = `[${new Date().toISOString()}] [${tag}] ${message}\n`;
    try { FS_SYNC.mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
    FS_SYNC.appendFileSync(logPath, line);
    void FS.stat(logPath).catch(() => {});
  };
}

export function hotCpuConfig(overrides: Partial<HotCpuConfig> = {}): HotCpuConfig {
  return { ...HOT_CPU_DEFAULTS, enabled: true, thresholdPercent: 50, ...overrides };
}

export function heapConfig(overrides: Partial<HeapGateConfig> = {}): HeapGateConfig {
  const gateBytes = overrides.gateBytes ?? 1200 * MB;
  return {
    ...HEAP_DEFAULTS,
    enabled: true,
    snapshotMaxBytes: HEAP_DEFAULTS.snapshotMaxBytes,
    snapshots: false,
    gateBytes,
    // A watch mark at 75% of the gate, to exercise it; the default is 0.
    watchBytes: gateBytes * 0.75,
    ...overrides,
  };
}

export function session(root: string, kind: "hot-cpu" | "heap", createdAt = new Date(2026, 8, 25, 14, 12)): DiagnosticsSession {
  return new DiagnosticsSession({ outputRoot: root, kind, config: {}, versions: TEST_VERSIONS, createdAt, sessionId: kind === "heap" ? "bbbbbb" : "aaaaaa" });
}

export function heapReading(usedMb: number, capturedAtMs = Date.now()): HeapReading {
  return {
    capturedAtMs,
    usedBytes: usedMb * MB,
    totalBytes: usedMb * MB * 1.1,
    limitBytes: LIMIT,
    rssBytes: usedMb * MB * 1.4,
    externalBytes: 20 * MB,
    arrayBuffersBytes: 5 * MB,
    mallocedBytes: 2 * MB,
  };
}

const ROOT_FRAME = { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 };

/**
 * A window the size V8 records for the main thread: `seconds` of 1 ms
 * samples over `functions` distinct stacks. A real idle main thread is
 * mostly "(idle)"; a hot one spreads over a few thousand frames.
 */
export function realisticWindow(options: { startTime: number; seconds: number; functions?: number; name?: string }): Profiler.Profile {
  const functions = options.functions ?? 2_000;
  const nodes: Profiler.ProfileNode[] = [
    { id: 1, callFrame: ROOT_FRAME, children: [2, 3] },
    { id: 2, callFrame: { ...ROOT_FRAME, functionName: "(idle)" } },
    { id: 3, callFrame: { ...ROOT_FRAME, functionName: "(program)" }, children: [] },
  ];
  for (let index = 0; index < functions; index += 1) {
    const id = index + 4;
    nodes.push({
      id,
      callFrame: {
        functionName: `${options.name ?? "work"}${index}`,
        scriptId: "42",
        url: "file:///Applications/DiskHound.app/Contents/Resources/app.asar/dist-electron/main.cjs",
        lineNumber: index * 7,
        columnNumber: index % 80,
      },
      hitCount: 0,
      children: [],
      positionTicks: [],
    });
    const parent = index < 32 ? nodes[2] : nodes[3 + (index % 32)];
    parent.children!.push(id);
  }
  const sampleCount = options.seconds * 1000;
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push(index % 3 === 0 ? 2 : 4 + (index % functions));
    timeDeltas.push(1000 + (index % 7));
  }
  const duration = timeDeltas.reduce((sum, delta) => sum + delta, 0);
  return { nodes, startTime: options.startTime, endTime: options.startTime + duration, samples, timeDeltas };
}

/** A sampling heap profile with `samples` allocation sites of live objects. */
export function realisticHeapProfile(samples = 30_000): { head: unknown; samples: unknown[] } {
  const children = Array.from({ length: 1_500 }, (_, index) => ({
    callFrame: {
      functionName: `alloc${index}`,
      scriptId: "42",
      url: "file:///Applications/DiskHound.app/Contents/Resources/app.asar/dist-electron/main.cjs",
      lineNumber: index * 3,
      columnNumber: 4,
    },
    selfSize: 32_768 * (index % 17),
    id: index + 2,
    children: [],
  }));
  return {
    head: { callFrame: ROOT_FRAME, selfSize: 0, id: 1, children },
    samples: Array.from({ length: samples }, (_, index) => ({ size: 32_768, nodeId: 2 + (index % 1_500), ordinal: index })),
  };
}

/**
 * An in-memory stand-in for node:inspector. Profiler.stop returns what
 * `stopProfile` builds; HeapProfiler.getSamplingProfile returns
 * `samplingProfile`.
 */
export function fakeInspector(options: {
  stopProfile?: () => Profiler.Profile;
  samplingProfile?: () => unknown;
} = {}) {
  let attached = false;
  const answer = (method: string): unknown => {
    if (method === "Profiler.stop") {
      return {
        profile: options.stopProfile?.() ?? {
          nodes: [{ id: 1, callFrame: ROOT_FRAME, children: [] }],
          startTime: 0,
          endTime: 0,
          samples: [],
          timeDeltas: [],
        },
      };
    }
    if (method === "HeapProfiler.getSamplingProfile") {
      return { profile: options.samplingProfile?.() ?? realisticHeapProfile(10) };
    }
    return {};
  };
  const post = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
    if (!attached) throw new Error("not attached");
    return answer(method);
  });
  const postSync = vi.fn((method: string, _params?: Record<string, unknown>) => {
    if (!attached) throw new Error("not attached");
    return answer(method);
  });
  const inspector: InspectorTarget = {
    attach: vi.fn(() => {
      if (attached) throw new Error("already attached");
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
    }),
    isAttached: () => attached,
    post: post as InspectorTarget["post"],
    postSync: postSync as InspectorTarget["postSync"],
  };
  const calls = (method: string) =>
    [...post.mock.calls, ...postSync.mock.calls].filter(([name]) => name === method).length;
  return { inspector, post, postSync, calls };
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Waits on the profiler's own `onSampleCaptured` signal rather than a
 * wall-clock budget, as PwrAgnt's suite does: one iteration awaits real
 * work, and `vi.waitFor` would also step fake timers between retries.
 */
export function sampleTracker() {
  let captured = 0;
  let waiters: Array<{ ready: () => boolean; resolve: () => void }> = [];
  return {
    onSampleCaptured: () => {
      captured += 1;
      waiters = waiters.filter((waiter) => {
        if (!waiter.ready()) return true;
        waiter.resolve();
        return false;
      });
    },
    count: () => captured,
    async waitForCount(target: number): Promise<void> {
      if (captured >= target) return;
      await new Promise<void>((resolve) => waiters.push({ ready: () => captured >= target, resolve }));
    },
  };
}
