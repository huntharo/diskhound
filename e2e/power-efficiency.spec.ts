import { availableParallelism } from "node:os";

import { expect, test } from "./fixtures/electron-app";
import { scanFolderFromPicker } from "./fixtures/steps";

// The header's Power Efficiency menu saves a preset, and the next scan's
// walker runs that many workers. The Unix walker logs its count to
// crash.log. The Windows walkers hand a tree this small to the
// sequential walker, which logs none.
test("a Power Efficiency choice reaches the next scan's walker", async ({ launch, scanTree }) => {
  test.skip(process.platform === "win32", "the Windows walker logs no worker count for a small tree");
  const cpus = availableParallelism();
  const handle = await launch();
  const { page } = handle;
  const walking = async () => ((await page.evaluate(() => window.diskhound.getCrashLog())).text
    .match(/walking with dua-core, \d+ threads/g) ?? []);

  await scanFolderFromPicker(handle, scanTree.root);
  // Balanced by default: 4 workers, or every CPU on a smaller machine.
  expect(await walking()).toEqual([`walking with dua-core, ${Math.min(4, cpus)} threads`]);

  const gauge = page.locator(".header .power-btn");
  await expect(gauge).toHaveAttribute("aria-label", /^Power Efficiency: (Balanced|Miser), /);
  await gauge.click();
  await expect(page.getByRole("menu", { name: "Power Efficiency" })).toBeVisible();
  await page.getByRole("menuitemradio", { name: /^Miser/ }).click();
  await expect(page.getByRole("menu", { name: "Power Efficiency" })).toBeHidden();
  const miser = Math.min(2, cpus);
  await expect(page.locator(".toast-title")).toHaveText(`Miser (${miser} worker${miser === 1 ? "" : "s"}) from the next scan`);
  await expect(gauge.locator(".power-gauge i.lit")).toHaveCount(1);

  await page.getByRole("button", { name: "Rescan now" }).click();
  await expect.poll(walking, { timeout: 45_000 }).toEqual([
    `walking with dua-core, ${Math.min(4, cpus)} threads`,
    `walking with dua-core, ${miser} threads`,
  ]);
  const settings = await page.evaluate(() => window.diskhound.getSettings());
  expect(settings.scanning.powerEfficiency).toBe("miser");
});
