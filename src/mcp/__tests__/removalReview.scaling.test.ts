import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { BUILT_IN_MCP_ROLES, type McpAgentSession } from "../../shared/agentAccess";
import type { RemovalVolumeCheck } from "../../shared/agentRemovals";
import { reviewGroups } from "../../renderer/lib/removalReview";
import { expectNearLinear, measureOps } from "../../testing/opCounter";
import { RemovalQueue } from "../removalQueue";
import { RemovalReview, removalUnits } from "../removalReview";

// Every loop over the review list's items, at N and 8N items: the
// queue's add, list and per-session read, an approval, the split around
// a mounted volume, and the sheet's rows. Counts operations, not time.

const NOW = Date.UTC(2026, 9, 12, 12);
const OK: RemovalVolumeCheck = { volume: "the startup disk", trash: "yes", readOnly: false, mountsInside: [], checkedAt: NOW };
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) FS.rmSync(dir, { recursive: true, force: true });
});

/** A queue holding `count` waiting items from 4 sessions, 20 per request. */
function filledQueue(count: number): RemovalQueue {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-removal-scaling-"));
  dirs.push(dir);
  const queue = new RemovalQueue(Path.join(dir, "agent-removals.json"), {
    now: () => NOW,
    debounceMs: 3_600_000,
    platform: "linux",
    maxWaitingItems: Number.MAX_SAFE_INTEGER,
  });
  return queue;
}

function add(queue: RemovalQueue, count: number): void {
  for (let start = 0; start < count; start += 20) {
    queue.add({
      sessionId: `s${(start / 20) % 4}`,
      sessionName: `Agent ${(start / 20) % 4}`,
      roleName: "Cleanup Admin",
      asked: start % 40 === 0 ? "trash" : "delete",
      reason: null,
      items: Array.from({ length: Math.min(20, count - start) }, (_, i) => ({ path: `/work/p${start + i}`, sizeBytes: 1000, check: OK })),
    });
  }
}

describe("review list scaling", () => {
  it("adds, lists and reads one session's requests in linear work", async () => {
    const run = async (count: number) => {
      const queue = filledQueue(count);
      queue.list();
      const { ops } = await measureOps(() => {
        add(queue, count);
        // Every one asked again: each re-ask finds its earlier item directly.
        add(queue, count);
        expect(queue.waitingCount()).toBe(count);
        expect(queue.list().requests.length).toBe(count / 20);
        expect(queue.forSession("s1").length).toBe(count / 80);
      });
      return ops;
    };
    const n = 160;
    expectNearLinear("RemovalQueue add/list", await run(n), await run(n * 8), { maxTotal: n * 8 * 400 });
  });

  it("approves every item in linear work", async () => {
    const run = async (count: number) => {
      const queue = filledQueue(count);
      add(queue, count);
      const decisions = queue.list().requests.flatMap((request) =>
        request.items.map((item, i) => ({ itemId: item.id, run: i % 5 !== 0, action: request.asked })));
      const capabilities = BUILT_IN_MCP_ROLES.find((role) => role.id === "builtin.admin")!.permissions;
      const review = new RemovalReview({
        queue,
        check: async (items) => items.map(() => OK),
        canonicalTarget: async (path) => ({ path, fileId: "1:1" }),
        protection: async () => () => null,
        sessions: () => (id) => ({ name: id, roleName: "Cleanup Admin", capabilities }),
        trashPath: async () => ({ ok: true, message: "ok" }),
        deletePath: async () => ({ ok: true, message: "ok" }),
        listDir: async () => [],
        platform: "linux",
        now: () => NOW,
      });
      const { ops, result } = await measureOps(() => review.approve(decisions));
      expect(result.result.skipped).toBe(count / 5);
      return ops;
    };
    const n = 160;
    expectNearLinear("RemovalReview.approve", await run(n), await run(n * 8), { maxTotal: n * 8 * 400 });
  });

  it("splits a folder around a mount in linear work as its siblings grow", async () => {
    const run = async (count: number) => {
      const names = Array.from({ length: count }, (_, i) => `entry-${i}`);
      const { ops, result } = await measureOps(() =>
        removalUnits("/d", ["/d/entry-0/mnt"], async (path) => (path === "/d" ? names : ["mnt", ...names]), "linux"));
      expect(result.units.length).toBe(count * 2 - 1);
      return ops;
    };
    const n = 200;
    expectNearLinear("removalUnits", await run(n), await run(n * 8), { maxTotal: n * 8 * 200 });
  });

  it("builds the review sheet's rows in linear work", async () => {
    const run = async (count: number) => {
      const queue = filledQueue(count);
      add(queue, count);
      const { requests } = queue.list();
      const sessions: McpAgentSession[] = Array.from({ length: 4 }, (_, i) => ({
        id: `s${i}`, name: `Agent ${i}`, roleId: i === 3 ? "builtin.operator" : "builtin.admin",
        createdAt: "", updatedAt: "", revokedAt: i === 2 ? "2026-10-01" : null,
      }));
      const ticks = new Map(requests.flatMap((request) => request.items.filter((_, i) => i % 3 === 0).map((item) => [item.id, false] as const)));
      const { ops, result } = await measureOps(() => reviewGroups(requests, sessions, ticks, new Map(), "linux"));
      expect(result.flatMap((group) => group.rows)).toHaveLength(count);
      return ops;
    };
    const n = 160;
    expectNearLinear("reviewGroups", await run(n), await run(n * 8), { maxTotal: n * 8 * 200 });
  });
});
