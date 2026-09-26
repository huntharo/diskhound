import * as Path from "node:path";

import type {
  DiagnosticsArtifactInfo,
  DiagnosticsArtifactKind,
  DiagnosticsSessionInfo,
  DiagnosticsSettings,
  DiagnosticsStatus,
} from "../shared/contracts";
import {
  liveWorkerCount as registryWorkerCount,
  readWorkerHeaps as registryWorkerHeaps,
  type WorkerHeapReading,
} from "../shared/workerHeapRegistry";
import { resolveDiagnosticsConfig, type DiagnosticsConfig } from "./diagnosticsConfig";
import {
  clearDiagnostics,
  DEFAULT_RETENTION,
  listDiagnosticsSessions,
  pruneDiagnostics,
  type RetentionLimits,
  type SessionListing,
} from "./diagnosticsRetention";
import {
  DIAGNOSTICS_SESSION_RE,
  DiagnosticsSession,
  SESSION_BOOKKEEPING_FILES,
  type DiagnosticsVersions,
} from "./diagnosticsSession";
import { HeapMonitor, type HeapReading } from "./heapMonitor";
import { HotCpuProfiler, type CpuReading } from "./hotCpuProfiler";
import { createMainInspector, type InspectorTarget } from "./mainInspector";

export const DIAGNOSTICS_DIRNAME = "diagnostics";
export const HEAP_GATE_STATE_FILE = "heap-gate-state.json";

const MB = 1024 * 1024;

const ARTIFACT_KINDS: Record<string, DiagnosticsArtifactKind> = {
  ".cpuprofile": "cpuprofile",
  ".heapprofile": "heapprofile",
  ".heapsnapshot": "heapsnapshot",
};

export interface DiagnosticsManagerOptions {
  userDataPath: string;
  settings: DiagnosticsSettings;
  versions: DiagnosticsVersions;
  env?: Record<string, string | undefined>;
  /** writeCrashLog in main. */
  log?: (tag: string, message: string) => void;
  retention?: RetentionLimits;
  // Seams for tests.
  createInspector?: () => InspectorTarget;
  readCpu?: () => CpuReading;
  readHeap?: (capturedAtMs: number) => HeapReading;
  readWorkerHeaps?: (timeoutMs: number) => Promise<WorkerHeapReading[]>;
  liveWorkerCount?: () => number;
  writeHeapSnapshot?: (filePath: string) => string;
  now?: () => number;
}

/**
 * Owns this launch's diagnostics: the hot-CPU profiler (started and
 * stopped as Settings change), the heap monitor (always sampling in
 * memory, for the near-limit breadcrumb; gate per Settings), retention
 * under `<userData>/diagnostics/`, and the status Settings shows.
 * Electron-free, so main.ts does the IPC and `shell` calls.
 */
export class DiagnosticsManager {
  readonly rootPath: string;

  private readonly options: DiagnosticsManagerOptions;
  private readonly log: (tag: string, message: string) => void;
  private readonly now: () => number;
  private config: DiagnosticsConfig;
  private readonly heapSession: DiagnosticsSession;
  private readonly heap: HeapMonitor;
  private hotCpuSession: DiagnosticsSession | null = null;
  private profiler: HotCpuProfiler | null = null;
  private profilerQueue: Promise<void> = Promise.resolve();
  private listing: SessionListing[] | null = null;
  /** Which of this launch's commits `listing` includes. */
  private listingGeneration = "";
  private sweep: Promise<void> | null = null;
  private stopped = false;

  constructor(options: DiagnosticsManagerOptions) {
    this.options = options;
    this.rootPath = Path.join(options.userDataPath, DIAGNOSTICS_DIRNAME);
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.config = resolveDiagnosticsConfig(options.settings, options.env);
    this.heapSession = new DiagnosticsSession({
      outputRoot: this.rootPath,
      kind: "heap",
      config: { ...this.config.heap },
      versions: options.versions,
      createdAt: new Date(this.now()),
    });
    this.heap = new HeapMonitor({
      config: this.config.heap,
      session: this.heapSession,
      statePath: Path.join(this.rootPath, HEAP_GATE_STATE_FILE),
      appVersion: options.versions.appVersion,
      inspector: (options.createInspector ?? createMainInspector)(),
      readHeap: options.readHeap,
      readWorkerHeaps: options.readWorkerHeaps ?? registryWorkerHeaps,
      liveWorkerCount: options.liveWorkerCount ?? registryWorkerCount,
      writeHeapSnapshot: options.writeHeapSnapshot,
      now: options.now,
      log: this.log,
      onCapture: () => this.afterCapture(),
      afterBlockingCapture: () => this.profiler?.discountBlockedInterval(),
    });
  }

