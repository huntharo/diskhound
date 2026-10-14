import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RemovalVolumeCheck } from "../../shared/agentRemovals";
import { RemovalQueue, RemovalQueueFullError, REMOVALS_PROTOCOL } from "../removalQueue";

const NOW = Date.UTC(2026, 9, 12, 12);
const DAY = 24 * 60 * 60_000;
const OK: RemovalVolumeCheck = { volume: "the startup disk", trash: "yes", readOnly: false, mountsInside: [], checkedAt: NOW };

let dir: string;
let file: string;
let now = NOW;

beforeEach(() => {
  dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-removal-queue-"));
  file = Path.join(dir, "agent-removals.json");
  now = NOW;
});

afterEach(() => {
  FS.rmSync(dir, { recursive: true, force: true });
});

function queue(options: ConstructorParameters<typeof RemovalQueue>[1] = {}) {
  return new RemovalQueue(file, { now: () => now, debounceMs: 60_000, platform: "linux", ...options });
}

function ask(q: RemovalQueue, sessionId: string, paths: string[], asked: "trash" | "delete" = "trash") {
  return q.add({
    sessionId,
    sessionName: sessionId === "s1" ? "Codex" : "Claude Code",
    roleName: "Cleanup Operator",
    asked,
    reason: `reason from ${sessionId}`,
    items: paths.map((path) => ({ path, sizeBytes: 1024, check: OK })),
  });
}

const onDisk = () => JSON.parse(FS.readFileSync(file, "utf8"));

