import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "../components/Toasts";
import { runBulkPathAction } from "./bulkPathAction";

vi.mock("../components/Toasts", () => ({ toast: vi.fn() }));
afterEach(() => vi.clearAllMocks());

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Wait for mapper scheduling without depending on wall-clock performance.
async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

describe("bulk path actions", () => {
  it("announces immediately, bounds concurrency, and waits for active work on cancel", async () => {
    const blocked = gate();
    let cancelled = false;
    let active = 0;
    let peak = 0;
    const action = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await blocked.promise;
      active--;
      return { ok: true, message: "Moved" };
    });
    const onComplete = vi.fn();
    const run = runBulkPathAction(Array.from({ length: 100 }, (_, i) => `/file-${i}`), "trash", action, 0, {
      isCancelled: () => cancelled, onProgress: vi.fn(), onComplete,
    });
    expect(toast).toHaveBeenCalledWith("info", "Moving to Trash: 0 of 100 files", expect.any(String), expect.objectContaining({ dismissAfterMs: 0 }));
    await flush();
    expect(peak).toBe(4);
    cancelled = true;
    expect(onComplete).not.toHaveBeenCalled();
    blocked.resolve();
    expect(await run).toHaveLength(4);
    expect(action).toHaveBeenCalledTimes(4);
    expect(active).toBe(0);
    expect(onComplete).toHaveBeenCalledWith("Cancelled — Trashed 4 of 100 files; 96 unprocessed");
  });

  it("reports returned and thrown errors, retains the result, and continues processing", async () => {
    const action = vi.fn(async (path: string) => {
      if (path === "/throw") throw new Error("Drive disconnected");
      return { ok: path === "/ok", message: "Permission denied" };
    });
    expect(await runBulkPathAction(["/ok", "/fail", "/throw"], "trash", action, 2)).toEqual(["/ok"]);
    expect(toast).toHaveBeenLastCalledWith("warning", "Done — Trashed 1 of 3 files; 2 failed", expect.stringContaining("/fail: Permission denied"), expect.objectContaining({ dismissAfterMs: 0 }));
    expect(vi.mocked(toast).mock.calls.at(-1)?.[2]).toContain("2 protected or already-deleted");
  });

  it("reports total failure instead of silently doing nothing", async () => {
    await runBulkPathAction(["/fail"], "delete", async () => ({ ok: false, message: "Read-only" }));
    expect(toast).toHaveBeenLastCalledWith("error", "Done — Deleted 0 of 1 files; 1 failed", expect.stringContaining("Read-only"), expect.any(Object));
  });

  it("updates progress while an earlier operation is still pending", async () => {
    const blocked = gate();
    const clock = vi.spyOn(Date, "now");
    let now = 0;
    clock.mockImplementation(() => now);
    const onProgress = vi.fn();
    const run = runBulkPathAction(["/slow", "/fast"], "trash", async (path) => {
      if (path === "/slow") await blocked.promise;
      else now = 200;
      return { ok: true, message: "Moved" };
    }, 0, { isCancelled: () => false, onProgress });
    await flush();
    expect(onProgress).toHaveBeenCalledWith(1, 2);
    blocked.resolve();
    await run;
    clock.mockRestore();
  });

  it("scales linearly at N and 8N with one action and bounded path reads per file", async () => {
    async function measure(n: number) {
      let reads = 0;
      let actions = 0;
      const paths = new Proxy(Array.from({ length: n }, (_, i) => `/file-${i}`), {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) reads++;
          return Reflect.get(target, key, receiver);
        },
      });
      const ok = await runBulkPathAction(paths, "trash", async () => {
        actions++;
        return { ok: true, message: "Moved" };
      });
      expect(ok).toHaveLength(n);
      expect(actions).toBe(n);
      expect(reads).toBeLessThanOrEqual(n * 2);
      return reads + actions;
    }
    const small = await measure(100);
    const large = await measure(800);
    expect(large).toBeLessThanOrEqual(small * 16);
    expect(large).toBeLessThanOrEqual(2400);
  });
});
