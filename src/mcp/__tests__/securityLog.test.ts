import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSecurityEvent } from "../../shared/agentAccess";
import { AgentSecurityLog, type SecurityEventInput } from "../securityLog";

let dir: string;
let file: string;
let clock: number;
let seen: { event: AgentSecurityEvent; repeated: boolean; logged: boolean }[];

function event(overrides: Partial<SecurityEventInput> = {}): SecurityEventInput {
  return {
    sessionId: "session_1",
    sessionName: "Codex",
    roleName: "Cleanup Guide",
    kind: "tool_not_allowed",
    tool: "diskhound_delete_permanently",
    detail: "Tried to delete items permanently; Cleanup Guide doesn't allow it.",
    ...overrides,
  };
}

function open(): AgentSecurityLog {
  return new AgentSecurityLog({
    file,
    now: () => clock,
    onEvent: (e, info) => seen.push({ event: e, ...info }),
  });
}

function lines(): AgentSecurityEvent[] {
  return FS.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as AgentSecurityEvent);
}

beforeEach(() => {
  dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-security-log-"));
  file = Path.join(dir, "agent-security.log");
  clock = 1_000_000;
  seen = [];
});

afterEach(() => {
  vi.useRealTimers();
  FS.rmSync(dir, { recursive: true, force: true });
});

describe("AgentSecurityLog", () => {
  it("counts an identical refusal within a minute instead of adding an event", () => {
    const log = open();
    log.record(event());
    clock += 30_000;
    log.record(event());
    log.record(event({ detail: "Something else" }));
    const [other, repeat] = log.recent();
    expect(repeat).toMatchObject({ count: 2, at: clock });
    expect(other).toMatchObject({ count: 1, detail: "Something else" });
    expect(seen.map((s) => [s.repeated, s.event.count])).toEqual([[false, 1], [true, 2], [false, 1]]);
  });

  it("starts a new event once a minute has passed", () => {
    const log = open();
    log.record(event());
    clock += 61_000;
    log.record(event());
    expect(log.recent().map((e) => e.count)).toEqual([1, 1]);
  });

  it("keeps a different session's refusal separate", () => {
    const log = open();
    log.record(event());
    log.record(event({ sessionId: "session_2", sessionName: "Claude Code" }));
    expect(log.recent()).toHaveLength(2);
  });

  it("appends NDJSON readable only by the user, and a later run loads it newest first", async () => {
    const log = open();
    log.record(event());
    clock += 1;
    log.record(event({ kind: "protected_path", tool: "diskhound_move_to_trash", detail: "Asked to trash /System" }));
    await log.flush();
    expect(lines().map((e) => e.tool)).toEqual(["diskhound_delete_permanently", "diskhound_move_to_trash"]);
    if (process.platform !== "win32") expect(FS.statSync(file).mode & 0o777).toBe(0o600);

    const next = open();
    expect((await next.list()).map((e) => e.tool)).toEqual(["diskhound_move_to_trash", "diskhound_delete_permanently"]);
  });

  it("writes a repeat's new count after the first line was flushed, and loads the higher count", async () => {
    const log = open();
    log.record(event());
    await log.flush();
    clock += 10_000;
    log.record(event());
    log.record(event());
    await log.flush();
    expect(lines().map((e) => e.count)).toEqual([1, 3]);
    const loaded = await open().list();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ count: 3 });
  });

  it("merges what is on disk with what this run recorded before the first read", async () => {
    FS.writeFileSync(file, `${JSON.stringify({ ...event(), id: "old", at: 5, count: 4 })}\n{"torn`);
    const log = open();
    log.record(event({ detail: "new" }));
    expect((await log.list()).map((e) => [e.id === "old" ? "old" : "new", e.count])).toEqual([["new", 1], ["old", 4]]);
  });

  it("returns nothing for a missing file", async () => {
    expect(await open().list()).toEqual([]);
  });

  it("rotates the file past 256 KB", async () => {
    const log = open();
    FS.writeFileSync(file, "x".repeat(256 * 1024 - 10));
    log.record(event());
    await log.flush();
    expect(FS.existsSync(`${file}.1`)).toBe(true);
    expect(lines()).toHaveLength(1);
  });

  it("writes at most 60 lines an hour, then resumes", async () => {
    const log = open();
    for (let i = 0; i < 70; i++) log.record(event({ detail: `path ${i}` }));
    await log.flush();
    expect(lines()).toHaveLength(60);
    expect(seen.filter((s) => s.logged)).toHaveLength(60);
    expect(log.recent()).toHaveLength(70);

    clock += 60 * 60_000;
    log.record(event({ detail: "after an hour" }));
    await log.flush();
    expect(lines()).toHaveLength(61);
  });

  it("appends 2 s after a quiet spell, then no more than once every 5 minutes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const log = open();
    log.record(event({ detail: "first" }));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FS.existsSync(file)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await log.flush();
    expect(lines()).toHaveLength(1);

    clock += 10_000;
    log.record(event({ detail: "second" }));
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(lines()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await log.flush();
    expect(lines()).toHaveLength(2);
  });

  it("still records when the listener throws", () => {
    const log = new AgentSecurityLog({ file, onEvent: () => { throw new Error("window closed"); } });
    expect(() => log.record(event())).not.toThrow();
    expect(log.recent()).toHaveLength(1);
  });
});
