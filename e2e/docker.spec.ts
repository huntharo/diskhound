import { expect, test } from "./fixtures/electron-app";

test("Docker inventory is opt-in, paginated, and separates resources and usage", async ({ launch }, testInfo) => {
  const { app, page } = await launch();
  // Replace IPC before opening the tab: this spec never contacts a Docker daemon.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("diskhound:docker-inventory");
    ipcMain.handle("diskhound:docker-inventory", () => ({ ok: true, inventory: {
      context: "test-local", endpoint: "unix:///test/docker.sock", collectedAt: new Date().toISOString(),
      images: Array.from({ length: 101 }, (_, i) => ({ id: `sha256:${i.toString(16).padStart(64, "0")}`, name: `test:${i}`, logicalSize: "100MB", sharedSize: "80MB", uniqueSize: "20MB", containers: i === 0 ? 1 : i === 1 ? null : 0, provenance: "unknown" })),
      usage: ["Images", "Containers", "Local Volumes", "Build Cache"].map(type => ({ type, total: "101", active: "1", size: "100MB", reclaimable: "20MB" })),
    } }));
    ipcMain.removeHandler("diskhound:docker-remove-image");
    ipcMain.handle("diskhound:docker-remove-image", () => ({ ok: false, message: "Removal cancelled." }));
  });
  await page.locator(".tab-btn").filter({ hasText: "Docker" }).click();
  await expect(page.getByRole("heading", { name: "Docker storage" })).toBeVisible();
  await expect(page.getByText("test-local", { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "Refresh Docker inventory" }).click();
  await expect(page.getByText("test-local", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Build Cache", exact: true })).toBeVisible();
  const rows = page.locator(".docker-table tbody tr");
  await expect(rows).toHaveCount(100);
  await expect(rows.nth(0).getByRole("button")).toBeDisabled();
  await expect(rows.nth(1).getByRole("button")).toBeDisabled();
  await expect(rows.nth(2).getByRole("button")).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("docker-inventory.png") });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await rows.nth(0).getByRole("button").click();
  await expect(page.getByRole("status")).toHaveText("Removal cancelled.");
  await expect(rows).toHaveCount(0);
});
