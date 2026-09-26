import * as FS from "node:fs/promises";
import type { Profiler } from "node:inspector";

import { joinCpuProfiles } from "./cpuProfileJoin";
import type { HotCpuConfig } from "./diagnosticsConfig";
import type { DiagnosticsArtifactRecord, DiagnosticsLog, DiagnosticsSession } from "./diagnosticsSession";
import type { InspectorTarget } from "./mainInspector";

export interface CpuReading {
  /** CPU time of the calling (main) thread, µs, user + system. */
  threadMicros: number;
  /** CPU time of the whole process, all threads including workers, µs. */
  processMicros: number;
}

/**
 * The trigger reads the main thread only. The profile covers only the
 * main thread, and whole-process CPU includes worker_threads: a scan
 * or folder-tree worker at 100% would otherwise fire captures of an
 * idle main thread. `process.threadCpuUsage()` is Node 23.9+; Electron
 * 40 ships 24.13. Older Node (vitest on a CI runner) falls back to the
 * whole process.
 */
export function readMainCpu(): CpuReading {
  const whole = process.cpuUsage();
  const thread = typeof process.threadCpuUsage === "function" ? process.threadCpuUsage() : whole;
  return { threadMicros: thread.user + thread.system, processMicros: whole.user + whole.system };
}

export interface HotCpuSample {
  capturedAt: string;
  /** Main thread since the previous sample, % of one core. */
  cpuPercent: number;
  /** Whole process (workers too) since the previous sample, % of one core. */
  processCpuPercent: number;
  heapUsed: number;
  consecutiveHotSamples: number;
}

export interface HotCpuProfileWritten {
  path: string;
  filename: string;
  bytes: number;
  summary: string;
}

export interface HotCpuStatus {
  state: "starting" | "recording" | "profiling" | "capped" | "failed" | "stopped";
  profilesWritten: number;
  maxProfiles: number;
  lastCpuPercent: number | null;
}

/** Enough for the ~60 s lookback plus the 15 s after, at 2 s samples. */
const SAMPLE_RING_SIZE = 64;

type Timer = ReturnType<typeof setTimeout>;

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

/**
 * Main-process hot-CPU profiler with lookback, ported from PwrAgnt's
 * hot-cpu-profiler.ts.
 *
 * V8's sampling profiler records the main thread continuously. The
 * recording is rotated every `recordingWindowMs` (30 s), only after the
 * CPU sample has been evaluated, and the last finished window is kept
 * along with the live one. When the main thread stays hot for
 * `consecutiveSamples` samples, recording continues for
 * `profileDurationMs` more and both windows are joined into one
 * .cpuprofile: up to ~60 s before the trigger and 15 s after. A
 * recording that never triggers is discarded on stop.
 *
 * Unlike PwrAgnt, samples and events are held in memory and written
 * only next to a capture, so an idle profiler never writes (see
 * hotCpuProfiler.ioBudget.test.ts).
 */
export class HotCpuProfiler {
  private readonly config: HotCpuConfig;
  private readonly session: DiagnosticsSession;
  private readonly inspector: InspectorTarget;
  private readonly readCpu: () => CpuReading;
  private readonly readHeapUsed: () => number;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly log: DiagnosticsLog;
  private readonly onProfileWritten?: (written: HotCpuProfileWritten) => void | Promise<void>;
  private readonly onSampleCaptured?: () => void;

  private startPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private stopProfilePromise: Promise<void> | null = null;
  private captureSamplePromise: Promise<void> | null = null;
  private intervalTimer: Timer | null = null;
  private profileDurationTimer: Timer | null = null;
  private stopped = false;
  private failed = false;
  private recording = false;
  private recordingStartedAtMs = 0;
  private recordingStartedAtMonotonicMs = 0;
  private previousRecording: Profiler.Profile | null = null;
  private previousRecordingStartedAtMs = 0;
  private profiling = false;
  private samplingPausedForProfile = false;
  private consecutiveHotSamples = 0;
  private previousCpu: { reading: CpuReading; atMonotonicMs: number } | null = null;
  private lastCpuPercent: number | null = null;
  private lastProfileAtMs: number | null = null;
  private profileCount: number;
  private cappedLogged = false;
  private activeTrigger: {
    index: number;
    cpuPercent: number;
    capturedAtMs: number;
    windowStartedAtMs: number;
  } | null = null;
  private readonly samples: HotCpuSample[] = [];
  private flushedThroughMs = Number.NEGATIVE_INFINITY;

