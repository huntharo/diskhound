import type { Locator, Page } from "@playwright/test";

import type { ScanSnapshot } from "../../src/shared/contracts";
import { expect, type AppHandle } from "./electron-app";

/** Scans can take longer than an assertion's default 15 s, on a cold
 *  Windows runner above all. */
const SCAN_TIMEOUT_MS = 45_000;

export function tab(page: Page, label: string) {
  return page.locator(".tab-bar").getByRole("button", { name: label, exact: true });
}

/** A point in the middle of the last hidden action button must miss the
 *  overlay. Opacity alone still hit-tests, so this is what keeps a click
 *  on the name under the buttons from pressing one. */
export async function expectHiddenActionsPassClicks(page: Page, actions: Locator): Promise<void> {
  await expect(actions).toHaveCSS("opacity", "0");
  await expect(actions).toHaveCSS("pointer-events", "none");
  const box = await actions.locator("button").last().boundingBox();
  expect(box, "action button has no box").not.toBeNull();
  const hitsActions = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return Boolean(el?.closest(".hover-actions"));
  }, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
  expect(hitsActions).toBe(false);
}

/** Once the buttons are shown, that same point presses a button. */
export async function expectShownActionsCatchClicks(page: Page, actions: Locator): Promise<void> {
  await expect(actions).toHaveCSS("opacity", "1");
  await expect(actions).toHaveCSS("pointer-events", "auto");
  const box = await actions.locator("button").last().boundingBox();
  expect(box, "action button has no box").not.toBeNull();
  const hitsActions = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return Boolean(el?.closest(".hover-actions"));
  }, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
  expect(hitsActions).toBe(true);
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
