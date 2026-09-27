import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { openTab } from "./fixtures/steps";

test("size units follow the platform, can be overridden live in both windows, and reset to an omitted key", async ({ launch }) => {
  const { app, page, userDataDir } = await launch();
  const persisted = () => JSON.parse(readFileSync(join(userDataDir, "settings.json"), "utf8"));
  expect(persisted().general).not.toHaveProperty("sizeUnits");
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("diskhound:get-disk-space");
    ipcMain.handle("diskhound:get-disk-space", () => [{
      drive: process.platform === "win32" ? "C:" : "/", totalBytes: 4e9,
      freeBytes: 1e9, usedBytes: 3e9, usedPercent: 75, timestamp: Date.now(),
    }]);
  });
  await page.reload();
  const platformFree = process.platform === "darwin" ? "1.0 GB free" : "954 MB free";
  await expect(page.locator(".drive-pill-free")).toHaveText(platformFree);
  await openTab(page, "Settings");
  const choice = page.getByRole("combobox", { name: "Size units" });
  await expect(choice).toHaveValue("platform");

  const [widget] = await Promise.all([
    app.waitForEvent("window"),
    page.evaluate(() => window.diskhound.openSystemWidget()),
  ]);
  const widgetFree = widget.locator(".system-widget-drive-label span").last();
  await expect(widgetFree).toHaveText(platformFree);

  await choice.selectOption("binary");
  await expect(page.locator(".drive-pill-free")).toHaveText("954 MB free");
  await expect(widgetFree).toHaveText("954 MB free");
  await expect.poll(() => persisted().general.sizeUnits).toBe("binary");
  // Reload the renderer to check preference loading before the first paint.
  await page.reload();
  await expect(page.locator(".drive-pill-free")).toHaveText("954 MB free");
  await openTab(page, "Settings");
  await expect(choice).toHaveValue("binary");

  const thresholdBefore = persisted().monitoring.alertThresholdBytes;
  await choice.selectOption("decimal");
  await expect(page.locator(".drive-pill-free")).toHaveText("1.0 GB free");
  await expect(widgetFree).toHaveText("1.0 GB free");
  await expect.poll(() => persisted().general.sizeUnits).toBe("decimal");
  expect(persisted().monitoring.alertThresholdBytes).toBe(thresholdBefore);

  await choice.selectOption("platform");
  await expect(page.locator(".drive-pill-free")).toHaveText(platformFree);
  await expect(widgetFree).toHaveText(platformFree);
  await expect.poll(() => Object.hasOwn(persisted().general, "sizeUnits")).toBe(false);
  await page.evaluate(() => window.diskhound.closeSystemWidget());
});
