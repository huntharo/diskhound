import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test as base } from "./fixtures/electron-app";
import { scanFolderFromPicker } from "./fixtures/steps";

const KiB = 1024;
// Bigger than every file in the scan tree, so it would top Largest
// Files if the folder's scan counted it.
const INSIDE_BYTES = 2048 * KiB;

type OtherDisk = { mountPoint: string; file: string };

const test = base.extend<{ otherDisk: OtherDisk }>({
  // A small APFS disk image mounted inside the scan tree, the way an
  // external disk or an opened .dmg can sit inside a folder the user
  // scans. It depends on scanTree, so it is detached before the tree is
  // removed.
  otherDisk: async ({ scanTree }, use, testInfo) => {
    const image = testInfo.outputPath("other-disk.dmg");
    // Canonical, because the mount table and the walker both report the
    // real path, and the Overview matches them exactly.
    const mountPoint = join(realpathSync.native(scanTree.root), "other-disk");
    execFileSync("hdiutil", ["create", "-quiet", "-size", "16m", "-fs", "APFS", "-volname", "Other Disk", image]);
    execFileSync("hdiutil", ["attach", "-quiet", "-nobrowse", "-mountpoint", mountPoint, image]);
    try {
      writeFileSync(join(mountPoint, "inside.bin"), randomBytes(INSIDE_BYTES));
      await use({ mountPoint, file: "inside.bin" });
    } finally {
      // -force: Spotlight or fseventsd can still have the volume open.
      execFileSync("hdiutil", ["detach", "-quiet", "-force", mountPoint]);
      rmSync(image, { force: true });
    }
  },
});

test.describe("other disks", () => {
  test.skip(process.platform !== "darwin", "mounts a disk image with hdiutil");

  test("leaves a disk mounted inside the folder out, and links to its own scan", async ({
    launch,
    scanTree,
    otherDisk,
  }) => {
    const handle = await launch();
    const { page } = handle;
    const snapshot = await scanFolderFromPicker(handle, realpathSync.native(scanTree.root));

    expect(snapshot.filesVisited).toBe(scanTree.files.length);
    expect(snapshot.largestFiles.map((file) => file.name)).toEqual(scanTree.files.map((file) => file.name));
    expect(snapshot.skippedMounts).toEqual([otherDisk.mountPoint]);
    expect(snapshot.volumeAccounting).toBe("own-disk");

    // The disk image has a drive pill, so the Overview links to it.
    const note = page.locator(".other-disks-note");
    await expect(note).toHaveText("Another disk is mounted here and has its own scan: other-disk →");
    await note.getByRole("button", { name: "other-disk →" }).click();

    // A scan of the mount point itself walks the disk.
    await expect
      .poll(
        async () => {
          const current = await page.evaluate(() => window.diskhound.getCurrentSnapshot());
          return current?.rootPath === otherDisk.mountPoint ? current.status : null;
        },
        { timeout: 45_000 },
      )
      .toBe("done");
    const own = await page.evaluate(() => window.diskhound.getCurrentSnapshot());
    expect(own.largestFiles[0]?.name).toBe(otherDisk.file);
    expect(own.bytesSeen).toBeGreaterThanOrEqual(INSIDE_BYTES);
    expect(own.skippedMounts).toBeUndefined();
  });
});
