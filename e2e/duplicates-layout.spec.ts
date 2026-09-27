import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator } from "@playwright/test";

import { expect, test } from "./fixtures/electron-app";
import { openTab, scanFolderFromPicker } from "./fixtures/steps";

// The Duplicates view with the content that broke its layout: paths of
// very different lengths in one group, and the bulk bar under a short
// list. Duplicates only counts files of 1 MiB and up. The group header
// has its own checks in shared-storage.spec.ts.
const DATA_BYTES = 2048 * 1024;
// Long enough to truncate at the 960 px minimum window width even
// under a short output dir, and short enough to stay under Windows'
// 260-character MAX_PATH. The other name is as short as it can be, so
// it fits under a long one.
const LONG_DIR = "a-folder-name-long-enough-that-its-path-has-to-truncate-".padEnd(100, "x");

// Keep the tree out of the uploaded CI artifacts.
test.afterEach(({}, testInfo) => {
  rmSync(testInfo.outputPath("t"), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function rect(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${locator} has no box`);
  return { ...box, right: box.x + box.width };
}

test("lays out", async ({ launch }, testInfo) => {
  // A copy at a short path and one at a long path.
  const root = testInfo.outputPath("t");
  const data = randomBytes(DATA_BYTES);
  mkdirSync(join(root, LONG_DIR), { recursive: true });
  writeFileSync(join(root, "a"), data);
  writeFileSync(join(root, LONG_DIR, "b"), data);

  const handle = await launch();
  const { app, page } = handle;
  await (await app.browserWindow(page)).evaluate((win) => win.setSize(960, 720));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(960);
  await scanFolderFromPicker(handle, root);

  await openTab(page, "Duplicates");
  await page.getByRole("button", { name: "Scan for Duplicates", exact: true }).click();
  await expect(page.locator(".duplicates-title")).toHaveText("1 duplicate group", { timeout: 45_000 });
  const group = page.locator(".duplicate-group");
  await group.getByRole("button", { name: "Copies of", exact: false }).click();
  const rows = group.locator(".duplicate-file-row");
  const longRow = rows.filter({ hasText: LONG_DIR });
  const shortRow = rows.filter({ hasNotText: LONG_DIR });
  const longPath = longRow.locator(".duplicate-file-path");
  const overflows = (path: Locator) => path.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(await overflows(longPath)).toBe(true);

  // Every row's icon and path start at the same x, however long the
  // path. Spare width goes to the path, not into the gaps before it.
  for (const part of [".duplicate-file-icon-img", ".duplicate-file-path"]) {
    const long = await rect(longRow.locator(part));
    const short = await rect(shortRow.locator(part));
    expect(Math.abs(long.x - short.x), part).toBeLessThan(1);
  }
  // That check needs a row with spare width to misplace.
  expect(await overflows(shortRow.locator(".duplicate-file-path"))).toBe(false);

  // Actions show only on hover, so they hold no width until then: a
  // truncated path runs to the row's padding.
  await page.mouse.move(0, 0);
  const actions = longRow.locator(".duplicate-file-actions");
  await expect(actions).toHaveCSS("opacity", "0");
  const row = await rect(longRow);
  const padding = await longRow.evaluate((el) => parseFloat(getComputedStyle(el).paddingRight));
  expect(Math.abs((await rect(longPath)).right - (row.right - padding))).toBeLessThan(2);

  // On hover they sit at the row's end, over the path.
  await longRow.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  expect(Math.abs((await rect(actions)).right - (row.right - padding))).toBeLessThan(2);
  await longRow.getByRole("button", { name: "Reveal" }).hover();
  await expect(actions).toHaveCSS("opacity", "1");

  // Selecting a copy brings up the bulk bar. It keeps its own height at
  // the bottom of the view, and the list fills the space above it.
  await shortRow.locator(".duplicate-file-checkbox input").check();
  const bulkBar = page.getByRole("region", { name: "Bulk actions" });
  await expect(bulkBar).toBeVisible();
  const view = await rect(page.locator(".duplicates-view"));
  const bar = await rect(bulkBar);
  const list = await rect(page.locator(".duplicates-list-scroll"));
  expect(bar.height).toBeLessThan(80);
  expect(Math.abs(bar.y + bar.height - (view.y + view.height))).toBeLessThan(1);
  expect(Math.abs(list.y + list.height - bar.y)).toBeLessThan(1);
});
