import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MEMORY_DIAG_HEARTBEAT_MS,
  MEMORY_DIAG_IDLE_MS,
  MEMORY_DIAG_SCANNING_MS,
  createMemoryDiagnostics,
  memorySampleChanged,
  type MemorySample,
} from "../memoryDiagnostics";

const MB = 1024 * 1024;

function sample(rssMb: number, heapMb: number, caches = "0"): MemorySample {
  return { rssBytes: rssMb * MB, heapUsedBytes: heapMb * MB, caches, text: `rss=${rssMb} heap=${heapMb} caches=${caches}` };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("memorySampleChanged", () => {
  it("needs at least 32 MB of movement on a small footprint", () => {
    expect(memorySampleChanged(sample(200, 100), sample(231, 131))).toBe(false);
    expect(memorySampleChanged(sample(200, 100), sample(232, 100))).toBe(true);
    expect(memorySampleChanged(sample(200, 100), sample(200, 68))).toBe(true);
  });

  it("needs 10% of movement on a large footprint", () => {
    expect(memorySampleChanged(sample(2000, 1000), sample(2150, 1080))).toBe(false);
    expect(memorySampleChanged(sample(2000, 1000), sample(1800, 1000))).toBe(true);
  });

  it("logs any cache size change", () => {
    expect(memorySampleChanged(sample(200, 100, "1/5"), sample(200, 100, "1/6"))).toBe(true);
  });
});

describe("createMemoryDiagnostics", () => {
  function setup(initial: MemorySample) {
    let current = initial;
    let scanning = false;
    const write = vi.fn<(tag: string, message: string) => void>();
    const diagnostics = createMemoryDiagnostics({
      sample: () => current,
      isScanning: () => scanning,
      write,
    });
    return {
      diagnostics,
      write,
      set: (next: MemorySample) => { current = next; },
      scan: (on: boolean) => { scanning = on; diagnostics.retune(); },
    };
  }

  it("logs the boot sample, then only samples that moved, then an hourly heartbeat", () => {
    const { diagnostics, write, set } = setup(sample(400, 150));
    diagnostics.start();
    expect(write).toHaveBeenLastCalledWith("memory", "boot: rss=400 heap=150 caches=0");

    vi.advanceTimersByTime(MEMORY_DIAG_IDLE_MS * 2);
    expect(write).toHaveBeenCalledTimes(1);

    set(sample(520, 150));
    vi.advanceTimersByTime(MEMORY_DIAG_IDLE_MS);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith("memory", "rss=520 heap=150 caches=0");

    vi.advanceTimersByTime(MEMORY_DIAG_HEARTBEAT_MS - MEMORY_DIAG_IDLE_MS);
    expect(write).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(MEMORY_DIAG_IDLE_MS);
    expect(write).toHaveBeenCalledTimes(3);
    diagnostics.stop();
  });

  it("samples every minute while scanning, under the memory-scanning tag", () => {
    const { diagnostics, write, set, scan } = setup(sample(400, 150));
    diagnostics.start();
    scan(true);
    set(sample(480, 150));
    vi.advanceTimersByTime(MEMORY_DIAG_SCANNING_MS);
    expect(write).toHaveBeenLastCalledWith("memory-scanning", "rss=480 heap=150 caches=0");

    scan(false);
    set(sample(300, 150));
    vi.advanceTimersByTime(MEMORY_DIAG_SCANNING_MS);
    expect(write).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(MEMORY_DIAG_IDLE_MS - MEMORY_DIAG_SCANNING_MS);
    expect(write).toHaveBeenLastCalledWith("memory", "rss=300 heap=150 caches=0");
    diagnostics.stop();
  });
});
