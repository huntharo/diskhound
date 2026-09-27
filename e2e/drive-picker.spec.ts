import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { expect, test } from "./fixtures/electron-app";

// Synthetic df output exercises discovery in the built main process, without
// exposing the developer's actual mount names in screenshots.
test("Time Machine snapshots never appear in the drive picker", async ({ launch }, testInfo) => {
  test.skip(process.platform !== "darwin", "macOS mount discovery");
  const bin = testInfo.outputPath("bin");
  mkdirSync(bin, { recursive: true });
  const mounts = ["/", "/Volumes/Archive", "/Volumes/Media Share",
    "/Volumes/.timemachine/id/2026-09-09-212616.backup",
    "/Volumes/com.apple.TimeMachine.localsnapshots/Backups.backupdb/Example Mac"];
  const table = ["Filesystem 1024-blocks Used Available Capacity Mounted on",
    ...mounts.map((mount, i) => `/dev/disk${i}s1 1000000000 400000000 600000000 40% ${mount}`),
  ].join("\n");
  writeFileSync(join(bin, "df"), `#!/bin/sh\ncat <<'DF_OUTPUT'\n${table}\nDF_OUTPUT\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
    const { page } = await launch();
    await expect(page.locator(".drive-card")).toHaveCount(3);
    await expect(page.locator('.drive-card[title="/"]')).toBeInViewport();
    expect(await page.evaluate(() => window.diskhound.getDiskSpace()).then(
      (drives) => drives.map(({ drive }) => drive),
    )).toEqual(mounts.slice(0, 3));
    await page.screenshot({ animations: "disabled", scale: "css", path: testInfo.outputPath("time-machine-filtered.png") });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("a long drive list keeps the system drive and folder picker reachable", async ({ launch }, testInfo) => {
  const { app, page } = await launch();
  const root = process.platform === "win32" ? "C:" : "/";
  const drives = [root, ...Array.from({ length: 24 }, (_, i) => `/Volumes/Archive ${i + 1}`)]
    .map((drive) => ({ drive, totalBytes: 1e12, freeBytes: 6e11, usedBytes: 4e11,
      usedPercent: 40, timestamp: Date.now() }));
  await app.evaluate(({ ipcMain }, syntheticDrives) => {
    ipcMain.removeHandler("diskhound:get-disk-space");
    ipcMain.handle("diskhound:get-disk-space", () => syntheticDrives);
  }, drives);
  await page.reload();
  await expect(page.locator(".drive-card")).toHaveCount(25);
  await page.screenshot({ animations: "disabled", scale: "css", path: testInfo.outputPath("long-drive-list-top.png") });
  await expect(page.locator(".picker-header")).toBeInViewport();
  await expect(page.locator(".drive-card").first()).toBeInViewport();
  // trial performs hit-testing without starting a real scan of the host.
  await page.locator(".drive-card").first().click({ trial: true });
  await page.locator(".picker-backdrop").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator(".drive-card").last()).toBeInViewport();
  await expect(page.getByRole("button", { name: "Browse for folder..." })).toBeInViewport();
  await page.locator(".picker-backdrop").evaluate((el) => { el.scrollTop = 0; });
  await expect(page.locator(".drive-card").first()).toBeInViewport();
});
