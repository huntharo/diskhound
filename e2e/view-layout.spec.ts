import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./fixtures/electron-app";
import { openTab, scanFolderFromPicker, waitForScanComplete } from "./fixtures/steps";

// Views whose children come and go (a search bar, an optional header, a
// column header only one mode has) keep their rows: the part that
// scrolls or draws takes the spare height, and nothing else stretches.

async function rect(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${locator} has no box`);
  return { top: box.y, bottom: box.y + box.height, height: box.height };
}

/** `a` ends where `b` starts, give or take a rounding pixel. */
function stacked(a: { bottom: number }, b: { top: number }) {
  expect(Math.abs(a.bottom - b.top)).toBeLessThan(1.5);
}

async function shell(page: Page) {
  return {
    tabs: await rect(page.locator(".app-shell > .tab-bar")),
    view: await rect(page.locator(".app-shell > .view-container")),
    status: await rect(page.locator(".app-shell > .status-bar")),
  };
}

test("the search bar opens above the tabs without taking their rows", async ({ launch, scanTree }) => {
  const handle = await launch();
  const { page } = handle;
  await scanFolderFromPicker(handle, scanTree.root);
  await openTab(page, "Largest Files");
  const closed = await shell(page);

  // The title ends in ⌘+F or Ctrl+F, by platform.
  await page.getByTitle(/^Search the scan index/).click();
  const search = await rect(page.locator(".app-shell > .search-bar"));
  const open = await shell(page);
  // Header, search bar, tabs, view and status bar, top to bottom. The
  // search bar's height comes out of the view.
  stacked(search, open.tabs);
  stacked(open.tabs, open.view);
  stacked(open.view, open.status);
  expect(open.tabs.height).toBeCloseTo(closed.tabs.height, 0);
  expect(open.status.top).toBeCloseTo(closed.status.top, 0);
  expect(open.view.height).toBeCloseTo(closed.view.height - search.height, 0);
  await expect(page.locator(".file-row").first()).toBeVisible();
});

test("the Changes list fills the detail pane under a short diff", async ({ launch, scanTree }) => {
  const handle = await launch();
  const { page } = handle;
  await scanFolderFromPicker(handle, scanTree.root);

  writeFileSync(join(scanTree.root, "added.bin"), randomBytes(512 * 1024));
  rmSync(join(scanTree.root, "docs", "notes.txt"));
  await page.locator(".scan-controls").getByRole("button", { name: "Rescan" }).click();
  await expect
    .poll(() => page.evaluate((root) => window.diskhound.getScanHistory(root).then((h) => h.length), scanTree.root), {
      timeout: 45_000,
    })
    .toBe(2);
  await waitForScanComplete(page);
  await openTab(page, "Changes");

  // Header, tabs, then the list down to the bottom of the pane. The
  // "Comparing" header is the child the old two-row grid had no row for.
  const detail = page.locator(".changes-detail");
  const header = await rect(detail.locator(".changes-comparing-header"));
  const tabs = await rect(detail.locator(".changes-detail-tabs"));
  const list = await rect(detail.locator(".changes-detail-scroll"));
  await expect(detail.locator(".changes-row")).toHaveCount(2);
  stacked(header, tabs);
  stacked(tabs, list);
  expect(Math.abs(list.bottom - (await rect(detail)).bottom)).toBeLessThan(1.5);
  expect(tabs.height).toBeLessThan(60);
});

test("the Processes treemap grows back with the window", async ({ launch, scanTree }) => {
  const handle = await launch();
  const { app, page } = handle;
  await scanFolderFromPicker(handle, scanTree.root);
  await openTab(page, "Processes");
  await page.getByTitle(/^Memory treemap/).click();

  const treemap = page.locator(".memory-view > .memory-treemap-container");
  await expect(treemap).toBeVisible();
  // The treemap runs from the toolbar to the bottom of the view.
  const fills = async () => {
    const toolbar = await rect(page.locator(".memory-view > .memory-toolbar"));
    const view = await rect(page.locator(".memory-view"));
    const map = await rect(treemap);
    return Math.abs(map.top - toolbar.bottom) < 1.5 && Math.abs(map.bottom - view.bottom) < 1.5;
  };
  await expect.poll(fills).toBe(true);

  // Its canvas is sized to whatever it was given, so a treemap that took
  // its height from its content never grew back after a shrink.
  const win = await app.browserWindow(page);
  const [width, height] = await win.evaluate((w) => w.getSize());
  await win.evaluate((w) => w.setSize(960, 640));
  await expect.poll(fills).toBe(true);
  await win.evaluate((w, [wide, tall]) => w.setSize(wide!, tall!), [width, height]);
  await expect.poll(() => page.evaluate(() => innerHeight)).toBeGreaterThan(640);
  await expect.poll(fills).toBe(true);
});
