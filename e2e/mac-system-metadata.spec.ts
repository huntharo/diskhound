import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { scanFolderFromPicker } from "./fixtures/steps";

test.skip(process.platform !== "darwin", "macOS system metadata categories");
test.afterEach(({}, info) => {
  rmSync(info.outputPath("tree"), { recursive: true, force: true });
});

test("native scan exposes filesystem event history and read-only guidance", async ({ launch }, info) => {
  const root = info.outputPath("tree", ".fseventsd");
  mkdirSync(root, { recursive: true });
  const log = join(root, "log");
  writeFileSync(log, randomBytes(12 * 1024 * 1024));
  const handle = await launch();
  const snapshot = await scanFolderFromPicker(handle, root);
  expect(snapshot.macSystemMetadata?.[0]).toMatchObject({
    kind: "fsevents", path: root, bytes: statSync(log).blocks * 512, status: "complete",
  });
  expect(snapshot.macSystemMetadata?.[1].status).toBe("outside-scan");
  const card = handle.page.getByRole("region", { name: "macOS system metadata", exact: true });
  await expect(card).toBeVisible();
  await expect(card.locator(".storage-card-col").nth(0)).toContainText("12.6 MB");
  await expect(card.locator(".storage-card-col").nth(1)).toContainText("Outside this scan");
  await card.getByRole("button", { name: "Guidance", exact: true }).click();
  await expect(card).toContainText("FSEventsPurgeEventsForDeviceUpToEventId");
  await expect(card).toContainText("DiskHound does not purge this history");
  await handle.page.screenshot({ path: info.outputPath("system-metadata.png") });
});

test("native scan shows Spotlight bytes without inferring indexing status", async ({ launch }, info) => {
  const root = info.outputPath("tree", ".Spotlight-V100");
  mkdirSync(root, { recursive: true });
  const store = join(root, "store.db");
  writeFileSync(store, randomBytes(8 * 1024 * 1024));
  const handle = await launch();
  const snapshot = await scanFolderFromPicker(handle, root);
  expect(snapshot.macSystemMetadata?.[1]).toMatchObject({
    kind: "spotlight", path: root, bytes: statSync(store).blocks * 512, status: "complete",
  });
  const card = handle.page.getByRole("region", { name: "macOS system metadata", exact: true });
  await expect(card.locator(".storage-card-col").nth(1)).toContainText("8.4 MB");
  await card.getByRole("button", { name: "Guidance", exact: true }).click();
  await expect(card).toContainText("Removing an index alone does not disable indexing");
  await expect(card).toContainText("already included in scanned file bytes");
});
