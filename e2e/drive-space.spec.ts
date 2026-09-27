import { expect, test } from "./fixtures/electron-app";

test("macOS header and picker show Available including purgeable and use it for the bar", async ({ launch }) => {
  test.skip(process.platform !== "darwin", "Finder Available is macOS-only");
  const { app, page } = await launch();
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("diskhound:get-disk-space");
    ipcMain.handle("diskhound:get-disk-space", () => [{
      drive: "/", totalBytes: 2e12, freeBytes: 37.28e9, usedBytes: 1_962.72e9,
      usedPercent: 98.136, availableBytes: 723.5e9, purgeableBytes: 686.22e9, timestamp: Date.now(),
    }]);
  });
  await page.reload();
  const pill = page.locator(".drive-pill");
  await expect(pill.locator(".drive-pill-free")).toHaveText("724 GB available · 686 GB purgeable");
  await expect(pill).toHaveAttribute("title", "View / (724 GB available · 686 GB purgeable)");
  await expect(pill.locator(".drive-pill-fill")).toHaveClass(/low/);
  const width = await pill.locator(".drive-pill-fill").evaluate((el) => parseFloat((el as HTMLElement).style.width));
  expect(width).toBeCloseTo(63.825);
  await expect(page.locator(".drive-card-free")).toHaveText("724 GB available · 686 GB purgeable");
  await expect(page.locator(".drive-card-fill")).toHaveClass(/ok/);

  // At the narrow-header breakpoint only the secondary detail disappears;
  // Available and the complete tooltip remain, and the picker is unaffected.
  for (const contentWidth of [961, 960, 1280]) {
    await app.evaluate(({ BrowserWindow }, width) => {
      BrowserWindow.getAllWindows()[0].setContentSize(width, 800);
    }, contentWidth);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(contentWidth);
    const purgeable = pill.locator(".drive-pill-purgeable");
    if (contentWidth <= 960) {
      await expect(purgeable).toBeHidden();
      await expect(pill.locator(".drive-pill-free")).toHaveText("724 GB available", { useInnerText: true });
    } else {
      await expect(purgeable).toBeVisible();
      await expect(pill.locator(".drive-pill-free")).toHaveText("724 GB available · 686 GB purgeable", { useInnerText: true });
    }
    await expect(pill).toHaveAttribute("title", "View / (724 GB available · 686 GB purgeable)");
    await expect(page.locator(".drive-card-free")).toHaveText("724 GB available · 686 GB purgeable");
  }

  // Foundation may be unavailable on a mount; preserve an honest raw-free fallback.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("diskhound:get-disk-space");
    ipcMain.handle("diskhound:get-disk-space", () => [{
      drive: "/", totalBytes: 2e12, freeBytes: 37.28e9, usedBytes: 1_962.72e9,
      usedPercent: 98.136, timestamp: Date.now(),
    }]);
  });
  await page.reload();
  await expect(pill.locator(".drive-pill-free")).toHaveText("37.3 GB free");
  await expect(pill.locator(".drive-pill-fill")).toHaveClass(/high/);
});
