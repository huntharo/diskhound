import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { permanentlyDeleteOnDisk } from "../permanentDelete";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));

let temp: string;
beforeEach(async () => { temp = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-delete-io-")); });
afterEach(async () => { await FSP.rm(temp, { recursive: true, force: true }); });

it("removes entries without rewriting file contents or persisting progress", async () => {
  const root = Path.join(temp, "target");
  await FSP.mkdir(root);
  const artifact = Buffer.alloc(16 * 1024, 42);
  for (let d = 0; d < 8; d++) {
    const dir = Path.join(root, `crate-${d}`);
    await FSP.mkdir(dir);
    for (let f = 0; f < 32; f++) await FSP.writeFile(Path.join(dir, `part-${f}.o`), artifact);
  }
  const { io } = await measureFsIo(() => permanentlyDeleteOnDisk(root, () => {}));
  expect(FS.existsSync(root)).toBe(false);
  expectIoBudget({
    scenario: "permanent-delete-tree",
    note: "User-requested 4 MiB build tree: 256 file unlinks, 9 streamed directory opens, no content writes or persisted progress. rmdir metadata operations are outside this harness's counters. No automatic deletion: 0 writes/day and 0 MB/day at default and 1-minute monitoring. One manual delete performs these 256 metadata unlinks; OS metadata bytes are not measured.",
    io,
  });
});
import * as FS from "node:fs";
