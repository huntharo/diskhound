import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "./fixtures/electron-app";
import { openTab, scanFolderFromPicker, waitForScanComplete } from "./fixtures/steps";

const SIDECAR_SUFFIX = ".folder-tree.ndjson.gz";

// The native scanner writes a folder-tree sidecar next to the scan
// index. Without it, main rebuilds the tree from the index in the
// folder-tree worker. That rebuild used to drop the worker's result:
// terminate() exited the worker with code 1 before the result settled,
// the runtime reported it as out of memory, and Folders showed "This
// folder appears empty in the scan index".
test("rebuilds Folders from the scan index when the sidecar is missing", async ({ launch, scanTree }) => {
  const first = await launch();
  const scanned = await scanFolderFromPicker(first, scanTree.root);
  await first.close();

  const indexDir = join(first.userDataDir, "scan-indexes");
  const sidecars = readdirSync(indexDir).filter((name) => name.endsWith(SIDECAR_SUFFIX));
  expect(sidecars).toHaveLength(1);
  const scanId = sidecars[0].slice(0, -SIDECAR_SUFFIX.length);
  rmSync(join(indexDir, sidecars[0]));
  // Both launches append to the same crash.log.
  const crashLogPath = join(first.userDataDir, "crash.log");
  const firstLaunchLog = existsSync(crashLogPath) ? readFileSync(crashLogPath, "utf8").length : 0;

  const second = await launch({ dataDir: first.dataDir });
  const restored = await waitForScanComplete(second.page);
  expect(restored.rootPath).toBe(scanned.rootPath);

  await openTab(second.page, "Folders");
  for (const folder of scanTree.folders) {
    await expect(second.page.locator(".folder-row-name", { hasText: folder })).toBeVisible();
  }
  // Main saves the rebuilt tree, so the next launch reads the sidecar
  // instead of rebuilding again.
  await expect.poll(() => existsSync(join(indexDir, sidecars[0]))).toBe(true);

  // The rows came from the rebuild, not from a sidecar.
  const relaunchLog = readFileSync(crashLogPath, "utf8").slice(firstLaunchLog);
  expect(relaunchLog).toContain(`[folder-tree-sidecar-read] scanId=${scanId} file missing`);
});
