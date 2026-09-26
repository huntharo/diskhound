import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "./fixtures/electron-app";

// Main buffers most crash.log lines for a couple of seconds and counts
// repeated renderer errors instead of writing each one. These check the
// two ways out of the buffer that unit tests can't: Electron's quit
// events, and the in-app viewer.

test("startup lines are on disk at once and the rest reach it at quit", async ({ launch }) => {
  const handle = await launch();
  const crashLog = join(handle.userDataDir, "crash.log");

  // Startup breadcrumbs are crash-class: written before the window shows.
  expect(readFileSync(crashLog, "utf8")).toContain("[startup] whenReady fired");

  await handle.page.evaluate(async () => {
    for (let i = 0; i < 3; i++) window.diskhound.reportRendererError({ message: "e2e renderer failure" });
    // An invoke after the sends returns once main has handled them.
    await window.diskhound.getSettings();
  });
  await handle.close();

  const text = readFileSync(crashLog, "utf8");
  expect(text.match(/\[renderer\] e2e renderer failure/g)).toHaveLength(1);
  // The repeat count's own timer is a minute out, so only the quit
  // flush can have written it.
  expect(text).toMatch(/\[renderer\] repeated 2 more times in the last \d+ s: e2e renderer failure/);
});

test("the crash log viewer shows lines still buffered", async ({ launch }) => {
  const { page } = await launch();

  const log = await page.evaluate(async () => {
    window.diskhound.reportRendererError({ message: "e2e buffered line" });
    return window.diskhound.getCrashLog();
  });

  expect(log.text).toContain("[renderer] e2e buffered line");
});
