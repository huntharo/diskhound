import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { McpAgentCapability } from "../../shared/agentAccess";
import type { RemovalAction, RemovalVolumeCheck } from "../../shared/agentRemovals";
import { RemovalQueue } from "../removalQueue";
import { RemovalReview, removalUnits, type RemovalReviewDeps, type SessionAccess } from "../removalReview";
import { fileIdentity } from "../trashGuard";

const NOW = Date.UTC(2026, 9, 12, 12);
const OK: RemovalVolumeCheck = { volume: "the startup disk", trash: "yes", readOnly: false, mountsInside: [], checkedAt: NOW };
const OPERATOR: McpAgentCapability[] = ["disk.read", "scan.run", "app.navigate", "files.trash"];
const ADMIN: McpAgentCapability[] = [...OPERATOR, "files.delete"];

let dir: string;

beforeEach(() => {
  dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-removal-review-"));
});

afterEach(() => {
  FS.rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  queue: RemovalQueue;
  review: RemovalReview;
  removed: { path: string; action: RemovalAction }[];
  sessions: Map<string, SessionAccess>;
  checks: Map<string, RemovalVolumeCheck>;
  protectedPaths: Set<string>;
  stuck: Set<string>;
}

function harness(overrides: Partial<RemovalReviewDeps> = {}): Harness {
  const queue = new RemovalQueue(Path.join(dir, "agent-removals.json"), { now: () => NOW, debounceMs: 60_000, platform: "linux" });
  const removed: Harness["removed"] = [];
  const sessions = new Map<string, SessionAccess>([
    ["s-op", { name: "Codex", roleName: "Cleanup Operator", capabilities: OPERATOR }],
    ["s-admin", { name: "Claude Code", roleName: "Cleanup Admin", capabilities: ADMIN }],
  ]);
  const checks = new Map<string, RemovalVolumeCheck>();
  const protectedPaths = new Set<string>();
  const stuck = new Set<string>();
  const remove = (action: RemovalAction) => async (path: string) => {
    if (stuck.has(path)) return { ok: false, message: "The Trash did not take this folder — it is still on disk." };
    removed.push({ path, action });
    FS.rmSync(path, { recursive: true, force: true });
    return { ok: true, message: "ok" };
  };
  const review = new RemovalReview({
    queue,
    check: async (items) => items.map((item) => checks.get(item.path) ?? OK),
    canonicalTarget: async (path) => ({ path: FS.realpathSync(path), fileId: idOf(path) }),
    protection: async () => (_requested, target) => (protectedPaths.has(target) ? "Refused: DiskHound never lets agents remove this folder." : null),
    sessions: () => (id) => sessions.get(id) ?? null,
    trashPath: remove("trash"),
    deletePath: remove("delete"),
    listDir: async (path) => FS.readdirSync(path),
    platform: "linux",
    now: () => NOW,
    ...overrides,
  });
  return { queue, review, removed, sessions, checks, protectedPaths, stuck };
}

/** What is at `path` now, as the host records it when an agent asks. */
function idOf(path: string): string {
  return fileIdentity(FS.lstatSync(path, { bigint: true }));
}

function touch(...parts: string[]): string {
  const path = Path.join(FS.realpathSync(dir), ...parts);
  FS.mkdirSync(Path.dirname(path), { recursive: true });
  FS.writeFileSync(path, "x");
  return path;
}

function folder(...parts: string[]): string {
  const path = Path.join(FS.realpathSync(dir), ...parts);
  FS.mkdirSync(path, { recursive: true });
  return path;
}

function ask(h: Harness, sessionId: string, asked: RemovalAction, items: { path: string; check?: RemovalVolumeCheck; fileId?: string }[]) {
  return h.queue.add({
    sessionId,
    sessionName: h.sessions.get(sessionId)?.name ?? sessionId,
    roleName: h.sessions.get(sessionId)?.roleName ?? "?",
    asked,
    reason: null,
    items: items.map((item) => ({ path: item.path, sizeBytes: 1000, check: item.check ?? OK, fileId: item.fileId ?? (FS.existsSync(item.path) ? idOf(item.path) : undefined) })),
  }).request;
}

describe("RemovalReview.approve", () => {
  it("runs ticked items, skips unticked ones, and reports each honestly", async () => {
    const h = harness();
    const a = touch("a");
    const b = touch("b");
    const c = folder("c");
    h.stuck.add(c);
    const request = ask(h, "s-op", "trash", [{ path: a }, { path: b }, { path: c }]);
    const [ia, ib, ic] = request.items;
    const { result, trashed, deleted } = await h.review.approve([
      { itemId: ia!.id, run: true, action: "trash" },
      { itemId: ib!.id, run: false, action: "trash" },
      { itemId: ic!.id, run: true, action: "trash" },
    ]);
    expect(trashed).toEqual([a]);
    expect(deleted).toEqual([]);
    expect(result).toMatchObject({ moved: { items: 1, bytes: 1000, unsized: 0 }, skipped: 1, failed: 1, sessions: 1 });
    const items = h.queue.list().requests[0]!.items;
    expect(items.map((item) => [item.status, item.outcome?.message])).toEqual([
      ["moved", "Moved to the Trash."],
      ["skipped", "You skipped it."],
      ["failed", "The Trash did not take this folder — it is still on disk."],
    ]);
    expect(h.queue.list().requests[0]!.decidedAt).toBe(NOW);
    expect(FS.existsSync(b)).toBe(true);
  });

  it("moves a delete request to the Trash when the user switches it", async () => {
    const h = harness();
    const a = touch("a");
    const [item] = ask(h, "s-admin", "delete", [{ path: a }]).items;
    const { result } = await h.review.approve([{ itemId: item!.id, run: true, action: "trash" }]);
    expect(h.removed).toEqual([{ path: a, action: "trash" }]);
    expect(result.moved.items).toBe(1);
    expect(h.queue.find(item!.id)?.item).toMatchObject({
      status: "moved",
      outcome: { action: "trash", message: "Moved to the Trash instead of deleted, as you chose." },
    });
  });

  it("never turns a Trash request into a delete when the Trash would take it", async () => {
    const h = harness();
    const a = touch("a");
    const [item] = ask(h, "s-admin", "trash", [{ path: a }]).items;
    const { result } = await h.review.approve([{ itemId: item!.id, run: true, action: "delete" }]);
    expect(h.removed).toEqual([]);
    expect(result.refused).toBe(1);
    expect(FS.existsSync(a)).toBe(true);
  });

  it("lets an Admin's Trash request be deleted when the Trash can't take it", async () => {
    const h = harness();
    const a = touch("a");
    const noTrash = { ...OK, trash: "no" as const, trashWhy: "share is a network volume with no Trash." };
    h.checks.set(a, noTrash);
    const [item] = ask(h, "s-admin", "trash", [{ path: a, check: noTrash }]).items;
    const { result } = await h.review.approve([{ itemId: item!.id, run: true, action: "delete" }]);
    expect(h.removed).toEqual([{ path: a, action: "delete" }]);
    expect(result.deleted.items).toBe(1);
  });

  it("re-checks the session: a revoked one's items are refused, and a lowered role can't delete", async () => {
    const h = harness();
    const a = touch("a");
    const b = touch("b");
    const c = touch("c");
    const [ia] = ask(h, "s-op", "trash", [{ path: a }]).items;
    const [ib, ic] = ask(h, "s-admin", "delete", [{ path: b }, { path: c }]).items;
    h.sessions.delete("s-op");
    h.sessions.set("s-admin", { name: "Claude Code", roleName: "Cleanup Operator", capabilities: OPERATOR });
    const { result } = await h.review.approve([
      { itemId: ia!.id, run: true, action: "trash" },
      { itemId: ib!.id, run: true, action: "delete" },
      { itemId: ic!.id, run: true, action: "trash" },
    ]);
    expect(h.removed).toEqual([{ path: c, action: "trash" }]);
    expect(result).toMatchObject({ refused: 2, moved: { items: 1 } });
    expect(h.queue.find(ia!.id)?.item.outcome?.message).toBe("Codex's session was revoked, so DiskHound didn't act on its request.");
    expect(h.queue.find(ib!.id)?.item.outcome?.message).toBe("Claude Code's role (Cleanup Operator) no longer allows permanent deletes.");
  });

  it("re-checks the path: gone, changed, or protected since the agent asked", async () => {
    const h = harness();
    const gone = touch("gone");
    const real = folder("real");
    const link = Path.join(FS.realpathSync(dir), "link");
    const target = Path.join(link, "x");
    touch("real", "x");
    const guarded = touch("guarded");
    // Queued while `link` was a real folder; it became a symlink since.
    FS.mkdirSync(link);
    FS.writeFileSync(target, "x");
    const items = ask(h, "s-op", "trash", [{ path: gone }, { path: target }, { path: guarded }]).items;
    FS.rmSync(gone);
    FS.rmSync(link, { recursive: true });
    FS.symlinkSync(real, link);
    h.protectedPaths.add(guarded);
    const { result } = await h.review.approve(items.map((item) => ({ itemId: item.id, run: true, action: "trash" as const })));
    expect(h.removed).toEqual([]);
    expect(result).toMatchObject({ gone: 1, refused: 2 });
    expect(h.queue.list().requests[0]!.items.map((item) => item.outcome?.message)).toEqual([
      "Already gone.",
      "This path changed after the agent asked, so DiskHound left it alone.",
      "Refused: DiskHound never lets agents remove this folder.",
    ]);
  });

  it("leaves alone a file made again at the path after the agent asked", async () => {
    const h = harness();
    const a = touch("a");
    const [item] = ask(h, "s-op", "trash", [{ path: a }]).items;
    FS.rmSync(a);
    touch("a");
    const { result } = await h.review.approve([{ itemId: item!.id, run: true, action: "trash" }]);
    expect(h.removed).toEqual([]);
    expect(FS.existsSync(a)).toBe(true);
    expect(result.gone).toBe(1);
    expect(h.queue.find(item!.id)?.item).toMatchObject({
      status: "gone",
      outcome: { message: "Already gone. Something else is at this path now, and DiskHound left it alone." },
    });
  });

  it("removes nothing while it can't read the volumes, and offers it again once it can", async () => {
    const h = harness();
    const a = touch("a");
    const b = touch("b");
    const unknown: RemovalVolumeCheck = { ...OK, trash: "unknown", trashWhy: "DiskHound couldn't read the list of volumes (mount failed).", volumesUnknown: true };
    const [ia, ib] = ask(h, "s-admin", "delete", [{ path: a, check: unknown }, { path: b, check: unknown }]).items;
    h.checks.set(a, { ...unknown, checkedAt: NOW + 1 });
    const { result } = await h.review.approve([
      { itemId: ia!.id, run: true, action: "delete" },
      { itemId: ib!.id, run: true, action: "delete" },
    ]);
    expect(h.removed).toEqual([]);
    // Still unreadable: refused with the reason.
    expect(h.queue.find(ia!.id)?.item).toMatchObject({ status: "refused", outcome: { message: expect.stringContaining("It removes nothing it can't check") } });
    // Readable now: back on the list with the new facts for the user to look at.
    expect(result.changed).toBe(1);
    expect(h.queue.find(ib!.id)?.item).toMatchObject({ status: "waiting", check: { trash: "yes" } });
    expect(h.queue.find(ib!.id)?.item.check.volumesUnknown).toBeUndefined();
  });

  it("leaves an item waiting with the new facts when its volume changed since the user looked", async () => {
    const h = harness();
    const a = touch("a");
    const [item] = ask(h, "s-op", "trash", [{ path: a }]).items;
    const now: RemovalVolumeCheck = { ...OK, trash: "no", trashWhy: "The drive was remounted without a Trash.", checkedAt: NOW + 1 };
    h.checks.set(a, now);
    const { result } = await h.review.approve([{ itemId: item!.id, run: true, action: "trash" }]);
    expect(result.changed).toBe(1);
    expect(h.removed).toEqual([]);
    expect(h.queue.find(item!.id)?.item).toMatchObject({ status: "waiting", check: now });
    expect(h.queue.list().running).toBe(false);
  });

  it("removes everything around another volume mounted inside, and says what it left", async () => {
    // The real platform: matching the mount against the item's path uses its separator.
    const h = harness({ platform: process.platform });
    const datasets = folder("datasets");
    touch("datasets", "a.csv");
    touch("datasets", "deep", "b.csv");
    touch("datasets", "deep", "archive", "on-the-other-volume");
    touch("datasets", "deep", "c.csv");
    const mount = Path.join(datasets, "deep", "archive");
    const check: RemovalVolumeCheck = { ...OK, mountsInside: [{ path: mount, volume: "Archive" }] };
    h.checks.set(datasets, check);
    const [item] = ask(h, "s-admin", "delete", [{ path: datasets, check }]).items;
    const { result, deleted } = await h.review.approve([{ itemId: item!.id, run: true, action: "delete" }]);
    expect(deleted.sort()).toEqual([Path.join(datasets, "a.csv"), Path.join(datasets, "deep", "b.csv"), Path.join(datasets, "deep", "c.csv")]);
    expect(result.partial).toBe(1);
    expect(FS.existsSync(Path.join(mount, "on-the-other-volume"))).toBe(true);
    expect(h.queue.find(item!.id)?.item).toMatchObject({
      status: "partial",
      outcome: {
        action: "delete",
        message: `Deleted permanently, except ${Path.join("deep", "archive")}${Path.sep} (Archive): another volume mounted inside, which DiskHound left alone.`,
        left: [mount, datasets, Path.join(datasets, "deep")],
      },
    });
  });

  it("ignores decisions for items that aren't waiting, and runs one approval at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const h = harness({
      trashPath: async () => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return { ok: true, message: "ok" };
      },
    });
    const a = touch("a");
    const b = touch("b");
    const [ia] = ask(h, "s-op", "trash", [{ path: a }]).items;
    const [ib] = ask(h, "s-op", "trash", [{ path: b }]).items;
    const [first, second] = await Promise.all([
      h.review.approve([{ itemId: ia!.id, run: true, action: "trash" }]),
      h.review.approve([{ itemId: ib!.id, run: true, action: "trash" }, { itemId: ia!.id, run: true, action: "trash" }, { itemId: "it_nope", run: true, action: "trash" }]),
    ]);
    expect(most).toBe(1);
    expect(first.result.moved.items).toBe(1);
    expect(second.result.moved.items).toBe(1);
  });

  it("reads volume facts again immediately before each item", async () => {
    const first = touch("first");
    const later = folder("later");
    const mount = folder("later", "usb");
    touch("later", "keep.txt");
    touch("later", "usb", "secret");
    const mounted: RemovalVolumeCheck = { ...OK, mountsInside: [{ path: mount, volume: "USB" }] };
    const h = harness({
      deletePath: async (path) => {
        if (path === first) h.checks.set(later, mounted);
        FS.rmSync(path, { recursive: true, force: true });
        h.removed.push({ path, action: "delete" });
        return { ok: true, message: "ok" };
      },
    });
    const [a] = ask(h, "s-admin", "delete", [{ path: first }]).items;
    const [b] = ask(h, "s-admin", "delete", [{ path: later }]).items;
    await h.review.approve([
      { itemId: a!.id, run: true, action: "delete" },
      { itemId: b!.id, run: true, action: "delete" },
    ]);
    expect(FS.existsSync(first)).toBe(false);
    expect(FS.existsSync(Path.join(mount, "secret"))).toBe(true);
    // The new mount is not what the user approved. It stays on the list.
    expect(h.queue.find(b!.id)?.item.status).toBe("waiting");
    expect(h.queue.find(b!.id)?.item.check.mountsInside).toEqual([{ path: mount, volume: "USB" }]);
  });

  it("does not remove a path that has become a mount point", async () => {
    const h = harness();
    const a = folder("volume");
    const check: RemovalVolumeCheck = { ...OK, selfMount: true, volume: "USB" };
    const [item] = ask(h, "s-admin", "delete", [{ path: a, check }]).items;
    h.checks.set(a, check);
    const { result } = await h.review.approve([{ itemId: item!.id, run: true, action: "delete" }]);
    expect(result.refused).toBe(1);
    expect(h.removed).toEqual([]);
    expect(FS.existsSync(a)).toBe(true);
    expect(h.queue.find(item!.id)?.item.outcome?.message).toContain("is a volume");
  });
});

