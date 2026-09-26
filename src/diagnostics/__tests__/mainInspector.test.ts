import type { Profiler } from "node:inspector";

import { expect, it } from "vitest";

import { createMainInspector } from "../mainInspector";

// Adapted from PwrAgnt's main-process-hot-cpu-target.test.ts.

it("profiles the calling thread through an in-process session and refuses commands once detached", async () => {
  const inspector = createMainInspector();
  inspector.attach();
  expect(() => inspector.attach()).toThrow("already attached");
  await inspector.post("Profiler.enable");
  await inspector.post("Profiler.start");
  const end = performance.now() + 20;
  while (performance.now() < end) Math.sqrt(Math.random());
  const { profile } = await inspector.post<{ profile: Profiler.Profile }>("Profiler.stop");
  expect(profile.nodes.length).toBeGreaterThan(1);
  expect(profile.endTime).toBeGreaterThan(profile.startTime);
  inspector.detach();
  expect(inspector.isAttached()).toBe(false);
  await expect(inspector.post("Profiler.stop")).rejects.toThrow("not attached");
});

it("answers HeapProfiler commands synchronously, for the near-limit path", () => {
  const inspector = createMainInspector();
  inspector.attach();
  try {
    inspector.postSync("HeapProfiler.enable");
    inspector.postSync("HeapProfiler.startSampling", { samplingInterval: 1024 });
    const kept: object[] = [];
    for (let index = 0; index < 20_000; index += 1) kept.push({ index, text: `row ${index}` });
    const { profile } = inspector.postSync<{ profile: { head: unknown; samples: unknown[] } }>("HeapProfiler.getSamplingProfile");
    expect(profile.samples.length).toBeGreaterThan(0);
    expect(kept).toHaveLength(20_000);
    inspector.postSync("HeapProfiler.stopSampling");
  } finally {
    inspector.detach();
  }
  expect(() => inspector.postSync("HeapProfiler.enable")).toThrow("not attached");
});
