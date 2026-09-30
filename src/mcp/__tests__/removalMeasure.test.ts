import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { nativeRemovalMeasurer, RemovalMeasurements, type RemovalMeasurement } from "../removalMeasure";

const RESULT: RemovalMeasurement = {
  paths: [],
  total: { files: 1, sizeBytes: 4096, freesBytes: 4096, heldElsewhereBytes: 0, uncertainBytes: 0 },
  missing: [],
  nested: [],
  skippedEntries: 0,
  cloneMetadata: true,
  elapsedMs: 5,
  measuredAt: 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("RemovalMeasurements", () => {
  it("measures a set once, whatever the order or repeats, and answers again from memory", async () => {
    const run = vi.fn(async (_paths: readonly string[]) => RESULT);
    const measurements = new RemovalMeasurements(run);
    await measurements.measure(["/b", "/a", "/a"]);
    expect(await measurements.measure(["/a", "/b"])).toBe(RESULT);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toEqual(["/a", "/b"]);
  });

  it("measures again once the result is older than the TTL", async () => {
    let now = 0;
    const run = vi.fn(async () => RESULT);
    const measurements = new RemovalMeasurements(run, { ttlMs: 1_000, now: () => now });
    await measurements.measure(["/a"]);
    now = 1_001;
    await measurements.measure(["/a"]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps measuring when the agent stops waiting, so the same call made again gets the result", async () => {
    const walk = deferred<RemovalMeasurement>();
    const run = vi.fn((_paths: readonly string[], _signal: AbortSignal) => walk.promise);
    const measurements = new RemovalMeasurements(run);
    const caller = new AbortController();
    const first = measurements.measure(["/a"], caller.signal);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    caller.abort();
    await expect(first).rejects.toThrow("stopped waiting");
    expect(run.mock.calls[0]![1].aborted).toBe(false);
    walk.resolve(RESULT);
    expect(await measurements.measure(["/a"], new AbortController().signal)).toBe(RESULT);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("doesn't keep a failure", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("no scanner")).mockResolvedValue(RESULT);
    const measurements = new RemovalMeasurements(run);
    await expect(measurements.measure(["/a"])).rejects.toThrow("no scanner");
    expect(await measurements.measure(["/a"])).toBe(RESULT);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs one walk at a time", async () => {
    const first = deferred<RemovalMeasurement>();
    const run = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(RESULT);
    const measurements = new RemovalMeasurements(run);
    const a = measurements.measure(["/a"]);
    const b = measurements.measure(["/b"]);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(run).toHaveBeenCalledTimes(1);
    first.resolve(RESULT);
    await Promise.all([a, b]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("forgets finished results after a removal and keeps only the newest few", async () => {
    let now = 0;
    const run = vi.fn(async () => RESULT);
    const measurements = new RemovalMeasurements(run, { maxKept: 2, now: () => ++now });
    await measurements.measure(["/a"]);
    measurements.invalidate();
    await measurements.measure(["/a"]);
    expect(run).toHaveBeenCalledTimes(2);
    await measurements.measure(["/b"]);
    await measurements.measure(["/c"]);
    await measurements.measure(["/d"]);
    await measurements.measure(["/a"]);
    expect(run).toHaveBeenCalledTimes(6);
  });

  it("aborts a running walk on dispose", async () => {
    const run = vi.fn((_paths: readonly string[], signal: AbortSignal) =>
      new Promise<RemovalMeasurement>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("killed")))));
    const measurements = new RemovalMeasurements(run);
    const pending = measurements.measure(["/a"]);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    measurements.dispose();
    await expect(pending).rejects.toThrow("killed");
  });
});

// The real scanner is covered by its Rust tests and the agent E2E; this
// checks the process plumbing with a stand-in.
describe.skipIf(process.platform === "win32")("nativeRemovalMeasurer", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) FS.rmSync(dir, { recursive: true, force: true });
  });

  function fakeScanner(body: string): { binary: string; argsFile: string } {
    const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-measure-"));
    dirs.push(dir);
    const binary = Path.join(dir, "diskhound-native-scanner");
    const argsFile = Path.join(dir, "args");
    FS.writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\n${body}\n`, { mode: 0o755 });
    return { binary, argsFile };
  }

  it("passes each path and the worker count, and returns the measurement line", async () => {
    const line = JSON.stringify({ ...RESULT, type: "removal-measurement", measuredAt: undefined });
    const { binary, argsFile } = fakeScanner(`echo '{"type":"progress","files":1}'\necho '${line}'`);
    const result = await nativeRemovalMeasurer(binary, () => 3, () => 42)(["/a b", "/c"], new AbortController().signal);
    expect(result).toMatchObject({ total: RESULT.total, measuredAt: 42 });
    expect(FS.readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "--mode=measure-removal", "--path", "/a b", "--path", "/c", "--workers", "3",
    ]);
  });

  it("reports the scanner's error", async () => {
    const { binary } = fakeScanner(`echo '{"type":"error","message":"--path must be absolute: x"}'\nexit 1`);
    await expect(nativeRemovalMeasurer(binary)(["x"], new AbortController().signal)).rejects.toThrow("--path must be absolute: x");
  });

  it("stops the scanner when aborted", async () => {
    const { binary } = fakeScanner("sleep 10");
    const controller = new AbortController();
    const pending = nativeRemovalMeasurer(binary)(["/a"], controller.signal);
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    await expect(pending).rejects.toThrow("cancelled");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
