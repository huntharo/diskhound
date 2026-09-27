import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { IterableMapper } from "@shutterstock/p-map-iterable";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PermanentDeleteProgress } from "../contracts";
import { permanentlyDeleteOnDisk } from "../permanentDelete";

vi.mock("node:fs/promises", () => ({
  lstat: vi.fn(), opendir: vi.fn(), readdir: vi.fn(), unlink: vi.fn(), rmdir: vi.fn(), chmod: vi.fn(),
}));
vi.mock("@shutterstock/p-map-iterable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shutterstock/p-map-iterable")>();
  return {
    IterableMapper: vi.fn(function (input, mapper, options) {
      return new actual.IterableMapper(input, mapper, options);
    }),
  };
});

const root = Path.resolve("delete-fixture");
const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type Node = { directory: boolean; children: string[] };
function fixture(folders: number, filesPerFolder: number, nested = false) {
  const nodes = new Map<string, Node>();
  const openPaths = new Set<string>();
  const state = { operations: 0, active: 0, peak: 0, handles: 0, peakHandles: 0, reads: 0, finished: 0, readAhead: 0, readFailureAt: Infinity, total: 1 + folders * (1 + filesPerFolder) };
  nodes.set(root, { directory: true, children: [] });
  let parent = root;
  for (let d = 0; d < folders; d++) {
    const dir = Path.join(parent, `d${d}`);
    nodes.get(parent)!.children.push(dir);
    nodes.set(dir, { directory: true, children: [] });
    for (let f = 0; f < filesPerFolder; f++) {
      const file = Path.join(dir, `f${f}`);
      nodes.get(dir)!.children.push(file);
      nodes.set(file, { directory: false, children: [] });
    }
    if (nested) parent = dir;
  }
  vi.mocked(FSP.lstat).mockImplementation(async (path) => {
    state.operations++;
    const node = nodes.get(String(path));
    if (!node) throw missing();
    return { isDirectory: () => node.directory, isSymbolicLink: () => false } as never;
  });
  vi.mocked(FSP.opendir).mockImplementation(async (path, options) => {
    expect(options).toEqual({ bufferSize: 32 });
    state.operations++;
    state.handles++;
    openPaths.add(String(path));
    state.peakHandles = Math.max(state.peakHandles, state.handles);
    const children = nodes.get(String(path))!.children;
    let index = 0;
    let closed = false;
    return {
      async read() {
        expect(closed).toBe(false);
        state.operations++;
        if (state.reads === state.readFailureAt) throw new Error("read failed");
        const child = children[index++];
        if (!child) return null;
        state.reads++;
        state.readAhead = Math.max(state.readAhead, state.reads - state.finished);
        const directory = nodes.get(child)!.directory;
        return {
          get name() { state.operations++; return Path.basename(child); },
          isDirectory() { state.operations++; return directory; },
          isSymbolicLink() { state.operations++; return false; },
        };
      },
      async close() {
        expect(closed).toBe(false);
        closed = true;
        state.operations++;
        state.handles--;
        openPaths.delete(String(path));
      },
    } as never;
  });
  vi.mocked(FSP.unlink).mockImplementation(async (path) => {
    state.operations++;
    state.active++;
    state.peak = Math.max(state.peak, state.active);
    await tick();
    nodes.delete(String(path));
    state.finished++;
    state.active--;
  });
  vi.mocked(FSP.rmdir).mockImplementation(async (path) => {
    state.operations++;
    state.active++;
    state.peak = Math.max(state.peak, state.active);
    const node = nodes.get(String(path))!;
    expect(openPaths.has(String(path)), "close the directory handle before removing it").toBe(false);
    expect(node.children.every((child) => !nodes.has(child)), "children finish before their parent").toBe(true);
    await tick();
    nodes.delete(String(path));
    state.finished++;
    state.active--;
  });
  return { state, nodes };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("bounded permanent deletion", () => {
  it("keeps four removals in flight with separate 100-item input and result buffers", async () => {
    const { state, nodes } = fixture(12, 12);
    await permanentlyDeleteOnDisk(root);
    expect(state.peak).toBe(4);
    expect(state.active).toBe(0);
    expect(nodes.size).toBe(0);
    expect(vi.mocked(IterableMapper).mock.calls.map((call) => call[2])).toEqual([
      { concurrency: 1, maxUnread: 100 },
      { concurrency: 4, maxUnread: 100 },
    ]);
  });

  it("waits for out-of-order children, then their directory, before attempting the root", async () => {
    fixture(1, 4);
    const dir = Path.join(root, "d0");
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const files = new Map<string, { release: ReturnType<typeof deferred>; done: ReturnType<typeof deferred> }>();
    const unlink = vi.mocked(FSP.unlink).getMockImplementation()!;
    vi.mocked(FSP.unlink).mockImplementation(async (path) => {
      const gates = { release: deferred(), done: deferred() };
      files.set(String(path), gates);
      await gates.release.promise;
      await unlink(path);
      gates.done.resolve();
    });
    const directoryStarted = deferred();
    const releaseDirectory = deferred();
    const rmdir = vi.mocked(FSP.rmdir).getMockImplementation()!;
    vi.mocked(FSP.rmdir).mockImplementation(async (path) => {
      if (String(path) === dir) {
        directoryStarted.resolve();
        await releaseDirectory.promise;
      }
      return rmdir(path);
    });
    const deletion = permanentlyDeleteOnDisk(root);
    await tick();
    expect(files.size).toBe(4);
    for (const index of [3, 1, 2]) {
      const gates = files.get(Path.join(dir, `f${index}`))!;
      gates.release.resolve();
      await gates.done.promise;
      await tick();
      expect(FSP.rmdir).not.toHaveBeenCalled();
    }
    // The first file dispatched is deliberately the last one to finish.
    files.get(Path.join(dir, "f0"))!.release.resolve();
    await directoryStarted.promise;
    await tick();
    expect(vi.mocked(FSP.rmdir).mock.calls.map(([path]) => path)).toEqual([dir]);
    releaseDirectory.resolve();
    await deletion;
    // Check attempts, not merely successful removal: retries must not hide an
    // ordering defect on Windows or any other filesystem.
    expect(vi.mocked(FSP.rmdir).mock.calls.map(([path]) => path)).toEqual([dir, root]);
  });

  it("scales linearly as both the file count and folder count grow 8x", async () => {
    const small = fixture(64, 10);
    await permanentlyDeleteOnDisk(root);
    const large = fixture(512, 10);
    await permanentlyDeleteOnDisk(root);
    expect(large.state.operations).toBeLessThanOrEqual(small.state.operations * 16);
    expect(large.state.operations).toBeLessThanOrEqual(large.state.total * 8);
    expect(large.state.peak).toBe(4);
    expect(small.state.peakHandles).toBe(2);
    expect(large.state.peakHandles).toBe(2);
    expect(large.state.handles).toBe(0);
    expect(large.state.readAhead).toBeLessThanOrEqual(106);
    expect(FSP.readdir).not.toHaveBeenCalled();
  });

  it("keeps operation counts linear when tree depth and entry count both grow 8x", async () => {
    const small = fixture(64, 1, true);
    await permanentlyDeleteOnDisk(root);
    const large = fixture(512, 1, true);
    await permanentlyDeleteOnDisk(root);
    expect(large.state.operations).toBeLessThanOrEqual(small.state.operations * 16);
    expect(large.state.operations).toBeLessThanOrEqual(large.state.total * 8);
    expect(large.state.handles).toBe(0);
    expect(large.nodes.size).toBe(0);
  });

  it("reports only changed tenths, counts completions and reserves 100% for verification", async () => {
    const { state, nodes } = fixture(1, 10_000);
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (now += 150));
    const progress: PermanentDeleteProgress[] = [];
    await permanentlyDeleteOnDisk(root, (p) => {
      progress.push(p);
      expect(p.itemsDeleted).toBeLessThanOrEqual(state.total - nodes.size);
      if (p.percent === 100) expect(nodes.size).toBe(0);
      else expect(p.itemsTotal).toBeNull();
    }, 10_000);
    expect(progress[0]!.phase).toBe("preparing");
    const percentages = progress.flatMap((p) => p.percent === null ? [] : [p.percent]);
    expect(percentages[0]).toBe(0);
    expect(percentages.at(-1)).toBe(100);
    expect(new Set(percentages).size).toBe(percentages.length);
    expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
    expect(progress.length).toBeLessThanOrEqual(1002);
    expect(progress.at(-1)!.itemsDeleted).toBe(state.total);
    expect(progress.at(-1)!.itemsTotal).toBe(state.total);
  });

  it("also batches rapid percentage changes by time", async () => {
    fixture(1, 200);
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const progress: PermanentDeleteProgress[] = [];
    await permanentlyDeleteOnDisk(root, (p) => progress.push(p), 200);
    expect(progress.map((p) => p.percent)).toEqual([null, 0, 100]);
  });

  it("does not delete anything if opening the root fails", async () => {
    fixture(1, 3);
    const failure = Object.assign(new Error("cannot read directory"), { code: "EACCES" });
    vi.mocked(FSP.opendir).mockRejectedValueOnce(failure);
    await expect(permanentlyDeleteOnDisk(root)).rejects.toBe(failure);
    expect(FSP.unlink).not.toHaveBeenCalled();
    expect(FSP.rmdir).not.toHaveBeenCalled();
  });

  it("does not report 100% if the root remains after deletion", async () => {
    fixture(0, 0);
    vi.mocked(FSP.rmdir).mockResolvedValue(undefined);
    const progress: PermanentDeleteProgress[] = [];
    await expect(permanentlyDeleteOnDisk(root, (p) => progress.push(p)))
      .rejects.toThrow("still on disk");
    expect(progress.some((p) => p.percent === 100)).toBe(false);
  });

  it.each([3, 1_000])("drains failures with %s children, including an EOF waiter", async (files) => {
    const { state } = fixture(1, files);
    const activeCount = Math.min(4, files);
    const failure = Object.assign(new Error("denied"), { code: "EACCES" });
    const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    let allStarted!: () => void;
    const started = new Promise<void>((resolve) => { allStarted = resolve; });
    vi.mocked(FSP.unlink).mockImplementation(() => new Promise<void>((resolve, reject) => {
      pending.push({ resolve, reject });
      if (pending.length === activeCount) allStarted();
    }));
    const progress: PermanentDeleteProgress[] = [];
    let settled = false;
    const deletion = permanentlyDeleteOnDisk(root, (p) => progress.push(p));
    const result = deletion.then(() => { settled = true; }, (error) => { settled = true; return error; });
    await started;
    await tick();
    if (files > 100) expect(state.reads).toBeGreaterThanOrEqual(100);
    expect(state.reads).toBeLessThanOrEqual(106);
    pending[0]!.reject(failure);
    await tick();
    expect(settled).toBe(false);
    expect(FSP.unlink).toHaveBeenCalledTimes(activeCount);
    for (const operation of pending.slice(1)) operation.resolve();
    expect(await result).toBe(failure);
    expect(state.handles).toBe(0);
    expect(FSP.rmdir).not.toHaveBeenCalled();
    expect(progress.some((p) => p.percent === 100)).toBe(false);
    await tick();
    expect(FSP.unlink).toHaveBeenCalledTimes(activeCount);
  });

  it("bounds work and read-ahead for a wide directory as its entry count grows 8x", async () => {
    let smallOperations = 0;
    for (const count of [1_000, 8_000]) {
      const { state } = fixture(1, count);
      await permanentlyDeleteOnDisk(root);
      expect(state.readAhead).toBeLessThanOrEqual(106);
      expect(state.peakHandles).toBe(2);
      expect(state.handles).toBe(0);
      expect(state.operations).toBeLessThanOrEqual(state.total * 8);
      if (smallOperations === 0) smallOperations = state.operations;
      else expect(state.operations).toBeLessThanOrEqual(smallOperations * 16);
    }
    expect(FSP.readdir).not.toHaveBeenCalled();
  });

  it("prefetches bounded pending work while all four removals are blocked", async () => {
    const { state, nodes } = fixture(1, 1_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const unlink = vi.mocked(FSP.unlink).getMockImplementation()!;
    vi.mocked(FSP.unlink).mockImplementation(async (path) => {
      await gate;
      return unlink(path);
    });
    const deletion = permanentlyDeleteOnDisk(root);
    await tick();
    const callsBeforeRelease = vi.mocked(FSP.unlink).mock.calls.length;
    const readsBeforeRelease = state.reads;
    release();
    await deletion;
    expect(callsBeforeRelease).toBe(4);
    expect(readsBeforeRelease).toBeGreaterThanOrEqual(100);
    // One ancestor entry plus 100 queued jobs, four deletion runners, and a
    // possible producer item. This bound is independent of the 1,000-file tree.
    expect(readsBeforeRelease).toBeLessThanOrEqual(106);
    expect(nodes.size).toBe(0);
    expect(state.handles).toBe(0);
  });

  it("drains in-flight work and closes handles after a mid-stream read failure", async () => {
    const { state } = fixture(1, 30);
    state.readFailureAt = 4;
    await expect(permanentlyDeleteOnDisk(root)).rejects.toThrow("read failed");
    expect(state.finished).toBeGreaterThan(0);
    expect(state.active).toBe(0);
    expect(state.handles).toBe(0);
    const calls = vi.mocked(FSP.unlink).mock.calls.length;
    await tick();
    expect(FSP.unlink).toHaveBeenCalledTimes(calls);
    expect(FSP.rmdir).not.toHaveBeenCalled();
  });

  it("cleans up when the progress consumer throws while work is active", async () => {
    const { state } = fixture(1, 30);
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (now += 150));
    const failure = new Error("consumer failed");
    await expect(permanentlyDeleteOnDisk(root, (p) => {
      if (p.itemsDeleted > 0) throw failure;
    })).rejects.toBe(failure);
    expect(state.active).toBe(0);
    expect(state.handles).toBe(0);
  });

  it.each([1, 100_000, undefined])("handles stale or absent scan counts (%s)", async (estimate) => {
    const { nodes, state } = fixture(1, 30);
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (now += 150));
    const progress: PermanentDeleteProgress[] = [];
    await permanentlyDeleteOnDisk(root, (p) => {
      progress.push(p);
      if (p.percent === 100) expect(nodes.size).toBe(0);
    }, estimate);
    expect(progress.at(-1)).toMatchObject({ percent: 100, itemsTotal: state.total });
    const running = progress.slice(0, -1);
    expect(running.every((p) => p.itemsTotal === null)).toBe(true);
    if (estimate === undefined) {
      expect(running.every((p) => p.percent === null)).toBe(true);
      expect(running.some((p) => p.itemsDeleted > 0)).toBe(true);
    } else {
      expect(running.every((p) => p.percent === null || p.percent < 100)).toBe(true);
    }
  });

});
