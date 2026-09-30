import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { callTool, connectAgent, resultText, signIn, turnOnAgents } from "./fixtures/agent";
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
const COPY_SIZE = process.platform === "darwin" ? "2.1 MB" : "2.0 MB";

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
  const toggle = group.getByRole("button", { name: "Copies of", exact: false });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expectChevronLeadsHeader(group);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(group.locator(".duplicate-file-row").first()).toBeVisible();
  await expectChevronLeadsHeader(group);
  return group;
}

/** The header is one line and the chevron leads it, before the
 *  checkbox. A fixed-column grid once pushed the chevron onto a second
 *  line whenever the shared-storage badge showed, which every group
 *  here has. */
async function expectChevronLeadsHeader(group: Locator) {
  const header = group.locator(".duplicate-group-header");
  await expect(header.locator(".duplicate-shared-badge")).toBeVisible();
  const box = async (selector: string) => {
    const b = await header.locator(selector).boundingBox();
    expect(b, selector).not.toBeNull();
    return { left: b!.x, right: b!.x + b!.width, middle: b!.y + b!.height / 2 };
  };
  const toggle = await box(".disclosure-toggle");
  const checkbox = await box(".duplicate-group-checkbox");
  expect(toggle.right).toBeLessThanOrEqual(checkbox.left);
  for (const selector of [".duplicate-group-checkbox", ".duplicate-shared-badge", ".duplicate-group-actions"]) {
    expect(Math.abs((await box(selector)).middle - toggle.middle), selector).toBeLessThan(2);
  }
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
  await expect(group.locator(".duplicate-wasted")).toHaveText(`${COPY_SIZE} wasted`);
  await expect(page.locator(".duplicates-subtitle")).toHaveText(`${COPY_SIZE} reclaimable`);

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
    await expect(group.locator(".duplicate-wasted")).toHaveText(`${COPY_SIZE} wasted`);

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

    const primary = handle.page.locator(".metrics-strip .metric").filter({
      has: handle.page.locator(".metric-label", { hasText: "scanned file bytes" }),
    });
    await expect(primary).toContainText("4.5 MB");
    await expect(primary).toHaveAttribute("title", /Shared clone blocks count for each file/);
    const adjusted = handle.page.locator(".metrics-strip .metric").filter({
      has: handle.page.locator(".metric-label", { hasText: "after known clone repeats" }),
    });
    await expect(adjusted).toContainText("≈ 2.4 MB");
    await expect(adjusted).toHaveAttribute("title", /not physical disk usage/);

    const card = handle.page.getByRole("region", { name: "Space macOS is holding back" });
    await expect(card).toBeVisible();
    await expect(card.locator(".storage-card-col").nth(1)).toContainText("4.2 MB in 2 cloned files");
    await expect(card).toContainText("The 4.5 MB scanned file bytes count 2.1 MB of known full clones more than once");
  });

  test("Dev Artifacts marks node_modules trees cloned from each other", async ({ launch }, testInfo) => {
    // What a bun or pnpm install on APFS does: every project's copy of a
    // package is a clone of the same blocks. Three projects hold one
    // 32 MiB file between them, enough for the summary to call it out.
    const root = testInfo.outputPath("tree");
    const trees = ["app-one", "app-two", "app-three"].map((app) => join(root, app, "node_modules"));
    for (const tree of trees) mkdirSync(join(tree, "pkg"), { recursive: true });
    writeFileSync(join(trees[0]!, "pkg", "index.js"), randomBytes(32 * 1024 * KiB));
    for (const tree of trees.slice(1)) cloneFile(join(trees[0]!, "pkg", "index.js"), join(tree, "pkg", "index.js"));

    const handle = await launch();
    await scanFolderFromPicker(handle, root);
    const { page } = handle;
    const tile = page.locator(".metric-dev-tile");
    await expect(tile).toContainText("0 B – 33.6 MB");
    await expect(tile).toContainText("dev artifacts reclaimable");
    await expect(tile).toContainText("101 MB listed");
    await expect(tile).toHaveAttribute("title", /Local snapshots can delay/);
    const tileValue = await tile.locator(".metric-value").textContent();
    await tile.click();
    await expect(page.locator(".tab-bar").getByRole("button", { name: "Dev Artifacts" })).toHaveClass(/active/);

    for (const tree of trees) {
      const row = page.locator(".dev-row").filter({ has: page.locator(`.dev-row-name[title="${tree}"]`) });
      await expect(row).toHaveCount(1, { timeout: 30_000 });
      await expect(row.locator(".dev-share-badge")).toHaveText("Shared with 2 other trees");
      await expect(row.locator(".dev-row-frees")).toHaveText("frees ≈ 0 B");
    }

    // 96 MB listed is 32 MB of blocks. No one tree frees any of it, and
    // deleting all three frees it once.
    const summary = page.locator(".dev-summary-net");
    await expect(summary.locator(".changes-delta-big")).toHaveText(tileValue ?? "");
    await expect(summary.locator(".changes-delta-label")).toHaveText("reclaimable on this scan · 101 MB listed");
    // The kind rail tells the same story as the header.
    const rail = page.locator(".dev-kind-rail");
    await expect(rail.locator(".dev-kind-cell-all .dev-kind-cell-size")).toHaveText("0 B – 33.6 MB");
    await expect(rail.locator(".dev-kind-cell:not(.dev-kind-cell-all) .dev-kind-cell-size")).toHaveText(["0 B – 33.6 MB"]);
    // So do the group headers and the selection tally.
    await page.getByRole("radio", { name: "By kind" }).click();
    await expect(page.locator(".dev-group-size")).toHaveText(["frees 0 B – 33.6 MB"]);
    await page.getByRole("button", { name: "Select visible" }).click();
    await expect(page.locator(".dev-select-bar-tally")).toHaveText("3 · frees 0 B – 33.6 MB");
    const note = page.locator(".dev-sharing-note");
    await expect(note).toContainText(
      "101 MB of these trees is APFS clones sharing blocks with files elsewhere. "
      + "Each copy counts at full size, but together they hold about 33.6 MB of blocks. "
      + "Deleting a tree frees only its own blocks: about 0 B if you deleted everything listed, "
      + "up to 33.6 MB if no copy is left elsewhere.",
    );
  });
});

