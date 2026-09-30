import { _electron as electron, test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

for (const [packaged, disabled] of [[false, false], [true, true], [true, false]]) {
  test(`direct launch updater isolation (packaged=${packaged}, disabled=${disabled})`, async () => {
    const profile = mkdtempSync(join(tmpdir(), "diskhound-update-isolation-"));
    const env: NodeJS.ProcessEnv = { ...process.env, DISKHOUND_PROBE_PACKAGED: packaged ? "1" : "0" };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.VITE_DEV_SERVER_URL;
    // Unpacked apps must be safe even outside a test runner. Packaged tests
    // inherit the global config flag, without using the primary fixture.
    if (!disabled) delete env.DISKHOUND_DISABLE_UPDATES;
    const app = await electron.launch({
      args: [`--user-data-dir=${profile}`, resolve("e2e/fixtures/updater-probe.cjs")],
      env: { ...env, ...(process.platform === "linux" ? { HOME: profile, APPIMAGE: "/test.AppImage" } : {}) },
    });
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(() => Boolean(window.diskhound));
      const probe = () => app.evaluate(() => (globalThis as typeof globalThis & {
        updaterProbe: { imports: number; checks: number };
      }).updaterProbe);
      const active = packaged && !disabled;
      if (active) {
        // The former production startup delay was 1.5 seconds. All release
        // checks here are stubbed, including a regression to that behavior.
        await new Promise(resolve => setTimeout(resolve, 2000));
        expect(await probe()).toEqual({ imports: 1, checks: 0 });
      }
      await page.evaluate(() => window.diskhound.checkForUpdates());
      expect(await probe()).toEqual({ imports: active ? 1 : 0, checks: active ? 1 : 0 });
    } finally {
      await app.close();
      rmSync(profile, { recursive: true, force: true });
    }
  });
}