describe("RemovalQueue", () => {
  it("adds a request with every item waiting, and survives a restart", async () => {
    const first = queue();
    const { request } = ask(first, "s1", ["/a", "/b"]);
    expect(request).toMatchObject({ sessionName: "Codex", asked: "trash", reason: "reason from s1", decidedAt: null });
    expect(request.items.map((item) => [item.path, item.status, item.asked])).toEqual([["/a", "waiting", "trash"], ["/b", "waiting", "trash"]]);
    expect(first.waitingCount()).toBe(2);
    await first.flush();
    expect(onDisk()).toMatchObject({ protocol: REMOVALS_PROTOCOL, version: 1, requests: [{ id: request.id }] });

    const second = queue();
    expect(second.list().requests).toEqual([request]);
  });

  it("reads nothing until something asks, and starts empty with no file", () => {
    const q = queue();
    expect(q.loaded).toBe(false);
    expect(q.list()).toEqual({ requests: [], running: false });
    expect(q.loaded).toBe(true);
  });

  it("moves a path the same session asks for again into the newer request", () => {
    const q = queue();
    const first = ask(q, "s1", ["/a", "/b"]);
    const again = ask(q, "s1", ["/b", "/c"], "delete");
    expect(again.replaced).toBe(1);
    const { requests } = q.list();
    expect(requests.map((request) => request.items.map((item) => item.path))).toEqual([["/a"], ["/b", "/c"]]);
    expect(requests[1]!.items[0]!.asked).toBe("delete");
    // Another session asking for the same path gets its own item.
    ask(q, "s2", ["/a"]);
    expect(q.waitingCount()).toBe(4);
    // A request emptied by a re-ask disappears.
    ask(q, "s1", ["/a"], "delete");
    expect(q.list().requests.map((request) => request.id)).not.toContain(first.request.id);
  });

  it("changes nothing when a session repeats a waiting request exactly", () => {
    let changes = 0;
    const q = queue({ onChange: () => changes++ });
    const first = ask(q, "s1", ["/a", "/b"]).request;
    const again = ask(q, "s1", ["/b", "/a"]);
    expect(again).toMatchObject({ request: { id: first.id }, replaced: 2 });
    expect(changes).toBe(1);
    // A different action, a subset or another session is a change.
    expect(ask(q, "s1", ["/a"]).request.id).not.toBe(first.id);
    expect(changes).toBe(2);
  });

  it("compares paths without case on macOS and Windows", () => {
    const q = queue({ platform: "darwin" });
    ask(q, "s1", ["/Users/Me/Build"]);
    expect(ask(q, "s1", ["/users/me/build"]).replaced).toBe(1);
  });

  it("refuses past the waiting cap and keeps what was there", () => {
    const q = queue({ maxWaitingItems: 3 });
    ask(q, "s1", ["/a", "/b"]);
    expect(() => ask(q, "s2", ["/c", "/d"])).toThrow(RemovalQueueFullError);
    expect(() => ask(q, "s2", ["/c", "/d"])).toThrow("already has 2 items waiting");
    expect(q.waitingCount()).toBe(2);
    // Re-asking for a waiting path doesn't count it twice.
    expect(ask(q, "s1", ["/a", "/b", "/c"]).request.items).toHaveLength(3);
  });

  it("loses nothing when a re-ask is refused at the cap", () => {
    const q = queue({ maxWaitingItems: 2 });
    ask(q, "s1", ["/a", "/b"]);
    expect(() => ask(q, "s1", ["/a", "/c", "/d"])).toThrow(RemovalQueueFullError);
    expect(q.list().requests.map((request) => request.items.map((item) => item.path))).toEqual([["/a", "/b"]]);
    expect(q.waitingCount()).toBe(2);
  });

  it("decides items one at a time and stamps the request when the last one is decided", () => {
    const q = queue();
    const { request } = ask(q, "s1", ["/a", "/b"]);
    const [a, b] = request.items;
    q.decide(a!.id, "moved", { action: "trash", message: "Moved to the Trash.", at: now });
    expect(q.list().requests[0]!.decidedAt).toBeNull();
    now += 1000;
    q.decide(b!.id, "skipped", { action: null, message: "You skipped it.", at: now });
    expect(q.list().requests[0]).toMatchObject({ decidedAt: now, items: [{ status: "moved" }, { status: "skipped" }] });
    // A decided item stays decided.
    q.decide(a!.id, "failed", { action: null, message: "x", at: now });
    expect(q.find(a!.id)?.item.status).toBe("moved");
    expect(q.waitingCount()).toBe(0);
  });

  it("shows running items in the list but never writes them", async () => {
    const q = queue();
    const { request } = ask(q, "s1", ["/a"]);
    q.setRunning([request.items[0]!.id], true);
    expect(q.list()).toMatchObject({ running: true, requests: [{ items: [{ status: "running" }] }] });
    await q.flush();
    expect(onDisk().requests[0].items[0].status).toBe("waiting");
  });

  it("updates the check of a waiting item only", () => {
    const q = queue();
    const { request } = ask(q, "s1", ["/a"]);
    const changed: RemovalVolumeCheck = { ...OK, trash: "no", trashWhy: "No Trash.", checkedAt: now + 1 };
    q.updateCheck(request.items[0]!.id, changed);
    expect(q.find(request.items[0]!.id)?.item.check).toEqual(changed);
  });

  it("keeps decided requests a week and at most 50, dropping them at the next write", async () => {
    const q = queue();
    for (let i = 0; i < 55; i++) {
      const { request } = ask(q, "s1", [`/p${i}`]);
      q.decide(request.items[0]!.id, "skipped", { action: null, message: "You skipped it.", at: now + i });
    }
    const old = ask(q, "s2", ["/old"]).request;
    q.decide(old.items[0]!.id, "skipped", { action: null, message: "You skipped it.", at: now - 8 * DAY });
    ask(q, "s2", ["/still-waiting"]);
    await q.flush();
    const kept = onDisk().requests as { decidedAt: number | null; items: { path: string }[] }[];
    expect(kept.filter((request) => request.decidedAt !== null)).toHaveLength(50);
    expect(kept.flatMap((request) => request.items.map((item) => item.path))).not.toContain("/old");
    expect(kept.flatMap((request) => request.items.map((item) => item.path))).toContain("/still-waiting");
  });

  it("drops entries it can't read, and starts empty on a file it doesn't know", () => {
    FS.writeFileSync(file, JSON.stringify({
      protocol: REMOVALS_PROTOCOL,
      version: 1,
      requests: [
        { id: "rq_bad" },
        {
          id: "rq_ok", sessionId: "s1", sessionName: "Codex", roleName: "Cleanup Operator", asked: "trash", reason: null,
          requestedAt: NOW, decidedAt: null,
          items: [
            { id: "it_ok", path: "/a", asked: "trash", sizeBytes: 1, status: "waiting", check: OK },
            { id: "it_bad", path: "/b", asked: "shred", sizeBytes: 1, status: "waiting", check: OK },
          ],
        },
      ],
    }));
    expect(queue().list().requests.map((request) => request.items.map((item) => item.id))).toEqual([["it_ok"]]);
    FS.writeFileSync(file, "{ not json");
    const logged: string[] = [];
    expect(queue({ log: (message) => logged.push(message) }).list().requests).toEqual([]);
    expect(logged[0]).toContain("couldn't read");
  });

  it("holds writes during a batch and writes once at its end", async () => {
    const q = queue({ debounceMs: 0 });
    const { request } = ask(q, "s1", ["/a", "/b", "/c"]);
    await q.flush();
    const before = FS.statSync(file).mtimeMs;
    let writesDuring = 0;
    await q.batch(async () => {
      for (const item of request.items) {
        q.decide(item.id, "moved", { action: "trash", message: "Moved.", at: now });
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (FS.statSync(file).mtimeMs !== before) writesDuring++;
      }
    });
    expect(writesDuring).toBe(0);
    expect(onDisk().requests[0].items.map((item: { status: string }) => item.status)).toEqual(["moved", "moved", "moved"]);
  });

  it("tells its owner about every change", () => {
    let changes = 0;
    const q = queue({ onChange: () => changes++ });
    const { request } = ask(q, "s1", ["/a"]);
    q.setRunning([request.items[0]!.id], true);
    q.decide(request.items[0]!.id, "moved", { action: "trash", message: "Moved.", at: now });
    expect(changes).toBe(3);
  });
});
