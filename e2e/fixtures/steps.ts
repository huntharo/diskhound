import type { Page } from "@playwright/test";

import type { ScanSnapshot } from "../../src/shared/contracts";
import { expect, type AppHandle } from "./electron-app";

/** Scans can take longer than an assertion's default 15 s, on a cold
 *  Windows runner above all. */
const SCAN_TIMEOUT_MS = 45_000;

export function tab(page: Page, label: string) {
  return page.locator(".tab-bar").getByRole("button", { name: label, exact: true });
}

export async function openTab(page: Page, label: string): Promise<void> {
  await tab(page, label).click();
  await expect(tab(page, label)).toHaveClass(/\bactive\b/);
}

/** Wait until the header reports the current root's scan as complete,
 *  then return the snapshot main holds for it. */
export async function waitForScanComplete(page: Page): Promise<ScanSnapshot> {
  await expect(page.locator(".tab-status")).toHaveText("Complete", { timeout: SCAN_TIMEOUT_MS });
  return page.evaluate(() => window.diskhound.getCurrentSnapshot());
}

/**
 * The first-run path: the drive picker is up, the user clicks
 * "Browse for folder..." and chooses `root` in the (stubbed) dialog.
 */
export async function scanFolderFromPicker(handle: AppHandle, root: string): Promise<ScanSnapshot> {
  const { page } = handle;
  await expect(page.locator(".picker-card")).toBeVisible();
  await handle.setPickDirectory(root);
  await page.getByRole("button", { name: "Browse for folder..." }).click();
  return waitForScanComplete(page);
}
