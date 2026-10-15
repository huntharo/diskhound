import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { RemovalVolumeCheck } from "../../shared/agentRemovals";
import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { RemovalQueue } from "../removalQueue";

vi.mock("node:fs", async (original) => (await import("../../test/ioBudget")).instrumentFs(await original()));
vi.mock("node:fs/promises", async (original) => (await import("../../test/ioBudget")).instrumentFsPromises(await original()));

// agent-removals.json is written when an agent's request arrives, when
// the user decides, and when a re-check finds a volume changed. Never on
// a timer, so the monitoring interval doesn't touch it. A week of a busy
// agent's history (the most the file keeps) is the fixture.

const NOW = Date.UTC(2026, 9, 12, 12);
const DEBOUNCE_MS = 10;
const OK: RemovalVolumeCheck = { volume: "the startup disk", trash: "yes", readOnly: false, mountsInside: [], checkedAt: NOW };
let dir: string;
let file: string;

const settle = () => new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 4));

function open(): RemovalQueue {
  return new RemovalQueue(file, { now: () => NOW, debounceMs: DEBOUNCE_MS, platform: "linux" });
}

function request(queue: RemovalQueue, label: string, count = 20) {
  return queue.add({
    sessionId: `session_${label.length % 3}`,
    sessionName: "Claude Code — cleanup",
    roleName: "Cleanup Admin",
    asked: "trash",
    reason: "Build output and caches from projects you haven't opened since March.",
    items: Array.from({ length: count }, (_, i) => ({
      path: `/Users/sam/github/project-${label}-${i}/node_modules/.pnpm/some-package@1.2.3/node_modules`,
      sizeBytes: 123_456_789,
      check: OK,
      // Device, inode and creation time, as the host records them.
      fileId: `16777232:${48_000_000 + i}:1760000000123456789`,
    })),
  }).request;
}

beforeEach(async () => {
  dir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-removals-io-"));
  file = Path.join(dir, "agent-removals.json");
  // A week of history: 50 decided requests of 20 items, and 2 waiting.
  const seed = open();
  for (let i = 0; i < 50; i++) {
    const { items } = request(seed, `old${i}`);
    for (const item of items) seed.decide(item.id, "moved", { action: "trash", message: "Moved to the Trash.", at: NOW - i * 3_600_000 });
  }
  request(seed, "waiting-a");
  request(seed, "waiting-b");
  await seed.flush();
});

afterEach(async () => {
  await FSP.rm(dir, { recursive: true, force: true });
});

function budget(scenario: string, io: Awaited<ReturnType<typeof measureFsIo>>["io"], detail: string, perDay: number) {
  const size = `${(FS.statSync(file).size / 1e3).toFixed(0)} KB`;
  const projection = io.writeFile === 0
    ? `No writes, at the default or the 1-minute monitoring interval (the file is ${size} with a week of a busy agent's history).`
    : `Written only when an agent asks or the user decides, never on a timer, so the default and the 1-minute monitoring `
      + `interval cost the same. At ${perDay} a day: ${perDay * io.writeFile} write${perDay * io.writeFile === 1 ? "" : "s"}/day, `
      + `${((perDay * io.bytesWritten) / 1e6).toFixed(1)} MB/day of rewritten content with a week of a busy agent's history `
      + `(a ${size} file; a light week is a tenth of that). Each write is a temp file and a rename.`;
  expectIoBudget({ scenario, io, note: `${detail} ${projection}` });
}

it("reads the list once, then answers from memory", async () => {
  const queue = open();
  const { io } = await measureFsIo(() => {
    for (let i = 0; i < 20; i++) {
      queue.list();
      queue.waitingCount();
      queue.forSession("session_1");
    }
  });
  expect(queue.waitingCount()).toBe(40);
  budget("agent-removals-load", io, "First use in a run reads agent-removals.json once; 20 more reads of the list, the count and one session's requests read nothing.", 0);
});

it("writes one agent request once", async () => {
  const queue = open();
  queue.list();
  const { io } = await measureFsIo(async () => {
    request(queue, "new");
    await settle();
  });
  budget("agent-removals-request", io, "An agent asks to move 20 items to the Trash: one replacement of the file after the debounce. Projected as 20 requests a day, a heavy cleanup day.", 20);
});

it("writes a burst of requests once", async () => {
  const queue = open();
  queue.list();
  const { io } = await measureFsIo(async () => {
    for (let i = 0; i < 5; i++) request(queue, `burst${i}`, 4);
    await settle();
  });
  budget("agent-removals-burst", io, "Five requests inside the 500 ms debounce: one replacement. Projected as 4 bursts a day.", 4);
});

it("writes nothing when an agent repeats a request", async () => {
  const queue = open();
  const waiting = queue.list().requests.find((r) => r.decidedAt === null)!;
  const { io } = await measureFsIo(async () => {
    for (let i = 0; i < 20; i++) {
      queue.add({
        sessionId: waiting.sessionId,
        sessionName: waiting.sessionName,
        roleName: waiting.roleName,
        asked: waiting.asked,
        reason: waiting.reason,
        items: waiting.items.map((item) => ({ path: item.path, sizeBytes: item.sizeBytes, check: OK, fileId: item.fileId })),
      });
    }
    await settle();
  });
  budget("agent-removals-repeat", io, "An agent repeats a waiting request 20 times (a retry loop). New paths stop at the 500-item waiting cap, so an agent left looping can't keep rewriting the file.", 0);
});

it("writes an approval once, however many items it decides", async () => {
  const queue = open();
  const waiting = queue.list().requests.flatMap((r) => r.items.filter((item) => item.status === "waiting"));
  const { io } = await measureFsIo(() => queue.batch(async () => {
    for (const item of waiting) {
      queue.setRunning([item.id], true);
      await new Promise((resolve) => setTimeout(resolve, 1));
      queue.decide(item.id, "moved", { action: "trash", message: "Moved to the Trash.", at: NOW });
    }
  }));
  expect(queue.waitingCount()).toBe(0);
  budget("agent-removals-approve", io, "The user approves 40 waiting items: decisions are held during the run and written once at its end. Projected as 5 approvals a day.", 5);
});

it("writes a request still in its debounce once at quit, before quit returns", async () => {
  const queue = open();
  queue.list();
  const { io } = await measureFsIo(() => {
    request(queue, "last");
    // Electron's before-quit is synchronous: the write finishes here.
    queue.flushSync();
  });
  const written = JSON.parse(FS.readFileSync(file, "utf8")) as { requests: { items: { path: string }[] }[] };
  expect(written.requests.some((r) => r.items.some((item) => item.path.includes("project-last-")))).toBe(true);
  budget("agent-removals-quit-pending", io, "An agent asks, and the user quits inside the 500 ms debounce: one synchronous replacement in before-quit. At most once per quit; projected as 1 a day.", 1);
});

it("writes nothing at quit when nothing changed", async () => {
  const queue = open();
  queue.list();
  const { io } = await measureFsIo(() => queue.dispose());
  budget("agent-removals-quit-clean", io, "Quit with no change since the last write.", 1);
});
