import * as FS from "node:fs/promises";

import type { AgentSecurityEvent } from "../shared/agentAccess";

/** Identical events inside this window bump a count instead of adding a line. */
const COALESCE_MS = 60_000;
/** Bursts (one Trash request naming 20 protected folders) become one append. */
const FLUSH_MS = 2_000;
/**
 * After an append, the next waits at least this long, so an agent that
 * keeps getting refused costs at most 288 appends a day. Settings shows
 * each refusal live either way; only the file lags.
 */
const MIN_APPEND_GAP_MS = 5 * 60_000;
/** Rotate to `<file>.1` past this size, so loading the log stays cheap. */
const MAX_BYTES = 256 * 1024;
/** Events kept in memory for Settings, newest first. */
const LIMIT = 200;
/** Lines per hour that reach disk; a looping agent can't fill the SSD. */
const MAX_LINES_PER_HOUR = 60;

export type SecurityEventInput = Omit<AgentSecurityEvent, "id" | "at" | "count">;

export interface AgentSecuritySink {
  record(event: SecurityEventInput): void;
}

/**
 * What agents tried that their session doesn't allow: a tool their role
 * doesn't grant (hidden from their tool list, so calling it means a stale
 * list or a guess), or a Trash / delete request naming a folder agents
 * may never remove.
 *
 * Kept in `agent-security.log` (NDJSON, 0600) so it survives restarts,
 * and in memory for Settings → AI Agents. Writes only happen when an
 * agent is refused; see securityLog.ioBudget.test.ts for the
 * counts.
 */
export class AgentSecurityLog implements AgentSecuritySink {
  private events: AgentSecurityEvent[] = [];
  private loaded: Promise<void> | null = null;
  private queued: AgentSecurityEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private bytesOnDisk: number | null = null;
  private seq = 0;
  private hourStart = -Infinity;
  private linesThisHour = 0;
  private lastAppendAt = -Infinity;

  constructor(private readonly options: {
    file: string;
    /**
     * Called for every new event and every repeat. `logged` says whether
     * it went to the file (the hourly cap wasn't reached), so a mirror
     * in crash.log can follow the same cap.
     */
    onEvent?: (event: AgentSecurityEvent, info: { repeated: boolean; logged: boolean }) => void;
    now?: () => number;
    flushMs?: number;
  }) {}

  get filePath(): string {
    return this.options.file;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  record(input: SecurityEventInput): void {
    const now = this.now();
    const same = this.events.find((event) =>
      now - event.at < COALESCE_MS &&
      event.sessionId === input.sessionId &&
      event.kind === input.kind &&
      event.tool === input.tool &&
      event.detail === input.detail,
    );
    if (same) {
      same.count += 1;
      same.at = now;
      this.events = [same, ...this.events.filter((event) => event !== same)];
      // A queued line is this same object, so it goes out with the new
      // count. One already on disk gets a newer line with the same id;
      // load() keeps the last.
      const logged = this.queued.includes(same) || this.enqueue(same, now);
      this.notify(same, { repeated: true, logged });
      return;
    }
    const event: AgentSecurityEvent = { ...input, id: `security-${now}-${++this.seq}`, at: now, count: 1 };
    this.events.unshift(event);
    if (this.events.length > LIMIT) this.events.length = LIMIT;
    const logged = this.enqueue(event, now);
    this.notify(event, { repeated: false, logged });
  }

  private enqueue(event: AgentSecurityEvent, now: number): boolean {
    if (now - this.hourStart >= 60 * 60_000) {
      this.hourStart = now;
      this.linesThisHour = 0;
    }
    if (this.linesThisHour >= MAX_LINES_PER_HOUR) return false;
    this.linesThisHour += 1;
    this.queued.push(event);
    this.schedule(now);
    return true;
  }

  private notify(event: AgentSecurityEvent, info: { repeated: boolean; logged: boolean }): void {
    try {
      this.options.onEvent?.({ ...event }, info);
    } catch {
      // The window may be closing; a refusal must still be refused.
    }
  }

  private schedule(now: number): void {
    if (this.timer) return;
    const delay = Math.max(this.options.flushMs ?? FLUSH_MS, this.lastAppendAt + MIN_APPEND_GAP_MS - now);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
    this.timer.unref?.();
  }

  /** Newest first, including what earlier runs of DiskHound logged. */
  async list(): Promise<AgentSecurityEvent[]> {
    this.loaded ??= this.load();
    await this.loaded;
    return this.events.map((event) => ({ ...event }));
  }

  /** Events recorded in memory so far, without reading the file. */
  recent(): AgentSecurityEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  private async load(): Promise<void> {
    let text: string;
    try {
      text = await FS.readFile(this.options.file, "utf8");
    } catch {
      return;
    }
    this.bytesOnDisk = Buffer.byteLength(text);
    const onDisk: AgentSecurityEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as AgentSecurityEvent;
        if (typeof event.id === "string" && typeof event.at === "number" && typeof event.detail === "string") {
          onDisk.push({ ...event, count: typeof event.count === "number" ? event.count : 1 });
        }
      } catch {
        /* a torn last line after a crash */
      }
    }
    // A repeat's later line (same id, higher count) replaces the first.
    const latest = new Map<string, AgentSecurityEvent>();
    for (const event of onDisk) latest.set(event.id, event);
    const known = new Set(this.events.map((event) => event.id));
    const older = [...latest.values()].filter((event) => !known.has(event.id));
    this.events = [...this.events, ...older].sort((a, b) => b.at - a.at).slice(0, LIMIT);
  }

  /** Append what's queued. Called on a short timer and at quit. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.queued;
    this.queued = [];
    if (batch.length === 0) return this.writing;
    this.lastAppendAt = this.now();
    const data = batch.map((event) => JSON.stringify(event)).join("\n") + "\n";
    this.writing = this.writing.then(async () => {
      try {
        if (this.bytesOnDisk === null) {
          this.bytesOnDisk = await FS.stat(this.options.file).then((stat) => stat.size, () => 0);
        }
        if (this.bytesOnDisk + Buffer.byteLength(data) > MAX_BYTES) {
          await FS.rename(this.options.file, `${this.options.file}.1`).catch(() => undefined);
          this.bytesOnDisk = 0;
        }
        await FS.appendFile(this.options.file, data, { encoding: "utf8", mode: 0o600 });
        this.bytesOnDisk += Buffer.byteLength(data);
      } catch {
        // Losing a log line must never break the refusal itself.
      }
    });
    return this.writing;
  }
}
