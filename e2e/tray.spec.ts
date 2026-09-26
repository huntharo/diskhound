import type { ElectronApplication } from "@playwright/test";

import { expect, test } from "./fixtures/electron-app";

// DiskHound runs for days hidden in the tray, and several renderer
// pollers start a process in main on every tick (df or PowerShell for
// disk space). They pause while the window can't be seen. Main has to
// say so: its background switches keep `document.visibilityState`
// "visible" in a hidden window (seen on macOS), which this spec first
// caught. This checks the whole path in the built app.
//
// Ten minutes hidden, the renderer starts nothing. Main's own timers
// still run: the disk monitor's df (PowerShell on Windows) every
// monitoring interval, at most 1 in 10 minutes at the default 60, 10
// at the 1-minute setting; and a crash.log memory line every 5 minutes.

/** Records every child process main starts, via Node's built-in channel. */
async function recordSpawns(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const channels = process.getBuiltinModule("node:diagnostics_channel");
    const state = globalThis as typeof globalThis & { __e2eSpawns?: Array<{ spawnfile?: string; spawnargs?: string[] }> };
    state.__e2eSpawns = [];
    // Published from the ChildProcess constructor, before spawnfile is
    // set, so keep the object and read the command later.
    channels.subscribe("child_process", (message) => {
      state.__e2eSpawns!.push((message as { process: { spawnfile?: string; spawnargs?: string[] } }).process);
    });
  });
}

async function takeSpawns(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    const state = globalThis as typeof globalThis & { __e2eSpawns?: Array<{ spawnfile?: string; spawnargs?: string[] }> };
    const spawns = state.__e2eSpawns ?? [];
    state.__e2eSpawns = [];
    return spawns.map((child) => (child.spawnargs ?? [child.spawnfile ?? "?"]).join(" "));
  });
}

async function setWindowsVisible(app: ElectronApplication, visible: boolean): Promise<void> {
  await app.evaluate(({ BrowserWindow }, show) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (show) win.show();
      else win.hide();
    }
  }, visible);
}

test("hiding to the tray pauses the renderer's polling", async ({ launch }) => {
  test.setTimeout(90_000);
  const { app, page } = await launch();
  await expect(page.locator(".picker-card")).toBeVisible();
  await recordSpawns(app);

  // Visible: the header's disk-space poll ticks every 10 s. This also
  // shows the spawn counter is live, so the zero below means something.
  await expect.poll(async () => (await takeSpawns(app)).length, { timeout: 15_000 }).toBeGreaterThan(0);

  await setWindowsVisible(app, false);
  expect(await page.evaluate(() => window.diskhound.isWindowShown())).toBe(false);
  // Let main's hide notice reach the renderer before counting.
  await page.waitForTimeout(1_000);
  await takeSpawns(app);

  // Two disk-space intervals hidden.
  await page.waitForTimeout(21_000);
  expect(await takeSpawns(app)).toEqual([]);

  // Shown again, the pollers tick at once instead of waiting out a full interval.
  await setWindowsVisible(app, true);
  await expect.poll(async () => (await takeSpawns(app)).length, { timeout: 5_000 }).toBeGreaterThan(0);
});
