import { expect, test } from "./fixtures/electron-app";
import { scanFolderFromPicker } from "./fixtures/steps";
import type { FullDiffProgress, ScanSnapshot } from "../src/shared/contracts";

test("relays native finalizing steps and comparison progress to both windows", async ({ launch, scanTree }) => {
  const handle = await launch();
  await handle.page.evaluate(() => {
    (window as any).__scanPhases = [];
    window.diskhound.onScanSnapshot((snapshot) => {
      if (snapshot.scanPhase === "finalizing") (window as any).__scanPhases.push(snapshot);
    });
  });
  const done = await scanFolderFromPicker(handle, scanTree.root);
  const phases: ScanSnapshot[] = await handle.page.evaluate(() => (window as any).__scanPhases);
  expect(phases.map((snapshot) => snapshot.finalizingStep)).toEqual(expect.arrayContaining([
    "finishing_index", "writing_folder_tree", "flushing_index", "classifying_dev_artifacts",
  ]));
  await handle.page.evaluate(() => window.diskhound.openSystemWidget());
  await expect.poll(() => handle.app.windows().length).toBe(2);
  const widget = handle.app.windows().find((page) => page !== handle.page)!;
  await expect(widget.locator(".system-widget-scan-path")).toBeVisible();

  // Replay a genuine short-lived native snapshot so both renderers can be
  // asserted while finalization is still on screen, independent of disk speed.
  const finalizing = phases.find((snapshot) => snapshot.finalizingStep === "writing_folder_tree")!;
  await handle.app.evaluate(({ BrowserWindow }, snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("diskhound:scan-snapshot", snapshot);
  }, finalizing);
  await expect(handle.page.locator(".tab-status")).toContainText("Finalizing");
  await expect(handle.page.locator(".tab-status")).toContainText("Writing folder tree");
  await expect(handle.page.getByRole("progressbar", { name: "Finalizing", exact: true })).not.toHaveAttribute("aria-valuenow");
  await expect(widget.getByRole("progressbar", { name: "Finalizing", exact: true })).not.toHaveAttribute("aria-valuenow");

  await expect(widget.locator(".phase-progress-fill")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  const progress: FullDiffProgress = { rootPath: done.rootPath!, scanStartedAt: done.startedAt,
    isLatestPair: true, baselineId: "test-baseline", currentId: "test-current", status: "running", revision: 1,
    phase: "merging", fraction: 0.73, completed: 4, total: 10 };
  await handle.app.evaluate(({ BrowserWindow }, { done, progress }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("diskhound:full-diff-progress", progress);
      window.webContents.send("diskhound:scan-snapshot", done);
    }
  }, { done, progress });
  await expect(handle.page.locator(".tab-status")).toContainText("Examining changes");
  await expect(handle.page.getByRole("progressbar", { name: "Examining changes", exact: true })).toHaveAttribute("aria-valuenow", "73");
  await expect(widget.getByRole("progressbar", { name: "Examining changes", exact: true })).toHaveAttribute("aria-valuenow", "73");

  await handle.app.evaluate(({ BrowserWindow }, progress) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("diskhound:full-diff-progress", { ...progress, revision: 2, status: "complete", fraction: 1 });
  }, progress);
  await expect(handle.page.locator(".tab-status")).toHaveText("Complete");
  await expect(widget.getByRole("progressbar", { name: "Complete", exact: true })).toHaveAttribute("aria-valuenow", "100");
});