  start(): void {
    if (this.config.envOverrides.length > 0) {
      this.log("diagnostics", `env overrides this launch: ${this.config.envOverrides.join(" ")}`);
    }
    this.heap.start();
    this.syncProfiler(false);
    // Earlier launches may have left empty or expired sessions.
    void this.runRetention();
  }

  /** Called on every settings save; cheap when diagnostics didn't change. */
  applySettings(settings: DiagnosticsSettings): void {
    if (this.stopped) return;
    const next = resolveDiagnosticsConfig(settings, this.options.env);
    const cpuChanged = JSON.stringify(next.hotCpu) !== JSON.stringify(this.config.hotCpu);
    const heapChanged = JSON.stringify(next.heap) !== JSON.stringify(this.config.heap);
    if (!cpuChanged && !heapChanged) return;
    this.config = next;
    if (heapChanged) {
      this.heap.reconfigure(next.heap);
      this.heapSession.updateConfig({ ...next.heap });
    }
    if (cpuChanged) this.syncProfiler(true);
  }

  async stop(reason = "app-quit"): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.heap.stop();
    const profiler = this.profiler;
    this.profiler = null;
    await this.profilerQueue.catch(() => undefined);
    await profiler?.stop(reason);
    this.hotCpuSession?.flushEventsSync();
  }

  /** For main.ts's `[memory]` crash.log line. */
  describeMemory(): string {
    return this.heap.describe();
  }

  /** Waits for in-flight heap captures. Tests only. */
  whenHeapIdle(): Promise<void> {
    return this.heap.whenIdle();
  }

  async status(): Promise<DiagnosticsStatus> {
    const sessions = (await this.sessions()).map(toSessionInfo);
    const cpu = this.profiler?.status();
    const cpuState = !this.config.hotCpu.enabled || !cpu || cpu.state === "stopped" ? "off" : cpu.state;
    const status: Omit<DiagnosticsStatus, "handoffText"> = {
      rootPath: this.rootPath,
      envOverrides: this.config.envOverrides,
      hotCpu: {
        enabled: this.config.hotCpu.enabled,
        state: cpuState,
        thresholdPercent: this.config.hotCpu.thresholdPercent,
        profilesWritten: this.hotCpuSession?.writtenCount("cpuprofile") ?? 0,
        maxProfiles: this.config.hotCpu.maxProfiles,
        lastCpuPercent: cpu?.lastCpuPercent ?? null,
      },
      heap: this.heap.status(),
      sessions,
      totalBytes: sessions.reduce((sum, session) => sum + session.bytes, 0),
    };
    return { ...status, handoffText: buildHandoffText(status, this.options.versions) };
  }

  /**
   * The folder to open for Settings → Reveal: the diagnostics root, or
   * one session by directory name. Anything else is refused, so the
   * renderer can't open an arbitrary path.
   */
  resolveRevealPath(sessionName?: unknown): string | null {
    if (sessionName === undefined || sessionName === null || sessionName === "") return this.rootPath;
    if (typeof sessionName !== "string" || !DIAGNOSTICS_SESSION_RE.test(sessionName)) return null;
    return Path.join(this.rootPath, sessionName);
  }

  async captureHeapSnapshot(): Promise<{ ok: boolean; message: string; path?: string }> {
    return this.heap.captureManualSnapshot();
  }

  async clear(): Promise<{ removed: number; bytesFreed: number }> {
    await this.sweep;
    const result = await clearDiagnostics(this.rootPath);
    this.heapSession.forget();
    this.hotCpuSession?.forget();
    this.setListing(result.kept);
    const bytesFreed = result.removed.reduce((sum, session) => sum + session.bytes, 0);
    if (result.removed.length > 0) {
      this.log("diagnostics", `deleted ${result.removed.length} session(s), ${Math.round(bytesFreed / MB)} MB, from Settings`);
    }
    return { removed: result.removed.length, bytesFreed };
  }

  private syncProfiler(restart: boolean): void {
    if (this.stopped) return;
    const wanted = this.config.hotCpu.enabled;
    if (this.profiler && (restart || !wanted)) {
      const previous = this.profiler;
      this.profiler = null;
      this.profilerQueue = this.profilerQueue.then(() => previous.stop("settings-changed"));
    }
    if (!wanted || this.profiler) return;
    if (this.hotCpuSession) {
      this.hotCpuSession.updateConfig({ ...this.config.hotCpu });
    } else {
      this.hotCpuSession = new DiagnosticsSession({
        outputRoot: this.rootPath,
        kind: "hot-cpu",
        config: { ...this.config.hotCpu },
        versions: this.options.versions,
        createdAt: new Date(this.now()),
      });
    }
    const profiler = new HotCpuProfiler({
      config: this.config.hotCpu,
      session: this.hotCpuSession,
      inspector: (this.options.createInspector ?? createMainInspector)(),
      readCpu: this.options.readCpu,
      now: this.options.now,
      log: this.log,
      onProfileWritten: () => this.afterCapture(),
    });
    this.profiler = profiler;
    // After the previous profiler has let go of its recording.
    this.profilerQueue = this.profilerQueue
      .then(() => profiler.start())
      .catch((error: unknown) => {
        this.log("hot-cpu", `failed to start: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private afterCapture(): void {
    this.listing = null;
    void this.runRetention();
  }

  /**
   * Changes whenever this launch commits an artifact, including ones
   * that don't call back (the near-limit dump), so a cached listing
   * never trails the profiler's and heap monitor's own counts.
   */
  private liveGeneration(): string {
    return `${this.heapSession.artifacts().length}/${this.hotCpuSession?.artifacts().length ?? 0}`;
  }

  private setListing(listing: SessionListing[], generation = this.liveGeneration()): void {
    this.listing = listing;
    this.listingGeneration = generation;
  }

  private async sessions(): Promise<SessionListing[]> {
    await this.sweep;
    if (this.listing && this.listingGeneration === this.liveGeneration()) return this.listing;
    // Read before listing: a commit during the listing forces another.
    const generation = this.liveGeneration();
    const listing = await listDiagnosticsSessions(this.rootPath);
    this.setListing(listing, generation);
    return listing;
  }

  private runRetention(): Promise<void> {
    this.sweep ??= (async () => {
      const generation = this.liveGeneration();
      try {
        const protect = new Set([this.heapSession.directoryName]);
        if (this.hotCpuSession) protect.add(this.hotCpuSession.directoryName);
        const result = await pruneDiagnostics(this.rootPath, {
          limits: this.options.retention ?? DEFAULT_RETENTION,
          now: this.now(),
          protect,
        });
        this.setListing(result.kept, generation);
        if (result.removed.length > 0) {
          const bytes = result.removed.reduce((sum, session) => sum + session.bytes, 0);
          const reasons = result.removed.map((session) => `${session.name} (${session.reason})`).join(", ");
          this.log("diagnostics", `retention removed ${Math.round(bytes / MB)} MB: ${reasons}`);
        }
      } catch (error) {
        this.log("diagnostics", `retention failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.sweep = null;
      }
    })();
    return this.sweep;
  }
}