  constructor(options: {
    config: HotCpuConfig;
    session: DiagnosticsSession;
    inspector: InspectorTarget;
    readCpu?: () => CpuReading;
    readHeapUsed?: () => number;
    /** Wall clock, ms. */
    now?: () => number;
    /** For rotation and CPU deltas; unaffected by clock changes. */
    monotonicNow?: () => number;
    /** writeCrashLog in main. */
    log?: DiagnosticsLog;
    onProfileWritten?: (written: HotCpuProfileWritten) => void | Promise<void>;
    /**
     * Fires once per completed sampling iteration, after rescheduling.
     * The loop awaits real inspector and disk work, so tests wait on
     * this instead of polling a wall-clock budget (see PwrAgnt's
     * renderer-hot-cpu-profiler.test.ts). Unused in production.
     */
    onSampleCaptured?: () => void;
  }) {
    this.config = options.config;
    this.session = options.session;
    this.inspector = options.inspector;
    this.readCpu = options.readCpu ?? readMainCpu;
    this.readHeapUsed = options.readHeapUsed ?? (() => process.memoryUsage().heapUsed);
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.log = options.log ?? (() => {});
    this.onProfileWritten = options.onProfileWritten;
    this.onSampleCaptured = options.onSampleCaptured;
    // A settings toggle restarts the profiler; the cap is per launch.
    this.profileCount = this.session.writtenCount("cpuprofile");
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    this.startPromise ??= this.startInner();
    await this.startPromise;
  }

