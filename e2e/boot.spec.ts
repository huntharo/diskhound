import { expect, test } from "./fixtures/electron-app";

const PLATFORM = process.platform === "win32" || process.platform === "darwin" ? process.platform : "linux";

test("first launch opens the drive picker on an isolated profile", async ({ launch }) => {
  const { app, page, userDataDir } = await launch();

  const main = await app.evaluate(({ app: electronApp }) => ({
    userData: electronApp.getPath("userData"),
    hasLock: electronApp.hasSingleInstanceLock(),
  }));
  expect(main.userData).toBe(userDataDir);
  expect(main.hasLock).toBe(true);

  // The preload bridge is up and reports the right platform.
  expect(await page.evaluate(() => window.diskhound.platform)).toBe(PLATFORM);

  // No scan history, so the picker replaces the startup splash.
  await expect(page.locator(".picker-card")).toBeVisible();
  await expect(page.getByRole("button", { name: "Browse for folder..." })).toBeVisible();
  await expect(page.locator(".tab-status")).toHaveText("Ready");
});

// The single-instance lock is keyed on userData. If it were not, the
// second launch here, or any launch while the developer has DiskHound
// open, would hand off to the first instance and exit.
test("two profiles run side by side", async ({ launch }) => {
  const first = await launch();
  const second = await launch();

  const userData = await Promise.all(
    [first, second].map(({ app }) => app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"))),
  );
  expect(userData).toEqual([first.userDataDir, second.userDataDir]);
  await expect(first.page.locator(".picker-card")).toBeVisible();
  await expect(second.page.locator(".picker-card")).toBeVisible();
});
