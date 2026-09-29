import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./fixtures/electron-app";
import {
  expectHiddenActionsPassClicks,
  expectShownActionsCatchClicks,
  openTab,
  scanFolderFromPicker,
  waitForScanComplete,
} from "./fixtures/steps";

// Row buttons that show only on hover (Largest Files, Changes) hold no
// column of their own. They float over the end of the name and path, so
// the columns after it (Type and Age, the size delta) stay put, line up
// from row to row and with the header, and stay visible on hover.
// Duplicates has its own spec, duplicates-layout.spec.ts.
const KiB = 1024;
// Long enough that the path runs under the buttons.
const LONG_DIR = "a-folder-name-long-enough-that-its-path-runs-under-the-row-buttons-".padEnd(100, "x");

test.afterEach(({}, testInfo) => {
  rmSync(testInfo.outputPath("t"), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function rect(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${locator} has no box`);
  return { left: box.x, right: box.x + box.width };
}

function near(actual: number, expected: number, what: string) {
  expect(Math.abs(actual - expected), `${what}: ${actual} vs ${expected}`).toBeLessThan(1.5);
}

async function hoverShows(page: Page, row: Locator, actions: Locator) {
  await page.mouse.move(0, 0);
  await expectHiddenActionsPassClicks(page, actions);
  await row.hover();
  await expectShownActionsCatchClicks(page, actions);
}

test("Largest Files columns line up with their header", async ({ launch }, testInfo) => {
  const root = testInfo.outputPath("t");
  mkdirSync(join(root, LONG_DIR), { recursive: true });
  writeFileSync(join(root, LONG_DIR, "long.bin"), randomBytes(768 * KiB));
  writeFileSync(join(root, "short.bin"), randomBytes(512 * KiB));

  const handle = await launch();
  const { app, page } = handle;
  await scanFolderFromPicker(handle, root);
  await openTab(page, "Largest Files");

  const header = page.locator(".file-col-header");
  const row = page.locator(".file-row").filter({ hasText: "long.bin" });
  const columns = async () => {
    for (const [field, cell] of [["size", ".file-size"], ["ext", ".file-ext"], ["age", ".file-age"]] as const) {
      const label = header.locator(`[data-field="${field}"]`);
      const data = row.locator(cell);
      // The 960 px layout hides Age in both.
      if (!(await data.isVisible())) {
        await expect(label).toBeHidden();
        continue;
      }
      near((await rect(label)).right, (await rect(data)).right, `${field} right edge`);
    }
  };
  await columns();

  // The name column runs to the Type column; the buttons sit over its
  // end on hover, and Type stays visible.
  const info = await rect(row.locator(".file-info"));
  const ext = await rect(row.locator(".file-ext"));
  near(info.right + 8, ext.left, "name column end");
  const actions = row.locator(".file-actions");
  await hoverShows(page, row, actions);
  near((await rect(actions)).right, info.right, "buttons end");

  // The narrowest window switches to five columns, header included.
  await (await app.browserWindow(page)).evaluate((w) => w.setSize(960, 720));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(960);
  await expect(row.locator(".file-age")).toBeHidden();
  await columns();
});

test("Changes columns line up whatever the row's kind", async ({ launch }, testInfo) => {
  const root = testInfo.outputPath("t");
  mkdirSync(join(root, LONG_DIR), { recursive: true });
  writeFileSync(join(root, LONG_DIR, "grows.bin"), randomBytes(512 * KiB));
  writeFileSync(join(root, "goes.bin"), randomBytes(256 * KiB));

  const handle = await launch();
  const { page } = handle;
  await scanFolderFromPicker(handle, root);
  appendFileSync(join(root, LONG_DIR, "grows.bin"), randomBytes(256 * KiB));
  rmSync(join(root, "goes.bin"));
  writeFileSync(join(root, "arrives.bin"), randomBytes(384 * KiB));
  await page.locator(".scan-controls").getByRole("button", { name: "Rescan" }).click();
  await expect
    .poll(() => page.evaluate((dir) => window.diskhound.getScanHistory(dir).then((h) => h.length), root), {
      timeout: 45_000,
    })
    .toBe(2);
  await waitForScanComplete(page);
  await openTab(page, "Changes");

  const rows = page.locator(".changes-row");
  await expect(rows).toHaveCount(3);
  // A removed file has no buttons, and the sizes read "a", "b → c" or
  // "a"; neither moves the delta or sizes column.
  await expect(rows.filter({ hasText: "goes.bin" }).locator(".changes-row-actions")).toHaveCount(0);
  const lefts = await rows.evaluateAll((els) => els.map((el) => ({
    delta: el.querySelector(".changes-row-delta")!.getBoundingClientRect().left,
    sizes: el.querySelector(".changes-row-sizes")!.getBoundingClientRect().left,
  })));
  for (const { delta, sizes } of lefts.slice(1)) {
    near(delta, lefts[0]!.delta, "delta column");
    near(sizes, lefts[0]!.sizes, "sizes column");
  }

  // On hover the buttons sit over the end of the name and path, before
  // the delta.
  const grew = rows.filter({ hasText: "grows.bin" });
  const actions = grew.locator(".changes-row-actions");
  await hoverShows(page, grew, actions);
  near((await rect(actions)).right, (await rect(grew.locator(".changes-row-info"))).right, "buttons end");
  expect((await rect(actions)).right).toBeLessThan((await rect(grew.locator(".changes-row-delta"))).left);
});
