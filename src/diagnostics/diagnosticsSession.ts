import { randomBytes } from "node:crypto";
import * as FS from "node:fs/promises";
import * as FS_SYNC from "node:fs";
import * as Path from "node:path";

import type { DiagnosticsArtifactKind, DiagnosticsSessionKind } from "../shared/contracts";

/** `hot-cpu-2026-09-25-1412-a1b2c3`; the same shape as PwrAgnt's sessions. */
export const DIAGNOSTICS_SESSION_RE = /^(hot-cpu|heap)-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-[a-f0-9]{6}$/;
export const SESSION_MANIFEST_FILE = "session.json";
export const SESSION_SAMPLES_FILE = "samples.ndjson";
export const SESSION_EVENTS_FILE = "events.ndjson";
/** A session holding nothing but these has no capture in it. */
export const SESSION_BOOKKEEPING_FILES: ReadonlySet<string> = new Set([
  SESSION_MANIFEST_FILE,
  SESSION_SAMPLES_FILE,
  SESSION_EVENTS_FILE,
]);

/** Events held between captures. Older ones are dropped and counted. */
const MAX_PENDING_EVENTS = 200;

/**
 * main.ts's writeCrashLog. crash.log is buffered; `sync` appends before
 * returning, for a line that has to survive the process dying next.
 */
export type DiagnosticsLog = (tag: string, message: string, options?: { sync?: boolean }) => void;

export interface DiagnosticsVersions {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
}

export interface DiagnosticsEvent {
  capturedAt: string;
  type: string;
  detail?: Record<string, unknown>;
}

export interface DiagnosticsArtifactRecord {
  filename: string;
  kind: DiagnosticsArtifactKind;
  bytes: number;
  capturedAt: string;
  summary?: string;
  detail?: Record<string, unknown>;
}

export interface DiagnosticsSessionManifest {
  kind: DiagnosticsSessionKind;
  id: string;
  directoryName: string;
  createdAt: string;
  artifacts: DiagnosticsArtifactRecord[];
  config: Record<string, unknown>;
  versions: DiagnosticsVersions;
  droppedEvents?: number;
}

export function formatSessionPrefix(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** Local creation time encoded in a session name, or null if it isn't one. */
export function parseSessionCreatedAt(name: string): number | null {
  const match = DIAGNOSTICS_SESSION_RE.exec(name);
  if (!match) return null;
  const [, , year, month, day, hours, minutes] = match;
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes)).getTime();
}

export function sessionKindOf(name: string): DiagnosticsSessionKind | null {
  const match = DIAGNOSTICS_SESSION_RE.exec(name);
  return match ? (match[1] as DiagnosticsSessionKind) : null;
}

