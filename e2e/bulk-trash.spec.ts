import { expect, test } from "./fixtures/electron-app";
import { openTab, scanFolderFromPicker, waitForScanComplete } from "./fixtures/steps";

test("bulk trash shows progress, cancels queued files, reports failures, and offers refresh", async ({ launch, scanTree }) => {
  const handle = await launch();
  await scanFolderFromPicker(handle, scanTree.root);
  await openTab(handle.page, "Largest Files");
  // Hold OS actions so the test can inspect progress and cancel deterministically.
  // No real files are trashed; a rescan should restore all five fixture rows.
  await handle.app.evaluate(({ ipcMain }) => {
    const state = globalThis as typeof globalThis & { releaseTrash?: () => void; trashCalls?: number };
    state.trashCalls = 0;
    const gate = new Promise<void>((resolve) => { state.releaseTrash = resolve; });
    ipcMain.removeHandler("diskhound:trash-path");
    ipcMain.handle("diskhound:trash-path", async () => {
      const index = ++state.trashCalls!;
      await gate;
      return index === 1 ? { ok: false, message: "Test drive is read-only" } : { ok: true, message: "Moved to trash" };
    });
  });
  const { page } = handle;
  await page.getByRole("button", { name: "Select page", exact: true }).click();
  await page.getByRole("button", { name: "Trash selected", exact: true }).click();
  const status = page.locator(".file-view [role=status]");
  await expect(status).toContainText("Moving to Trash: 0 of 5 files");
  await expect(page.getByRole("button", { name: "Trash selected", exact: true })).toBeDisabled();
  await expect.poll(() => handle.app.evaluate(() => (globalThis as any).trashCalls)).toBe(4);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(status).toContainText("Cancelling");
  await handle.app.evaluate(() => (globalThis as any).releaseTrash());
  await expect(status).toContainText("Cancelled — Trashed 3 of 5 files; 1 failed; 1 unprocessed");
  await expect(page.locator(".toast-body")).toContainText("Test drive is read-only");
  await expect(page.locator(".file-row .deleted-path-badge")).toHaveCount(3);
  expect(await handle.app.evaluate(() => (globalThis as any).trashCalls)).toBe(4);
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(page.locator(".toast")).toHaveCount(0);
  // Failed and unprocessed files remain selected for retry.
  await page.getByRole("button", { name: "Trash selected", exact: true }).click();
  await expect(status).toContainText("Done — Trashed 2 of 2 files");
  await expect(page.locator(".file-row .deleted-path-badge")).toHaveCount(5);
  await page.getByRole("button", { name: "Rescan to refresh", exact: true }).click();
  await waitForScanComplete(page);
  await expect(page.locator(".file-row .file-name-text")).toHaveCount(5);
  await expect(page.locator(".file-row .deleted-path-badge")).toHaveCount(0);
});