function toSessionInfo(listing: SessionListing): DiagnosticsSessionInfo {
  const records = new Map((listing.manifest?.artifacts ?? []).map((record) => [record.filename, record]));
  const artifacts: DiagnosticsArtifactInfo[] = listing.files
    .filter((file) => !SESSION_BOOKKEEPING_FILES.has(file.name) && ARTIFACT_KINDS[Path.extname(file.name)])
    .map((file) => ({
      filename: file.name,
      path: Path.join(listing.path, file.name),
      kind: ARTIFACT_KINDS[Path.extname(file.name)],
      bytes: file.bytes,
      summary: records.get(file.name)?.summary ?? null,
    }))
    .sort((left, right) => left.filename.localeCompare(right.filename));
  return {
    name: listing.name,
    kind: listing.kind,
    path: listing.path,
    createdAt: listing.createdAtMs,
    bytes: listing.bytes,
    artifacts,
  };
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The text Settings → Diagnostics → Copy puts on the clipboard. */
export function buildHandoffText(
  status: Omit<DiagnosticsStatus, "handoffText">,
  versions: DiagnosticsVersions,
): string {
  const lines = [
    `DiskHound ${versions.appVersion} diagnostics (Electron ${versions.electronVersion}, Node ${versions.nodeVersion}, ${versions.platform} ${versions.arch})`,
    `Folder: ${status.rootPath}`,
  ];
  if (status.envOverrides.length > 0) lines.push(`Env: ${status.envOverrides.join(" ")}`);
  lines.push("");
  const withArtifacts = status.sessions.filter((session) => session.artifacts.length > 0);
  if (withArtifacts.length === 0) {
    lines.push("No captures yet.");
    return lines.join("\n");
  }
  for (const session of withArtifacts) {
    lines.push(`${session.name} (${formatSize(session.bytes)})`);
    for (const artifact of session.artifacts) {
      lines.push(`  ${artifact.path} (${formatSize(artifact.bytes)})${artifact.summary ? ` - ${artifact.summary}` : ""}`);
    }
  }
  const kinds = new Set(withArtifacts.flatMap((session) => session.artifacts.map((artifact) => artifact.kind)));
  lines.push("");
  if (kinds.has("cpuprofile")) {
    lines.push("Open .cpuprofile in Chrome DevTools (Performance > Load profile) or https://www.speedscope.app.");
  }
  if (kinds.has("heapprofile") || kinds.has("heapsnapshot")) {
    lines.push("Open .heapsnapshot and .heapprofile in Chrome DevTools (Memory > Load). For a gate pair, select B and compare it against A.");
  }
  return lines.join("\n");
}
