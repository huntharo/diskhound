import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ScanSnapshot } from "../src/shared/contracts";
import { expect, test, type AppHandle } from "./fixtures/electron-app";
import { openTab, scanFolderFromPicker, waitForScanComplete } from "./fixtures/steps";

// The scanner JSON-escapes names in its index and folder-tree sidecar:
// \" and \\, plus \t, \n and \u00XX for control characters. Each reader
// has to decode all of them, or Folders shows the escape text and hands
// Reveal, Open and delete a path that doesn't exist.
const DIR = 'tab\tand "quotes"';
const FILE = "new\nline\u0001.bin";
const FILE_BYTES = 64 * 1024;

test.skip(process.platform === "win32", "NTFS names can't hold control characters or quotes");

// Keep the tree out of the uploaded CI artifacts.
test.afterEach(({}, testInfo) => {
  rmSync(testInfo.outputPath("names"), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function writeTree(root: string): void {
  mkdirSync(join(root, DIR), { recursive: true });
  writeFileSync(join(root, DIR, FILE), randomBytes(FILE_BYTES));
}

async function expectRealNames({ page }: AppHandle, snapshot: ScanSnapshot): Promise<void> {
  const rootPath = snapshot.rootPath;
  if (rootPath === null) throw new Error("scan has no root path");

  // What Folders hands Reveal, Open and delete: paths that exist.
  const top = await page.evaluate((root) => window.diskhound.getFolderChildren(root, root), rootPath);
  expect(top.dirs.map((dir) => dir.path)).toEqual([join(rootPath, DIR)]);
  const inner = await page.evaluate(
    ([root, dir]) => window.diskhound.getFolderChildren(root, dir),
    [rootPath, join(rootPath, DIR)] as const,
  );
  expect(inner.files.map((file) => file.path)).toEqual([join(rootPath, DIR, FILE)]);
  for (const path of [...top.dirs.map((dir) => dir.path), ...inner.files.map((file) => file.path)]) {
    expect(existsSync(path), path).toBe(true);
  }

  // What the user reads. toHaveText would fold the tab and newline to
  // spaces, so compare textContent exactly.
  await openTab(page, "Folders");
  const dirRow = page.locator(".folder-row-clickable .folder-row-name").filter({ hasText: "quotes" });
  await expect(dirRow).toHaveCount(1);
  expect(await dirRow.textContent()).toBe(DIR);
  await dirRow.click();
  // A folder with no subfolders opens with its file list expanded.
  const fileName = page.locator(".loose-file-name");
  await expect(fileName).toHaveCount(1);
  expect(await fileName.textContent()).toBe(FILE);
}

test("shows and targets names with control characters and quotes", async ({ launch }, testInfo) => {
  const root = testInfo.outputPath("names");
  writeTree(root);
  const handle = await launch();
  const snapshot = await scanFolderFromPicker(handle, root);
  expect(snapshot.filesVisited).toBe(1);
  await expectRealNames(handle, snapshot);
});

test("rebuilds Folders from the scan index with the same names", async ({ launch }, testInfo) => {
  const root = testInfo.outputPath("names");
  writeTree(root);
  const first = await launch();
  const scanned = await scanFolderFromPicker(first, root);
  await first.close();

  // Without the folder-tree sidecar, Folders is rebuilt from the scan
  // index by the folder-tree worker.
  const indexDir = join(first.userDataDir, "scan-indexes");
  const sidecars = readdirSync(indexDir).filter((name) => name.endsWith(".folder-tree.ndjson.gz"));
  expect(sidecars.length).toBeGreaterThan(0);
  for (const name of sidecars) rmSync(join(indexDir, name));

  const second = await launch({ dataDir: first.dataDir });
  const restored = await waitForScanComplete(second.page);
  expect(restored.rootPath).toBe(scanned.rootPath);
  await expectRealNames(second, restored);
});