test("an agent measures what removing a set frees, counting shared blocks once", async ({ launch }, testInfo) => {
  test.skip(process.platform === "win32", "Windows has no measure tool; its scans count each file once");
  // Two worktrees share a file with each other, and the second one also
  // shares a file with a store outside the set. On macOS the shared
  // files are APFS clones; elsewhere they are hardlinks.
  const share = process.platform === "darwin" ? cloneFile : linkSync;
  const root = testInfo.outputPath("tree");
  const one = join(root, "wt", "one");
  const two = join(root, "wt", "two");
  const store = join(root, "store");
  for (const dir of [one, two, store]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(one, "shared.bin"), randomBytes(DATA_BYTES));
  share(join(one, "shared.bin"), join(two, "shared.bin"));
  writeFileSync(join(one, "own.bin"), randomBytes(OTHER_BYTES));
  writeFileSync(join(store, "held.bin"), randomBytes(OTHER_BYTES));
  share(join(store, "held.bin"), join(two, "held.bin"));

  // No scan: the tool reads the disk as it is now.
  const handle = await launch();
  await turnOnAgents(handle.page);
  const agent = await connectAgent(handle, await signIn(handle, { sessionName: "Measure" }));
  const gone = join(root, "gone");
  const nested = join(two, "held.bin");
  const result = await callTool(agent, "diskhound_measure_removal", { paths: [one, two, nested, gone] });
  expect(result.isError, resultText(result)).not.toBe(true);
  // A hardlinked file takes its space once; each clone counts in full.
  const sizeBytes = process.platform === "darwin" ? 2 * DATA_BYTES + 2 * OTHER_BYTES : DATA_BYTES + 2 * OTHER_BYTES;
  expect(result.structuredContent).toMatchObject({
    total: {
      files: 4,
      sizeBytes,
      freesBytes: DATA_BYTES + OTHER_BYTES,
      freesOneAtATimeBytes: OTHER_BYTES,
      heldElsewhereBytes: OTHER_BYTES,
      uncertainBytes: 0,
    },
    paths: [
      { path: one, kind: "folder", files: 2, freesAloneBytes: OTHER_BYTES, sharedBytes: DATA_BYTES },
      { path: two, kind: "folder", files: 2, freesAloneBytes: 0, sharedBytes: DATA_BYTES + OTHER_BYTES },
    ],
    missing: [gone],
    nested: [{ path: nested, within: two }],
  });
  expect(resultText(result)).toContain("Removing these 2 items together frees");
  expect(resultText(result)).toContain(`Not found: ${gone}.`);

  // The same set, asked again in another order, comes from the walk
  // that already finished.
  const again = await callTool(agent, "diskhound_measure_removal", { paths: [gone, nested, two, one] });
  expect(again.structuredContent?.measuredAt).toBe(result.structuredContent?.measuredAt);
  await agent.close();
});
