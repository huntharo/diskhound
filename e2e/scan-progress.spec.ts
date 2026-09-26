import { dirname, join } from "node:path";

import { createIdleScanSnapshot, type ScanSnapshot } from "../src/shared/contracts";
import { expect, test, type AppHandle } from "./fixtures/electron-app";

async function publish(handle: AppHandle, snapshot: ScanSnapshot): Promise<void> {
  await handle.app.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows()[0].webContents.send("diskhound:scan-snapshot", value);
  }, snapshot);
}

// Use real renderer/IPC with synthetic scanner snapshots: long baseline loads
// and finalization must be reproducible without scanning the developer's disk.
async function prepareRescan(handle: AppHandle, root: string): Promise<ScanSnapshot> {
  const snapshot: ScanSnapshot = {
    ...createIdleScanSnapshot(),
    rootPath: root,
    status: "running",
    scanPhase: "starting",
    startedAt: Date.now() - 20_500,
    elapsedMs: 20_500,
  };
  await handle.app.evaluate(({ ipcMain }, value) => {
    ipcMain.removeHandler("diskhound:start-scan");
    ipcMain.handle("diskhound:start-scan", () => value);
    ipcMain.removeHandler("diskhound:cancel-scan");
    ipcMain.handle("diskhound:cancel-scan", (_event, rootPath) => {
      if (rootPath !== value.rootPath) throw new Error("Stop targeted the wrong root");
      return { ...value, status: "cancelled" };
    });
  }, snapshot);
  await handle.setPickDirectory(root);
  await handle.page.getByRole("button", { name: "Browse for folder..." }).click();
  await expect(handle.page.locator(".scan-progress")).toBeVisible();
  await publish(handle, { ...snapshot, status: "cancelled" });
  await handle.page.getByRole("button", { name: "Rescan", exact: true }).click();
  return snapshot;
}

test("rescan shows animated preparation at zero files and Stop stays usable", async ({ launch, scanTree }, testInfo) => {
  const handle = await launch();
  const initial = await prepareRescan(handle, scanTree.root);
  const { page } = handle;
  const panel = page.locator(".scan-progress");
  const progress = panel.getByRole("progressbar");
  await expect(panel).toContainText("Preparing scan");
  await expect(panel).toContainText("loading the prior index");
  await expect(panel).toContainText("0 files · 0 folders · 0 B");
  await expect(progress).toBeVisible();
  await expect(progress).not.toHaveAttribute("aria-valuenow");
  await expect(panel).not.toContainText("%");
  await expect(panel.locator(".index-loading-ring")).toHaveCSS("animation-name", "index-loading-spin");
  await expect(panel.locator(".index-loading-bar-fill")).toHaveCSS("animation-name", "index-loading-slide");
  const elapsed = await panel.locator(".index-loading-elapsed").textContent();
  await expect(panel.locator(".index-loading-elapsed")).not.toHaveText(elapsed!);
  await page.screenshot({ path: testInfo.outputPath("preparing.png") });
  await publish(handle, { ...initial, scanPhase: "finalizing" });
  await expect(panel).toContainText("Finalizing");
  await expect(progress).not.toHaveAttribute("aria-valuenow");
  await expect(panel.locator(".index-loading-bar-fill")).toHaveCSS("animation-name", "index-loading-slide");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(page.locator(".tab-status")).toHaveText("Stopped");
});

test("progress stays visible through walking, indexing, and indeterminate finalization", async ({ launch, scanTree }, testInfo) => {
  const handle = await launch();
  const initial = await prepareRescan(handle, scanTree.root);
  const { page } = handle;
  const panel = page.locator(".scan-progress");
  const progress = panel.getByRole("progressbar");

  await publish(handle, { ...initial, scanPhase: "reading_metadata" });
  await expect(panel).toContainText("Reading the volume's filesystem metadata");
  await expect(progress).not.toHaveAttribute("aria-valuenow");

  // A walker can report files before it has any countable bytes or known total.
  await publish(handle, { ...initial, scanPhase: undefined, filesVisited: 4, directoriesVisited: 2 });
  await expect(panel).toContainText("Scanning folders");
  await expect(panel).toContainText("4 files · 2 folders");
  await expect(progress).not.toHaveAttribute("aria-valuenow");

  // Even zero-byte files have meaningful count-based progress while indexing.
  await publish(handle, { ...initial, scanPhase: "indexing", expectedTotalFiles: 10, filesVisited: 4 });
  await expect(progress).toHaveAttribute("aria-valuenow", "40");
  await expect(panel).toContainText("4 / 10 files indexed");
  await expect(panel.locator(".index-loading-bar-fill")).toHaveCSS("animation-name", "none");
  await expect(page.locator(".metric-progress .metric-value")).toHaveText("40%");

  const file = scanTree.files[0];
  const indexed: ScanSnapshot = {
    ...initial,
    scanPhase: "indexing",
    expectedTotalFiles: 10,
    filesVisited: 6,
    bytesSeen: file.bytes,
    largestFiles: [{ path: join(scanTree.root, file.path), parentPath: dirname(join(scanTree.root, file.path)), name: file.name, extension: ".bin", size: file.bytes, modifiedAt: Date.now() }],
  };
  await publish(handle, indexed);
  await expect(panel).toHaveClass(/with-results/);
  await expect(progress).toHaveAttribute("aria-valuenow", "60");
  await expect(page.locator(".treemap-container canvas")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("indexing.png") });

  // Lite finalizing snapshots omit top-N; keep both the tiles and activity UI.
  await publish(handle, { ...indexed, scanPhase: "finalizing", largestFiles: [] });
  await expect(panel).toContainText("Finalizing — building the folder tree and flushing the index");
  await expect(progress).not.toHaveAttribute("aria-valuenow");
  await expect(panel).not.toContainText("%");
  await expect(panel.locator(".index-loading-bar-fill")).toHaveCSS("animation-name", "index-loading-slide");
  await expect(page.locator(".metric-progress")).toBeHidden();
  await expect(page.locator(".treemap-container canvas")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await (await handle.app.browserWindow(page)).evaluate((win) => win.setContentSize(960, 720));
  await page.screenshot({ path: testInfo.outputPath("finalizing.png") });

  await publish(handle, { ...indexed, status: "done", scanPhase: "complete", finishedAt: Date.now() });
  await expect(panel).toBeHidden();
  await expect(page.locator(".tab-status")).toHaveText("Complete");
});
