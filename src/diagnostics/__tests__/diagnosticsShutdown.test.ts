import { afterEach, describe, expect, it, vi } from "vitest";

import { createDiagnosticsShutdown } from "../diagnosticsShutdown";
import { deferred } from "./diagnosticsTestKit";

afterEach(() => vi.useRealTimers());

function fixture(stop: () => void | Promise<void>) {
  vi.useFakeTimers();
  const warn = vi.fn();
  const event = { preventDefault: vi.fn() };
  const resumedEvent = { preventDefault: vi.fn() };
  const resumeQuit = vi.fn(() => {
    expect(shutdown.beforeQuit(resumedEvent)).toBe(false);
  });
  const stopSpy = vi.fn(stop);
  const shutdown = createDiagnosticsShutdown({ stop: stopSpy, resumeQuit, warn });
  return { shutdown, stopSpy, resumeQuit, warn, event, resumedEvent };
}

describe("diagnostics shutdown", () => {
  it("holds quit until the capture is flushed, then allows the reentrant quit", async () => {
    const capture = deferred();
    const f = fixture(() => capture.promise);
    expect(f.shutdown.beforeQuit(f.event)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.resumeQuit).not.toHaveBeenCalled();
    capture.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.event.preventDefault).toHaveBeenCalledOnce();
    expect(f.resumeQuit).toHaveBeenCalledOnce();
    expect(f.resumedEvent.preventDefault).not.toHaveBeenCalled();
    expect(f.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("repeated quits cannot restart the deadline or a stuck stop", async () => {
    const capture = deferred();
    const f = fixture(() => capture.promise);
    f.shutdown.beforeQuit(f.event);
    await vi.advanceTimersByTimeAsync(9_999);
    f.shutdown.beforeQuit(f.event);
    expect(f.resumeQuit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.stopSpy).toHaveBeenCalledOnce();
    expect(f.resumeQuit).toHaveBeenCalledOnce();
    expect(f.warn).toHaveBeenCalledWith("diagnostics shutdown exceeded 10000 ms; continuing quit");
    capture.resolve();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.resumeQuit).toHaveBeenCalledOnce();
    expect(f.warn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["throw", "reject"])("allows quit when stop fails with %s", async (failure) => {
    const f = fixture(() => {
      if (failure === "throw") throw new Error("disk unavailable");
      return Promise.reject(new Error("disk unavailable"));
    });
    f.shutdown.beforeQuit(f.event);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.resumeQuit).toHaveBeenCalledOnce();
    expect(f.warn).toHaveBeenCalledWith("diagnostics shutdown failed: disk unavailable; continuing quit");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles a late rejection after the deadline without retrying quit", async () => {
    let reject!: (error: Error) => void;
    const f = fixture(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    f.shutdown.beforeQuit(f.event);
    await vi.advanceTimersByTimeAsync(10_000);
    reject(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.resumeQuit).toHaveBeenCalledOnce();
    expect(f.warn).toHaveBeenCalledOnce();
  });

  it("does not let a failing warning logger prevent exit", async () => {
    const f = fixture(() => new Promise(() => {}));
    f.warn.mockImplementation(() => { throw new Error("log disk unavailable"); });
    f.shutdown.beforeQuit(f.event);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.resumeQuit).toHaveBeenCalledOnce();
  });

  it.each([false, true])("lets an updater own quit after its flush (timeout: %s)", async (timeout) => {
    const capture = deferred();
    const f = fixture(() => capture.promise);
    const install = vi.fn(() => {
      expect(f.shutdown.beforeQuit(f.event)).toBe(false);
    });
    const flush = f.shutdown.flush();
    expect(f.shutdown.flush()).toBe(flush);
    void flush.then(install);
    await vi.advanceTimersByTimeAsync(1);
    expect(install).not.toHaveBeenCalled();
    if (!timeout) capture.resolve();
    await vi.advanceTimersByTimeAsync(timeout ? 9_999 : 0);
    expect(install).toHaveBeenCalledOnce();
    expect(f.resumeQuit).not.toHaveBeenCalled();
    expect(f.event.preventDefault).not.toHaveBeenCalled();
    expect(f.stopSpy).toHaveBeenCalledOnce();
  });

  it("shares the deadline when an update takes over a pending normal quit", async () => {
    const f = fixture(() => new Promise<void>(() => {}));
    const appQuit = vi.fn();
    let updatePending = false;
    f.resumeQuit.mockImplementation(() => { if (!updatePending) appQuit(); });
    f.shutdown.beforeQuit(f.event);
    await vi.advanceTimersByTimeAsync(5_000);
    updatePending = true;
    const install = vi.fn(() => {
      updatePending = false;
      expect(f.shutdown.beforeQuit(f.resumedEvent)).toBe(false);
    });
    void f.shutdown.flush().then(install);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(appQuit).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledOnce();
    expect(f.stopSpy).toHaveBeenCalledOnce();
    expect(f.resumedEvent.preventDefault).not.toHaveBeenCalled();
  });
});
