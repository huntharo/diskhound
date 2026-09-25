import { expect, test } from "./fixtures/electron-app";
import { openTab, scanFolderFromPicker, waitForScanComplete } from "./fixtures/steps";

test("scans a folder chosen from the drive picker", async ({ launch, scanTree }) => {
  const handle = await launch();
  const snapshot = await scanFolderFromPicker(handle, scanTree.root);

  expect(snapshot.status).toBe("done");
  expect(snapshot.engine).toBe("native-sidecar");
  expect(snapshot.errorMessage).toBeNull();
  expect(snapshot.filesVisited).toBe(scanTree.files.length);
  expect(snapshot.bytesSeen).toBeGreaterThanOrEqual(scanTree.totalBytes);
  expect(snapshot.largestFiles.map((file) => file.name)).toEqual(scanTree.files.map((file) => file.name));

  const { page } = handle;
  await expect(page.locator(".picker-card")).toBeHidden();

  await openTab(page, "Largest Files");
  await expect(page.locator(".file-row .file-name-text")).toHaveText(
    scanTree.files.map((file) => file.name),
  );

  await openTab(page, "Folders");
  for (const folder of scanTree.folders) {
    await expect(page.locator(".folder-row-name", { hasText: folder })).toBeVisible();
  }
});

test("restores the last scan after a restart", async ({ launch, scanTree }) => {
  const first = await launch();
  const scanned = await scanFolderFromPicker(first, scanTree.root);
  await first.close();

  const second = await launch({ dataDir: first.dataDir });
  const restored = await waitForScanComplete(second.page);
  expect(restored.rootPath).toBe(scanned.rootPath);
  expect(restored.filesVisited).toBe(scanned.filesVisited);
  await expect(second.page.locator(".picker-card")).toBeHidden();

  await openTab(second.page, "Largest Files");
  await expect(second.page.locator(".file-row .file-name-text")).toHaveText(
    scanTree.files.map((file) => file.name),
  );
});