describe("fileIdentity", () => {
  it("uses the change time when the filesystem reports no birth time", () => {
    const base = { dev: 1n, ino: 2n, ctimeNs: 9n };
    expect(fileIdentity({ ...base, birthtimeNs: 0n })).toBe("1:2:9");
    expect(fileIdentity({ ...base, birthtimeNs: 0n, ctimeNs: 10n })).toBe("1:2:10");
    // A real birth time stays, so a later metadata change is still the same file.
    expect(fileIdentity({ ...base, birthtimeNs: 3n, ctimeNs: 10n })).toBe("1:2:3");
  });
});

describe("removalUnits", () => {
  it("returns the folder itself when nothing is mounted inside", async () => {
    const root = folder("x");
    expect(await removalUnits(root, [], async () => [], "linux")).toEqual({ units: [root], holders: [] });
  });

  it("opens only the folders on the way to each mount", async () => {
    const lists: string[] = [];
    const tree: Record<string, string[]> = {
      "/d": ["a", "m1", "deep"],
      "/d/deep": ["b", "m2", "c"],
    };
    const result = await removalUnits("/d", ["/d/m1", "/d/deep/m2"], async (path) => {
      lists.push(path);
      return tree[path] ?? [];
    }, "linux");
    expect(result).toEqual({ units: ["/d/a", "/d/deep/b", "/d/deep/c"], holders: ["/d", "/d/deep"] });
    expect(lists.sort()).toEqual(["/d", "/d/deep"]);
  });

  it("compares Windows paths without case", async () => {
    const result = await removalUnits("C:\\Mounts", ["c:\\mounts\\data"], async () => ["Data", "notes.txt"], "win32");
    expect(result).toEqual({ units: ["C:\\Mounts\\notes.txt"], holders: ["C:\\Mounts"] });
  });
});
