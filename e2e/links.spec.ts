import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "./fixtures/electron-app";
import { scanFolderFromPicker } from "./fixtures/steps";

// Two names for the same 2 MiB of data, plus one 256 KiB file, so the
// data really takes 2.25 MiB. Sizes are 4 KiB multiples, so allocated
// equals logical on APFS, ext4 and NTFS.
const KiB = 1024;
const SHARED_BYTES = 2048 * KiB;
const OTHER_BYTES = 256 * KiB;

function writeTree(root: string, secondName: (from: string, to: string) => void): void {
  mkdirSync(join(root, "a"), { recursive: true });
  mkdirSync(join(root, "b"), { recursive: true });
  writeFileSync(join(root, "a", "original.bin"), randomBytes(SHARED_BYTES));
  writeFileSync(join(root, "b", "other.bin"), randomBytes(OTHER_BYTES));
  secondName(join(root, "a", "original.bin"), join(root, "b", "second-name.bin"));
}

// Keep the trees out of the uploaded CI artifacts.
test.afterEach(({}, testInfo) => {
  for (const name of ["links", "clones"]) {
    rmSync(testInfo.outputPath(name), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("counts a hard-linked file once", async ({ launch }, testInfo) => {
  const root = testInfo.outputPath("links");
  writeTree(root, linkSync);

  const snapshot = await scanFolderFromPicker(await launch(), root);
  expect(snapshot.bytesSeen).toBe(SHARED_BYTES + OTHER_BYTES);
});

test.describe("APFS clones", () => {
  test.skip(process.platform !== "darwin", "clonefile(2) is APFS-only");

  test("counts cloned blocks once", async ({ launch }, testInfo) => {
    // Known gap: each clone reports its full allocated size, so a file
    // and its clone count twice (4.25 MiB here). Remove test.fail once
    // the scanner accounts for shared extents; Playwright then reports
    // this test as unexpectedly passing.
    test.fail(true, "scanner counts APFS clone extents once per clone");

    const root = testInfo.outputPath("clones");
    // `cp -c` calls clonefile(2). Node's COPYFILE_FICLONE_FORCE returns
    // ENOSYS on macOS.
    writeTree(root, (from, to) => execFileSync("cp", ["-c", from, to]));

    const snapshot = await scanFolderFromPicker(await launch(), root);
    expect(snapshot.bytesSeen).toBe(SHARED_BYTES + OTHER_BYTES);
  });
});
