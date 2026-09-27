import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { openTab, scanFolderFromPicker } from "./fixtures/steps";

test.afterEach(({}, info) => rmSync(info.outputPath("inventory"), { recursive: true, force: true }));

test("separates VM disks and snapshots from installers and camera images", async ({ launch }, info) => {
  const root = info.outputPath("inventory");
  const vms = [
    ".tart/vms/dev/disk.img", "VirtualBox VMs/test/Snapshots/state.sav",
    "Windows.vmwarevm/memory.vmem", "Linux.utm/attached.iso", "win.avhdx",
    "linux.qcow2", "Parallels.pvm/data.hds",
  ];
  const installers = ["Downloads/setup.dmg", "Downloads/linux.iso"];
  for (const file of [...vms, ...installers, "photos/camera.raw", "misc/unknown.img"]) {
    const path = join(root, ...file.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, randomBytes(4096));
    utimesSync(path, new Date(2020, 0, 1), new Date(2020, 0, 1));
  }
  const handle = await launch();
  const snapshot = await scanFolderFromPicker(handle, root);
  await openTab(handle.page, "Largest Files");
  await handle.page.getByRole("button", { name: "Virtual machines", exact: true }).click();
  await expect(handle.page.locator(".file-row")).toHaveCount(vms.length);
  await expect(handle.page.getByText(/Manage snapshots in the VM application/)).toBeVisible();
  const gridRows = () => handle.page.locator(".file-view").evaluate((el) =>
    getComputedStyle(el).gridTemplateRows.split(" ").length);
  expect(await gridRows()).toBe(5);
  // Exercise the merged bulk-progress row alongside the VM notice, without deleting files.
  await handle.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("diskhound:trash-path");
    ipcMain.handle("diskhound:trash-path", () => ({ ok: false, message: "Test: keep VM files" }));
  });
  await handle.page.getByRole("button", { name: "Select page", exact: true }).click();
  await handle.page.getByRole("button", { name: "Trash selected", exact: true }).click();
  const status = handle.page.locator(".file-view [role=status]");
  await expect(status).toContainText("Done");
  expect(await gridRows()).toBe(6);
  const statusBox = await status.boundingBox();
  const rowBox = await handle.page.locator(".file-row").first().boundingBox();
  expect(rowBox!.y).toBeGreaterThanOrEqual(statusBox!.y + statusBox!.height);
  expect(rowBox!.y - (statusBox!.y + statusBox!.height)).toBeLessThan(60);
  await handle.page.getByRole("button", { name: "Installers", exact: true }).click();
  await expect(handle.page.locator(".file-row")).toHaveCount(2);
  expect((await handle.page.locator(".file-row .file-name-text").allTextContents()).sort()).toEqual(["linux.iso", "setup.dmg"]);
  await handle.page.getByRole("button", { name: "Images", exact: true }).click();
  await expect(handle.page.locator(".file-row .file-name-text")).toHaveText(["camera.raw"]);

  const analysis = await handle.page.evaluate((path) => window.diskhound.analyzeCleanup(path), snapshot.rootPath!);
  expect(analysis.suggestions.find((s) => s.category === "installer-leftovers")?.paths.sort()).toEqual(installers.map((p) => join(root, ...p.split("/"))).sort());
  expect(analysis.suggestions.flatMap((s) => s.paths)).toHaveLength(2);

  await openTab(handle.page, "Overview");
  await handle.page.getByRole("button", { name: "Virtual machines", exact: true }).click();
  await expect(handle.page.getByText(/Manage snapshots in the VM application/)).toBeVisible();
  const sidebar = handle.page.locator(".ext-sidebar");
  await expect(sidebar.getByText("Extensions · sample", { exact: true })).toBeVisible();
  await expect(sidebar.getByRole("note")).toContainText("Smaller files may be missing");
  await handle.page.getByRole("button", { name: "Archives", exact: true }).click();
  await expect(sidebar.getByText("No matching extensions in the loaded sample", { exact: true })).toBeVisible();
  await handle.page.locator(".overview-filter-chips").getByRole("button", { name: "All", exact: true }).click();
  await expect(sidebar.getByText("Extensions", { exact: true })).toBeVisible();
  await expect(sidebar.getByRole("note")).toHaveCount(0);
});
