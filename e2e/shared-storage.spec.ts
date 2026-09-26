import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures/electron-app";
import { openTab, scanFolderFromPicker } from "./fixtures/steps";

// Hardlinks and APFS clones share storage, so deleting one copy frees
// less than its size. The native scanner writes what it knows to the
// scan index (`i` for every name of a multi-link file, `k`/`v` for
// clones), and Duplicates, the Overview card and Dev Artifacts read it
// back. Duplicates only counts files of 1 MiB and up, and every size is
// a 4 KiB multiple, so allocated equals logical.
const KiB = 1024;
const DATA_BYTES = 2048 * KiB;
const OTHER_BYTES = 256 * KiB;

// Keep the trees out of the uploaded CI artifacts.
test.afterEach(({}, testInfo) => {
  rmSync(testInfo.outputPath("tree"), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** One file, a second name for it made by `secondName`, and a plain
 *  byte-for-byte copy. Returns the three paths. */
function writeCopies(root: string, secondName: (from: string, to: string) => void) {
  const data = randomBytes(DATA_BYTES);
  const paths = {
    original: join(root, "a", "data.bin"),
    second: join(root, "b", "data-second.bin"),
    copy: join(root, "c", "data-copy.bin"),
  };
  for (const path of Object.values(paths)) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(paths.original, data);
  secondName(paths.original, paths.second);
  writeFileSync(paths.copy, data);
  return paths;
}

/** `cp -c` calls clonefile(2). Node's COPYFILE_FICLONE_FORCE returns
 *  ENOSYS on macOS. */
function cloneFile(from: string, to: string): void {
  execFileSync("cp", ["-c", from, to]);
}

/** Run a duplicate scan over the scan root from the Duplicates tab and
 *  expand the single group it should find. */
async function findOneDuplicateGroup(page: Page) {
  await openTab(page, "Duplicates");
  await page.getByRole("button", { name: "Scan for Duplicates", exact: true }).click();
  // Hashing waits on the index stream, slow on a cold Windows runner.
  await expect(page.locator(".duplicates-title")).toHaveText("1 duplicate group", { timeout: 45_000 });
  const group = page.locator(".duplicate-group");
  await group.locator(".duplicate-group-header").click();
  await expect(group.locator(".duplicate-file-row").first()).toBeVisible();
  return group;
}

test("lists a hardlinked file once and counts it as freeing nothing", async ({ launch }, testInfo) => {
  // Known gap: the Windows walkers mark later names `h:1` but write no
  // link id, so Duplicates lists both names at full size (3 copies,
  // 4.0 MB). Remove the mark once Windows index lines carry `i`.
  test.fail(process.platform === "win32", "Windows scan indexes carry no hardlink ids");

  const root = testInfo.outputPath("tree");
  const paths = writeCopies(root, linkSync);
  const handle = await launch();
  await scanFolderFromPicker(handle, root);
  const { page } = handle;

  const group = await findOneDuplicateGroup(page);
  // Both names of the hardlinked file fold into one entry, and deleting
  // that name frees nothing: the plain copy is all there is to reclaim.
  await expect(group.locator(".duplicate-copies-badge")).toHaveText("2 copies");
  await expect(group.locator(".duplicate-shared-badge")).toHaveText("hardlinked");
  await expect(group.locator(".duplicate-wasted")).toHaveText("2.0 MB wasted");
  await expect(page.locator(".duplicates-subtitle")).toHaveText("2.0 MB reclaimable");

  const rows = group.locator(".duplicate-file-row");
  await expect(rows).toHaveCount(2);
  const linked = rows.filter({ has: page.locator(".duplicate-sharing-badge") });
  await expect(linked.locator(".duplicate-sharing-badge")).toHaveText("hardlinked · frees nothing");
  expect([paths.original, paths.second]).toContain(await linked.locator(".duplicate-file-path").textContent());
  await expect(rows.filter({ hasText: paths.copy }).locator(".duplicate-sharing-badge")).toHaveCount(0);
});

test.describe("APFS clones", () => {
  test.skip(process.platform !== "darwin", "clonefile(2) is APFS-only");

  test("Duplicates counts clones at the bytes they free", async ({ launch }, testInfo) => {
    const root = testInfo.outputPath("tree");
    const paths = writeCopies(root, cloneFile);
    const handle = await launch();
    await scanFolderFromPicker(handle, root);
    const { page } = handle;

    const group = await findOneDuplicateGroup(page);
    // The original and its clone share every block, so each frees
    // nothing on its own. Keeping one of them and deleting the plain
    // copy frees 2 MB, not the 4 MB that (copies − 1) × size says.
    await expect(group.locator(".duplicate-copies-badge")).toHaveText("3 copies");
    await expect(group.locator(".duplicate-shared-badge")).toHaveText("APFS clones");
    await expect(group.locator(".duplicate-wasted")).toHaveText("2.0 MB wasted");

    const rows = group.locator(".duplicate-file-row");
    await expect(rows).toHaveCount(3);
    for (const path of [paths.original, paths.second]) {
      await expect(rows.filter({ hasText: path }).locator(".duplicate-sharing-badge"))
        .toHaveText("APFS clone · frees nothing");
    }
    await expect(rows.filter({ hasText: paths.copy }).locator(".duplicate-sharing-badge")).toHaveCount(0);
  });

  test("Overview reports cloned space the scan total counts twice", async ({ launch }, testInfo) => {
    const root = testInfo.outputPath("tree");
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });
    writeFileSync(join(root, "a", "data.bin"), randomBytes(DATA_BYTES));
    writeFileSync(join(root, "b", "other.bin"), randomBytes(OTHER_BYTES));
    cloneFile(join(root, "a", "data.bin"), join(root, "b", "data-clone.bin"));

    const handle = await launch();
    const snapshot = await scanFolderFromPicker(handle, root);
    // Both sides of the clone are flagged, and one of them is the second
    // count of the same blocks.
    expect(snapshot.storageAccounting).toMatchObject({
      cloneFiles: 2,
      cloneBytes: 2 * DATA_BYTES,
      clonePrivateBytes: 0,
      cloneDuplicateBytes: DATA_BYTES,
    });

    const card = handle.page.getByRole("region", { name: "Space macOS is holding back" });
    await expect(card).toBeVisible();
    await expect(card.locator(".storage-card-col").nth(1)).toContainText("4.0 MB in 2 cloned files");
    await expect(card).toContainText("The 4.3 MB total counts 2.0 MB of it more than once");
  });

  test("Dev Artifacts marks node_modules trees cloned from each other", async ({ launch }, testInfo) => {
    // What a bun or pnpm install on APFS does: every project's copy of a
    // package is a clone of the same blocks.
    const root = testInfo.outputPath("tree");
    const first = join(root, "app-one", "node_modules");
    const second = join(root, "app-two", "node_modules");
    mkdirSync(join(first, "pkg"), { recursive: true });
    mkdirSync(join(second, "pkg"), { recursive: true });
    writeFileSync(join(first, "pkg", "index.js"), randomBytes(DATA_BYTES));
    cloneFile(join(first, "pkg", "index.js"), join(second, "pkg", "index.js"));

    const handle = await launch();
    await scanFolderFromPicker(handle, root);
    const { page } = handle;
    await openTab(page, "Dev Artifacts");

    for (const tree of [first, second]) {
      const row = page.locator(".dev-row").filter({ has: page.locator(`.dev-row-name[title="${tree}"]`) });
      await expect(row).toHaveCount(1, { timeout: 30_000 });
      await expect(row.locator(".dev-share-badge")).toHaveText("Shared with 1 other tree");
      await expect(row.locator(".dev-row-frees")).toHaveText("frees ≈ 0 B");
    }
  });
});
