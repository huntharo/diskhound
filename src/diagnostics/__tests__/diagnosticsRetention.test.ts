import * as FS from "node:fs/promises";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { clearDiagnostics, listDiagnosticsSessions, pruneDiagnostics } from "../diagnosticsRetention";
import { formatSessionPrefix } from "../diagnosticsSession";
import { tempDir } from "./diagnosticsTestKit";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const NOW = new Date(2026, 8, 25, 12, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

async function root(): Promise<string> {
  const dir = await tempDir();
  cleanups.push(dir.cleanup);
  return dir.path;
}

let counter = 0;
/** A session `ageDays` old holding `files` (name → bytes). */
async function addSession(dir: string, kind: "hot-cpu" | "heap", ageDays: number, files: Record<string, number>): Promise<string> {
  const id = (0xa00000 + counter++).toString(16);
  const name = `${kind}-${formatSessionPrefix(new Date(NOW - ageDays * DAY))}-${id}`;
  await FS.mkdir(Path.join(dir, name));
  for (const [file, bytes] of Object.entries(files)) {
    await FS.writeFile(Path.join(dir, name, file), Buffer.alloc(bytes));
  }
  return name;
}

describe("diagnostics retention", () => {
  it("lists sessions newest first and ignores everything that isn't one", async () => {
    const dir = await root();
    const older = await addSession(dir, "hot-cpu", 3, { "main-hot-0001.cpuprofile": 10 });
    const newer = await addSession(dir, "heap", 1, { "main-gate-0001.heapprofile": 20, "session.json": 2 });
    await FS.writeFile(Path.join(dir, "heap-gate-state.json"), "{}");
    await FS.mkdir(Path.join(dir, "my-notes"));
    await FS.writeFile(Path.join(dir, "hot-cpu-2026-09-25-1200-abcdef"), "a file, not a session");

    const sessions = await listDiagnosticsSessions(dir);
    expect(sessions.map((session) => session.name)).toEqual([newer, older]);
    expect(sessions[0]).toMatchObject({ kind: "heap", bytes: 22 });
  });

  it("removes empty sessions and expired ones, but never this launch's", async () => {
    const dir = await root();
    const empty = await addSession(dir, "hot-cpu", 1, { "session.json": 5, "events.ndjson": 5 });
    const expired = await addSession(dir, "heap", 31, { "main-gate-0001.heapprofile": 5 });
    const current = await addSession(dir, "hot-cpu", 0, { "session.json": 5 });
    const kept = await addSession(dir, "heap", 2, { "main-manual-0001.heapsnapshot": 5 });

    const result = await pruneDiagnostics(dir, { now: NOW, protect: new Set([current]) });
    expect(result.removed).toEqual([
      { name: empty, bytes: 10, reason: "empty" },
      { name: expired, bytes: 5, reason: "age" },
    ]);
    expect((await FS.readdir(dir)).sort()).toEqual([current, kept].sort());
  });

  it("keeps the newest sessions under the count cap, then under the byte cap", async () => {
    const dir = await root();
    const names = [];
    for (let age = 10; age >= 1; age -= 1) {
      names.push(await addSession(dir, "hot-cpu", age, { "main-hot-0001.cpuprofile": age === 1 ? 700 : 100 }));
    }
    // names[0] is the oldest (10 days), names[9] the newest (700 bytes).
    const result = await pruneDiagnostics(dir, {
      now: NOW,
      limits: { maxSessions: 6, maxTotalBytes: 1_000, maxAgeMs: 30 * DAY },
    });
    expect(result.removed.map((entry) => [entry.name, entry.reason])).toEqual([
      [names[0], "count"], [names[1], "count"], [names[2], "count"], [names[3], "count"],
      [names[4], "bytes"], [names[5], "bytes"],
    ]);
    expect(result.kept.map((session) => session.name)).toEqual([names[9], names[8], names[7], names[6]]);
  });

  it("keeps a protected session even when it alone is over the byte cap", async () => {
    const dir = await root();
    const old = await addSession(dir, "heap", 3, { "main-gate-0001-a.heapsnapshot": 500 });
    const current = await addSession(dir, "heap", 0, { "main-gate-0001-a.heapsnapshot": 2_000 });
    const result = await pruneDiagnostics(dir, {
      now: NOW,
      protect: new Set([current]),
      limits: { maxSessions: 12, maxTotalBytes: 1_000, maxAgeMs: 30 * DAY },
    });
    expect(result.removed.map((entry) => entry.name)).toEqual([old]);
    expect(result.kept.map((session) => session.name)).toEqual([current]);
  });

  it("clears every session and nothing else", async () => {
    const dir = await root();
    await addSession(dir, "hot-cpu", 1, { "main-hot-0001.cpuprofile": 10 });
    await addSession(dir, "heap", 2, { "main-gate-0001.heapprofile": 30 });
    await FS.writeFile(Path.join(dir, "heap-gate-state.json"), "{}");
    const result = await clearDiagnostics(dir);
    expect(result.removed.map((entry) => entry.bytes).sort()).toEqual([10, 30]);
    expect(await FS.readdir(dir)).toEqual(["heap-gate-state.json"]);
  });

  it("treats a missing diagnostics folder as empty", async () => {
    const dir = await root();
    expect(await pruneDiagnostics(Path.join(dir, "missing"), { now: NOW })).toEqual({ removed: [], kept: [] });
  });
});