  async stop(reason = "stopped"): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }
    this.stopped = true;
    this.shutdownPromise = this.stopInner(reason);
    await this.shutdownPromise;
  }

  status(): HotCpuStatus {
    const state = this.stopped
      ? "stopped"
      : this.profiling
        ? "profiling"
        : this.isCapped()
          ? "capped"
          : this.failed
            ? "failed"
            : this.recording
              ? "recording"
              : "starting";
    return {
      state,
      profilesWritten: this.session.writtenCount("cpuprofile"),
      maxProfiles: this.config.maxProfiles,
      lastCpuPercent: this.lastCpuPercent,
    };
  }

  /**
   * Call right after main was blocked on purpose, e.g. by a heap
   * snapshot, so that pause doesn't read as a hot main thread.
   */
  discountBlockedInterval(): void {
    if (this.previousCpu === null) return;
    this.previousCpu = { reading: this.readCpu(), atMonotonicMs: this.monotonicNow() };
  }

  private async startInner(): Promise<void> {
    this.session.recordEvent({
      capturedAt: new Date(this.now()).toISOString(),
      type: "monitor-started",
      detail: { ...this.config },
    });
    if (this.isCapped()) {
      this.logCapped();
      return;
    }
    await this.ensureRecording(this.now());
    this.log(
      "hot-cpu",
      `armed: ${this.config.consecutiveSamples} samples ${this.config.intervalMs} ms apart at >= ${this.config.thresholdPercent}% main-thread CPU `
        + `trigger a profile reaching up to ${seconds(this.recordingWindowMs() * 2)} back and ${seconds(this.config.profileDurationMs)} on, `
        + `in ${this.session.directoryPath}`,
    );
    this.scheduleNextSample(this.config.startDelayMs);
  }

  private async stopInner(reason: string): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    if (this.intervalTimer) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.clearProfileDurationTimer();
    // Stop an already-started profile in parallel with its owning
    // sample. Recheck after the sample settles in case it crossed into
    // profiling while shutdown was starting.
    const captureSamplePromise = this.captureSamplePromise;
    const activeProfileStop = this.profiling || this.stopProfilePromise ? this.stopProfile(reason) : null;
    await Promise.all([captureSamplePromise, activeProfileStop]);
    if (this.profiling || this.stopProfilePromise) await this.stopProfile(reason);
    // An armed recorder without a trigger is discarded, never published.
    await this.discardRecording();
    this.detachInspector();
    this.session.recordEvent({
      capturedAt: new Date(this.now()).toISOString(),
      type: "monitor-stopped",
      detail: { reason },
    });
  }

  private scheduleNextSample(delayMs = this.config.intervalMs): void {
    if (this.stopped || this.isCapped()) return;
    const timer = setTimeout(() => {
      const captureSamplePromise = this.captureSample();
      this.captureSamplePromise = captureSamplePromise;
      void captureSamplePromise.then(
        () => {
          if (this.captureSamplePromise === captureSamplePromise) this.captureSamplePromise = null;
        },
        (error: unknown) => {
          if (this.captureSamplePromise === captureSamplePromise) this.captureSamplePromise = null;
          this.log("hot-cpu", `sample task failed: ${serializeError(error)}`);
        },
      );
    }, delayMs);
    timer.unref?.();
    this.intervalTimer = timer;
  }

  private async captureSample(): Promise<void> {
    this.intervalTimer = null;
    if (this.stopped) return;
    const capturedAtMs = this.now();
    try {
      const reading = this.readCpu();
      const atMonotonicMs = this.monotonicNow();
      const previous = this.previousCpu;
      this.previousCpu = { reading, atMonotonicMs };
      const wallMicros = previous ? (atMonotonicMs - previous.atMonotonicMs) * 1000 : 0;
      const valid = previous !== null && wallMicros > 0 && reading.threadMicros >= previous.reading.threadMicros;
      // The first sample after start or a capture is only a baseline.
      const cpuPercent = valid ? ((reading.threadMicros - previous.reading.threadMicros) / wallMicros) * 100 : 0;
      const processCpuPercent = valid ? ((reading.processMicros - previous.reading.processMicros) / wallMicros) * 100 : 0;
      this.lastCpuPercent = valid ? cpuPercent : this.lastCpuPercent;
      this.consecutiveHotSamples = valid && cpuPercent >= this.config.thresholdPercent
        ? this.consecutiveHotSamples + 1
        : 0;
      this.pushSample({
        capturedAt: new Date(capturedAtMs).toISOString(),
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        processCpuPercent: Math.round(processCpuPercent * 10) / 10,
        heapUsed: this.readHeapUsed(),
        consecutiveHotSamples: this.consecutiveHotSamples,
      });

      if (this.shouldStartProfile(capturedAtMs)) {
        await this.startProfile(cpuPercent, capturedAtMs);
      } else if (!this.stopped && !this.isCapped()) {
        await this.maintainRecording(capturedAtMs);
      }
    } catch (error) {
      this.session.recordEvent({
        capturedAt: new Date(capturedAtMs).toISOString(),
        type: "sample-failed",
        detail: { error: serializeError(error) },
      });
      // Keep rotating, so the lookback stays bounded without readings.
      if (!this.stopped && !this.profiling && !this.isCapped()) {
        await this.maintainRecording(capturedAtMs).catch(() => undefined);
      }
    } finally {
      if (!this.profiling) {
        this.scheduleNextSample();
      } else {
        this.samplingPausedForProfile = true;
      }
      // After rescheduling, so an observer woken here already sees the
      // next timer armed.
      this.onSampleCaptured?.();
    }
  }

  private shouldStartProfile(capturedAtMs: number): boolean {
    if (this.stopped || this.profiling || this.isCapped()) return false;
    if (this.consecutiveHotSamples < this.config.consecutiveSamples) return false;
    return this.lastProfileAtMs === null || capturedAtMs - this.lastProfileAtMs >= this.config.cooldownMs;
  }

  private isCapped(): boolean {
    return this.profileCount >= this.config.maxProfiles;
  }

  private recordingWindowMs(): number {
    return Math.max(this.config.recordingWindowMs, this.config.intervalMs * this.config.consecutiveSamples);
  }

  private async maintainRecording(startedAtMs: number): Promise<void> {
    await this.ensureRecording(startedAtMs);
    if (this.recording && this.monotonicNow() - this.recordingStartedAtMonotonicMs >= this.recordingWindowMs()) {
      await this.rotateRecording(startedAtMs);
    }
  }

  private async ensureRecording(startedAtMs: number): Promise<void> {
    if (this.stopped || this.recording || this.isCapped()) return;
    try {
      if (!this.inspector.isAttached()) {
        this.inspector.attach();
        await this.inspector.post("Profiler.enable");
      }
      if (this.stopped) return;
      await this.inspector.post("Profiler.start");
      this.recording = true;
      this.failed = false;
      this.recordingStartedAtMs = startedAtMs;
      this.recordingStartedAtMonotonicMs = this.monotonicNow();
    } catch (error) {
      this.recording = false;
      this.previousRecording = null;
      this.detachInspector();
      if (!this.failed) this.log("hot-cpu", `recorder failed to start: ${serializeError(error)}`);
      this.failed = true;
      this.session.recordEvent({
        capturedAt: new Date(startedAtMs).toISOString(),
        type: "recorder-start-failed",
        detail: { error: serializeError(error) },
      });
    }
  }

  private async finishRecording(): Promise<Profiler.Profile> {
    if (!this.recording) throw new Error("CPU recorder is not armed");
    const result = await this.inspector.post<{ profile: Profiler.Profile }>("Profiler.stop");
    this.recording = false;
    return result.profile;
  }

  private async rotateRecording(startedAtMs: number): Promise<void> {
    try {
      this.previousRecording = await this.finishRecording();
      this.previousRecordingStartedAtMs = this.recordingStartedAtMs;
      if (this.stopped) return;
      await this.inspector.post("Profiler.start");
      this.recording = true;
      this.recordingStartedAtMs = startedAtMs;
      this.recordingStartedAtMonotonicMs = this.monotonicNow();
    } catch (error) {
      this.recording = false;
      this.previousRecording = null;
      this.detachInspector();
      throw error;
    }
  }

  private async discardRecording(): Promise<void> {
    try {
      if (this.recording) await this.finishRecording();
    } catch {
      // Nothing to publish either way.
    } finally {
      this.recording = false;
      this.previousRecording = null;
    }
  }

  private async startProfile(cpuPercent: number, capturedAtMs: number): Promise<void> {
    if (this.stopped) return;
    if (!this.recording) {
      // Arming failed earlier. A recording started now would not hold
      // the hot interval, so don't describe it as if it did.
      this.session.recordEvent({
        capturedAt: new Date(capturedAtMs).toISOString(),
        type: "profile-skipped",
        detail: { reason: "recorder-not-armed", cpuPercent },
      });
      await this.ensureRecording(capturedAtMs);
      return;
    }
    this.profiling = true;
    this.profileCount += 1;
    this.lastProfileAtMs = capturedAtMs;
    const windowStartedAtMs = this.previousRecording ? this.previousRecordingStartedAtMs : this.recordingStartedAtMs;
    this.activeTrigger = {
      index: this.session.allocateIndex("main-hot"),
      cpuPercent,
      capturedAtMs,
      windowStartedAtMs,
    };
    this.session.recordEvent({
      capturedAt: new Date(capturedAtMs).toISOString(),
      type: "profile-started",
      detail: {
        index: this.activeTrigger.index,
        cpuPercent: Math.round(cpuPercent),
        thresholdPercent: this.config.thresholdPercent,
        consecutiveSamples: this.config.consecutiveSamples,
        durationMs: this.config.profileDurationMs,
        recordingStartedAt: new Date(windowStartedAtMs).toISOString(),
        preTriggerDurationMs: capturedAtMs - windowStartedAtMs,
      },
    });
    const timer = setTimeout(() => void this.stopProfile("duration-elapsed"), this.config.profileDurationMs);
    timer.unref?.();
    this.profileDurationTimer = timer;
  }

  private async stopProfile(reason: string): Promise<void> {
    if (this.stopProfilePromise) {
      await this.stopProfilePromise;
      return;
    }
    if (!this.profiling) return;
    this.stopProfilePromise = this.stopProfileInner(reason);
    try {
      await this.stopProfilePromise;
    } finally {
      this.stopProfilePromise = null;
    }
  }

  private async stopProfileInner(reason: string): Promise<void> {
    this.profiling = false;
    this.clearProfileDurationTimer();
    const trigger = this.activeTrigger ?? {
      index: this.session.allocateIndex("main-hot"),
      cpuPercent: 0,
      capturedAtMs: this.now(),
      windowStartedAtMs: this.recordingStartedAtMs,
    };
    const filename = `main-hot-${String(trigger.index).padStart(4, "0")}.cpuprofile`;
    const filePath = this.session.artifactPath(filename);
    try {
      const current = await this.finishRecording();
      const profile = joinCpuProfiles(this.previousRecording ? [this.previousRecording, current] : [current]);
      const text = `${JSON.stringify(profile)}\n`;
      await this.session.prepare();
      await FS.writeFile(filePath, text, "utf8");
      const spanMs = Math.round((profile.endTime - profile.startTime) / 1000);
      const lookbackMs = Math.max(0, trigger.capturedAtMs - trigger.windowStartedAtMs);
      const summary = `${seconds(spanMs)}, ${seconds(lookbackMs)} before a ${Math.round(trigger.cpuPercent)}% main-thread trigger`;
      const bytes = Buffer.byteLength(text);
      const capturedAt = new Date(this.now()).toISOString();
      const record: DiagnosticsArtifactRecord = {
        filename,
        kind: "cpuprofile",
        bytes,
        capturedAt,
        summary,
        detail: {
          reason,
          triggerCpuPercent: Math.round(trigger.cpuPercent),
          triggeredAt: new Date(trigger.capturedAtMs).toISOString(),
          recordingStartedAt: new Date(trigger.windowStartedAtMs).toISOString(),
          spanMs,
          lookbackMs,
        },
      };
      this.session.recordEvent({ capturedAt, type: "profile-written", detail: { filename, reason, bytes } });
      await this.session.commit({ artifacts: [record], samples: this.takeUnflushedSamples() });
      this.log("hot-cpu", `saved ${filePath} (${Math.round(bytes / 1024)} KB): ${summary}`);
      await this.onProfileWritten?.({ path: filePath, filename, bytes, summary });
    } catch (error) {
      this.session.recordEvent({
        capturedAt: new Date(this.now()).toISOString(),
        type: "profile-stop-failed",
        detail: { filename, reason, error: serializeError(error) },
      });
      this.log("hot-cpu", `capture ${filePath} failed: ${serializeError(error)}`);
    } finally {
      this.activeTrigger = null;
      this.previousRecording = null;
      this.recording = false;
      this.detachInspector();
      if (this.isCapped()) {
        this.logCapped();
      } else {
        await this.ensureRecording(this.now());
      }
      this.resumeSamplingAfterProfile();
    }
  }

  private resumeSamplingAfterProfile(): void {
    if (!this.samplingPausedForProfile) return;
    this.samplingPausedForProfile = false;
    this.previousCpu = null;
    this.consecutiveHotSamples = 0;
    if (this.stopped || this.intervalTimer) return;
    this.scheduleNextSample();
  }

  private pushSample(sample: HotCpuSample): void {
    this.samples.push(sample);
    if (this.samples.length > SAMPLE_RING_SIZE) this.samples.shift();
  }

  /** Samples not yet on disk: the ring since the previous capture. */
  private takeUnflushedSamples(): HotCpuSample[] {
    const pending = this.samples.filter((sample) => Date.parse(sample.capturedAt) > this.flushedThroughMs);
    const last = pending.at(-1);
    if (last) this.flushedThroughMs = Date.parse(last.capturedAt);
    return pending;
  }

  private logCapped(): void {
    if (this.cappedLogged) return;
    this.cappedLogged = true;
    this.log(
      "hot-cpu",
      `${this.config.maxProfiles} profiles captured this launch; the profiler is off until DiskHound restarts`,
    );
  }

  private detachInspector(): void {
    try {
      if (this.inspector.isAttached()) this.inspector.detach();
    } catch {
      // Detaching an in-process session can't meaningfully fail.
    }
  }

  private clearProfileDurationTimer(): void {
    if (!this.profileDurationTimer) return;
    clearTimeout(this.profileDurationTimer);
    this.profileDurationTimer = null;
  }
}
