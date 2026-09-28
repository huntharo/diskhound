import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DiagnosticsStatus } from "../src/shared/contracts";
import { expect, test, type AppHandle } from "./fixtures/electron-app";

/** Diagnostics are off by default; these turn them on for one launch. */
const diagnosticsStatus = (handle: AppHandle): Promise<DiagnosticsStatus> =>
  handle.page.evaluate(() => window.diskhound.getDiagnosticsStatus());

const crashLog = (handle: AppHandle): string => {
  const file = join(handle.userDataDir, "crash.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

test("saves a hot-CPU profile that reaches back past the live window", async ({ launch }) => {
  // Short windows and samples so a capture takes seconds, not a minute.
  // The 3 s delay and 80% threshold keep a busy boot on a slow runner
  // from taking the launch's first capture.
  const handle = await launch({
    env: {
      DISKHOUND_HOT_CPU_PROFILING: "1",
      DISKHOUND_HOT_CPU_PROFILING_START_DELAY_MS: "3000",
      DISKHOUND_HOT_CPU_PROFILING_THRESHOLD_PERCENT: "80",
      DISKHOUND_HOT_CPU_PROFILING_INTERVAL_MS: "500",
      DISKHOUND_HOT_CPU_PROFILING_WINDOW_MS: "3000",
      DISKHOUND_HOT_CPU_PROFILING_DURATION_MS: "1000",
    },
  });
  await expect.poll(() => crashLog(handle)).toContain("[hot-cpu] armed");
  // Let the first 3 s window finish, so the capture joins two windows.
  await expect.poll(async () => (await diagnosticsStatus(handle)).hotCpu.state).toBe("recording");
  await handle.page.waitForTimeout(4_000);

  // Nearly all of the main thread for 6 s, in 50 ms slices so the
  // profiler's timers still run between them.
  await handle.app.evaluate(() => {
    const end = Date.now() + 6_000;
    (function e2eHotLoop() {
      const until = Date.now() + 50;
      while (Date.now() < until) { /* burn */ }
      if (Date.now() < end) setImmediate(e2eHotLoop);
    })();
  });
  await expect.poll(async () => (await diagnosticsStatus(handle)).hotCpu.profilesWritten, { timeout: 30_000 }).toBe(1);

  const status = await diagnosticsStatus(handle);
  const session = status.sessions.find((entry) => entry.kind === "hot-cpu");
  expect(session?.artifacts).toHaveLength(1);
  const artifact = session!.artifacts[0];
  expect(artifact.filename).toBe("main-hot-0001.cpuprofile");
  const captureToast = handle.page.locator(".toast", { hasText: "CPU profile saved" });
  await expect(captureToast).toContainText(artifact.path);
  await expect(captureToast.getByRole("button", { name: "Copy details" })).toBeVisible();
  expect(status.handoffText).toContain(artifact.path);
  // crash.log is buffered for up to 2 s.
  await expect.poll(() => crashLog(handle)).toContain(`[hot-cpu] saved ${artifact.path}`);

  const profile = JSON.parse(readFileSync(artifact.path, "utf8")) as {
    startTime: number; endTime: number; nodes: Array<{ callFrame: { functionName: string } }>;
  };
  expect(profile.nodes.some((node) => node.callFrame.functionName === "e2eHotLoop")).toBe(true);
  const manifest = JSON.parse(readFileSync(join(session!.path, "session.json"), "utf8")) as {
    artifacts: Array<{ detail: { lookbackMs: number; spanMs: number } }>;
  };
  // The finished 3 s window plus part of the live one.
  expect(manifest.artifacts[0].detail.lookbackMs).toBeGreaterThan(3_000);
  expect((profile.endTime - profile.startTime) / 1_000).toBeGreaterThan(4_000);
});

test("saves an allocation profile when the main heap passes the gate", async ({ launch }) => {
  const handle = await launch({
    settings: { diagnostics: { heapDiagnostics: true, heapGateMb: 128 } },
    env: { DISKHOUND_HEAP_INTERVAL_MS: "500" },
  });
  await expect.poll(async () => (await diagnosticsStatus(handle)).heap.state).toBe("sampling");

  // Grow main's heap well past the 128 MB gate and keep it there.
  await handle.app.evaluate(() => {
    const held: Array<{ index: number; label: string }> = [];
    (globalThis as { __e2eHeld?: unknown }).__e2eHeld = held;
    (function e2eGrowHeap() {
      for (let index = 0; index < 3_000_000; index += 1) held.push({ index, label: `e2e-${index}` });
    })();
  });
  await expect.poll(async () => (await diagnosticsStatus(handle)).heap.gatesToday, { timeout: 30_000 }).toBe(1);

  const status = await diagnosticsStatus(handle);
  const session = status.sessions.find((entry) => entry.kind === "heap");
  const artifact = session?.artifacts.find((entry) => entry.kind === "heapprofile");
  expect(artifact?.filename).toBe("main-gate-0001.heapprofile");
  expect(artifact?.summary).toMatch(/^live allocations at [\d,]+ MB, sampled for \d+ s from [\d,]+ MB$/);
  const captureToast = handle.page.locator(".toast", { hasText: "Heap allocation profile saved" });
  await expect(captureToast).toContainText(artifact!.path);
  await expect(captureToast.getByRole("button", { name: "Copy details" })).toBeVisible();
  await expect.poll(() => crashLog(handle)).toMatch(/\[heap-gate\] main heap [\d,]+ MB of [\d,]+ MB passed the 128 MB gate .*; saved /);

  type Node = { callFrame: { functionName: string }; selfSize: number; children: Node[] };
  const profile = JSON.parse(readFileSync(artifact!.path, "utf8")) as { head: Node };
  const bytesIn = (node: Node, name: string, inside = false): number => {
    const here = inside || node.callFrame.functionName === name;
    return (here ? node.selfSize : 0) + node.children.reduce((sum, child) => sum + bytesIn(child, name, here), 0);
  };
  // The sampled allocations point at the code that made them.
  expect(bytesIn(profile.head, "e2eGrowHeap")).toBeGreaterThan(50 * 1024 * 1024);
  await handle.app.evaluate(() => { delete (globalThis as { __e2eHeld?: unknown }).__e2eHeld; });
});

test("takes a heap snapshot from Settings and deletes it", async ({ launch }) => {
  const handle = await launch({
    settings: { diagnostics: { heapDiagnostics: true, heapSnapshots: true, heapGateMb: 1800 } },
  });
  const { page } = handle;
  page.on("dialog", (dialog) => void dialog.accept());
  await page.locator('button[title="Settings"]').click();
  const section = page.locator(".settings-section", { has: page.locator(".settings-section-title", { hasText: "Diagnostics" }) });
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByText("Nothing captured yet.")).toBeVisible();
  const threshold = section.locator(".setting-row", { hasText: "Heap capture threshold (MB)" }).getByRole("spinbutton");
  await expect(threshold).toHaveValue("1800");
  await threshold.fill("2000");
  await threshold.blur();
  await expect.poll(async () => (await diagnosticsStatus(handle)).heap.gateBytes).toBe(2000 * 1024 * 1024);
  await expect(section.getByText(/snapshots will be skipped/)).toHaveCount(0);

  await section.getByRole("button", { name: "Take heap snapshot" }).click();
  const row = section.locator(".diagnostics-session");
  await expect(row).toHaveCount(1, { timeout: 60_000 });
  await expect(row).toContainText("main-manual-0001.heapsnapshot");

  const status = await diagnosticsStatus(handle);
  const artifact = status.sessions[0].artifacts[0];
  expect(artifact.kind).toBe("heapsnapshot");
  await expect(section.locator("pre.diagnostics-handoff")).toContainText(artifact.path);
  const snapshot = JSON.parse(readFileSync(artifact.path, "utf8")) as {
    snapshot: { meta: { node_fields: string[] }; node_count: number }; nodes: number[];
  };
  expect(snapshot.nodes.length / snapshot.snapshot.meta.node_fields.length).toBe(snapshot.snapshot.node_count);

  const captureToast = page.locator(".toast", { hasText: "Heap snapshot saved" });
  // Main owns manual-capture notifications too: no second Settings toast.
  await expect(captureToast).toHaveCount(1);
  await expect(captureToast).toContainText(artifact.path);
  await page.clock.install();
  // New transient messages must not evict a sticky capture.
  await handle.app.evaluate(({ BrowserWindow }) => {
    const webContents = BrowserWindow.getAllWindows()[0].webContents;
    for (let i = 0; i < 8; i++) webContents.send("diskhound:notification", {
      id: `test-notice-${i}`, level: "info", title: `Notice ${i}`, dismissAfterMs: 4000,
    });
  });
  await page.clock.fastForward(6000);
  await expect(captureToast).toBeVisible();
  const previousClipboard = await handle.app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await page.bringToFront();
    // A denied clipboard write leaves a retryable toast, then succeeds.
    await page.evaluate(() => {
      const write = navigator.clipboard.writeText.bind(navigator.clipboard);
      let failOnce = true;
      navigator.clipboard.writeText = async (text) => {
        if (failOnce) { failOnce = false; throw new Error("clipboard unavailable"); }
        await write(text);
      };
    });
    await captureToast.getByRole("button", { name: "Copy details" }).click();
    await expect(captureToast.getByRole("status")).toHaveText("Couldn't copy. Try again.");
    await captureToast.getByRole("button", { name: "Copy details" }).click();
    await expect(captureToast.getByRole("button", { name: "Copied!" })).toBeVisible();
    const copied = await handle.app.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toContain("Heap snapshot saved");
    expect(copied).toContain(artifact.path);
    expect(copied).toContain(artifact.summary);
    expect(copied).toContain("Size:");
    expect(copied).toContain("Electron");
    await expect(captureToast).toBeVisible();
  } finally {
    await handle.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), previousClipboard);
  }
  await captureToast.getByRole("button", { name: "Dismiss" }).click();
  await page.clock.fastForward(250);
  await expect(captureToast).toHaveCount(0);
  await page.clock.resume();

  await section.getByRole("button", { name: "Delete all" }).click();
  await expect(section.getByText("Nothing captured yet.")).toBeVisible();
  const root = join(handle.userDataDir, "diagnostics");
  expect(readdirSync(root).filter((name) => name.startsWith("heap-"))).toEqual([]);
});

test("an updated sticky toast survives its previous auto-dismiss timer", async ({ launch }) => {
  const handle = await launch();
  await handle.page.clock.install();
  await handle.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("diskhound:notification", {
      id: "updating-toast", level: "info", title: "Capture starting", dismissAfterMs: 4000,
    });
  });
  await expect(handle.page.getByText("Capture starting", { exact: true })).toBeVisible();
  await handle.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("diskhound:notification", {
      id: "updating-toast", level: "success", title: "Capture saved", dismissAfterMs: 0, copyText: "capture details",
    });
  });
  const updated = handle.page.locator(".toast", { hasText: "Capture saved" });
  await expect(updated).toBeVisible();
  await handle.page.clock.fastForward(6000);
  await expect(updated).toBeVisible();
  await expect(handle.page.getByText("Capture starting", { exact: true })).toHaveCount(0);
});