function ndjson(records: readonly unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

/**
 * One launch's worth of captures of one kind, in
 * `<outputRoot>/<kind>-<local time>-<id>/`.
 *
 * Nothing touches the disk until the first capture: the directory is
 * created by `prepare()`, and events and samples wait in memory until
 * `commit()` appends them next to the capture. A launch that never
 * captures leaves nothing behind, and a profiler ticking every 2 s
 * never writes per tick.
 */
export class DiagnosticsSession {
  readonly kind: DiagnosticsSessionKind;
  readonly id: string;
  readonly directoryName: string;
  readonly directoryPath: string;

  private readonly manifest: DiagnosticsSessionManifest;
  private prepared = false;
  private pendingEvents: DiagnosticsEvent[] = [];
  private droppedEvents = 0;
  private readonly nextIndexes = new Map<string, number>();
  private readonly writtenByKind = new Map<DiagnosticsArtifactKind, number>();

  constructor(options: {
    outputRoot: string;
    kind: DiagnosticsSessionKind;
    config: Record<string, unknown>;
    versions: DiagnosticsVersions;
    createdAt?: Date;
    sessionId?: string;
  }) {
    const createdAt = options.createdAt ?? new Date();
    this.kind = options.kind;
    this.id = options.sessionId ?? randomBytes(3).toString("hex");
    this.directoryName = `${options.kind}-${formatSessionPrefix(createdAt)}-${this.id}`;
    this.directoryPath = Path.join(options.outputRoot, this.directoryName);
    this.manifest = {
      kind: options.kind,
      id: this.id,
      directoryName: this.directoryName,
      createdAt: createdAt.toISOString(),
      artifacts: [],
      config: options.config,
      versions: options.versions,
    };
  }

  /** True once the directory has been created this launch. */
  get exists(): boolean {
    return this.prepared;
  }

  artifactPath(filename: string): string {
    return Path.join(this.directoryPath, filename);
  }

  /** 1, 2, 3… per prefix, so every capture this launch gets its own file. */
  allocateIndex(prefix: string): number {
    const next = (this.nextIndexes.get(prefix) ?? 0) + 1;
    this.nextIndexes.set(prefix, next);
    return next;
  }

  /** Artifacts of this kind committed this launch, including deleted ones. */
  writtenCount(kind: DiagnosticsArtifactKind): number {
    return this.writtenByKind.get(kind) ?? 0;
  }

  artifacts(): readonly DiagnosticsArtifactRecord[] {
    return this.manifest.artifacts;
  }

  /** Settings changed mid-launch; the next manifest write records the new config. */
  updateConfig(config: Record<string, unknown>): void {
    this.manifest.config = config;
  }

  /** Held in memory until the next commit. */
  recordEvent(event: DiagnosticsEvent): void {
    this.pendingEvents.push(event);
    if (this.pendingEvents.length > MAX_PENDING_EVENTS) {
      this.pendingEvents.shift();
      this.droppedEvents += 1;
    }
  }

  async prepare(): Promise<void> {
    if (this.prepared) return;
    await FS.mkdir(this.directoryPath, { recursive: true });
    this.prepared = true;
  }

  prepareSync(): void {
    if (this.prepared) return;
    FS_SYNC.mkdirSync(this.directoryPath, { recursive: true });
    this.prepared = true;
  }

  /**
   * Appends `samples` and every pending event, then rewrites
   * session.json with the new artifacts. Call once per capture, after
   * the artifact file itself is on disk.
   */
  async commit(update: { artifacts?: DiagnosticsArtifactRecord[]; samples?: readonly unknown[] } = {}): Promise<void> {
    await this.prepare();
    const writes = this.stage(update);
    if (writes.samples) await FS.appendFile(this.artifactPath(SESSION_SAMPLES_FILE), writes.samples, "utf8");
    if (writes.events) await FS.appendFile(this.artifactPath(SESSION_EVENTS_FILE), writes.events, "utf8");
    await FS.writeFile(this.artifactPath(SESSION_MANIFEST_FILE), writes.manifest, "utf8");
  }

  /** `commit` for a path that may not get another turn of the event loop. */
  commitSync(update: { artifacts?: DiagnosticsArtifactRecord[]; samples?: readonly unknown[] } = {}): void {
    this.prepareSync();
    const writes = this.stage(update);
    if (writes.samples) FS_SYNC.appendFileSync(this.artifactPath(SESSION_SAMPLES_FILE), writes.samples, "utf8");
    if (writes.events) FS_SYNC.appendFileSync(this.artifactPath(SESSION_EVENTS_FILE), writes.events, "utf8");
    FS_SYNC.writeFileSync(this.artifactPath(SESSION_MANIFEST_FILE), writes.manifest, "utf8");
  }

  /**
   * At quit: append events recorded since the last capture, but only to
   * a session that already has one. An idle launch writes nothing.
   */
  flushEventsSync(): void {
    if (!this.prepared || this.pendingEvents.length === 0) return;
    try {
      FS_SYNC.appendFileSync(this.artifactPath(SESSION_EVENTS_FILE), this.takeEvents(), "utf8");
    } catch {
      // Best effort at quit.
    }
  }

  /** The directory was deleted (Settings → Delete all); start over on the next capture. */
  forget(): void {
    this.prepared = false;
    this.manifest.artifacts = [];
  }

  private stage(update: { artifacts?: DiagnosticsArtifactRecord[]; samples?: readonly unknown[] }) {
    for (const artifact of update.artifacts ?? []) {
      this.manifest.artifacts.push(artifact);
      this.writtenByKind.set(artifact.kind, this.writtenCount(artifact.kind) + 1);
    }
    if (this.droppedEvents > 0) this.manifest.droppedEvents = this.droppedEvents;
    return {
      samples: ndjson(update.samples ?? []),
      events: this.takeEvents(),
      manifest: `${JSON.stringify(this.manifest, null, 2)}\n`,
    };
  }

  private takeEvents(): string {
    const text = ndjson(this.pendingEvents);
    this.pendingEvents = [];
    return text;
  }
}
