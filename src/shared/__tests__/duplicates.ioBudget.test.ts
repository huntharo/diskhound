import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectIoBudget, measureFsIo, settleFsIo } from "../../test/ioBudget";
import type { DuplicateAnalysis } from "../contracts";
import { __resetHashCacheForTests } from "../duplicateHashCache";
import { runDuplicateScan } from "../duplicates";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));

let dataDir: string;
let treeDir: string;

beforeEach(async () => {
  const base = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-dup-io-"));
  dataDir = Path.join(base, "userData");
  treeDir = Path.join(base, "tree");
  await FSP.mkdir(dataDir);
  // Three pairs of duplicates and two files with a unique size, in two folders.
  for (const [folder, count] of [["a", 3], ["b", 3]] as const) {
    await FSP.mkdir(Path.join(treeDir, folder), { recursive: true });
    for (let i = 0; i < count; i++) {
      await FSP.writeFile(Path.join(treeDir, folder, `copy-${i}.bin`), Buffer.alloc(4_096 * (i + 1), i + 1));
    }
  }
  await FSP.writeFile(Path.join(treeDir, "a", "unique.bin"), Buffer.alloc(9_000, 7));
  await FSP.writeFile(Path.join(treeDir, "b", "unique.bin"), Buffer.alloc(11_000, 8));
  __resetHashCacheForTests();
});

afterEach(async () => {
  await FSP.rm(Path.dirname(dataDir), { recursive: true, force: true });
});

function scan(): Promise<DuplicateAnalysis> {
  return new Promise((resolve, reject) => {
    runDuplicateScan(
      treeDir,
      { onProgress: () => undefined, onResult: resolve, onError: reject },
      { cacheDir: dataDir, minSizeBytes: 1, disableNoiseFilter: true },
    );
  });
}

const cacheFile = () => Path.join(dataDir, "duplicate-hash-cache-v2.ndjson.gz");

describe("duplicate hash cache", () => {
  it("writes the cache once after the first scan", async () => {
    const { result, io } = await measureFsIo(scan);

    expect(result.groups).toHaveLength(3);
    expectIoBudget({
      scenario: "duplicates-first-scan",
      note: "first duplicate scan of 8 files (3 duplicate pairs): walk, hash, then one gzip stream to a temp file and a rename",
      io,
    });
    expect(FS.existsSync(cacheFile())).toBe(true);
  });

  it("does not rewrite the cache when a second scan finds the tree unchanged", async () => {
    await scan();
    await settleFsIo();
    const before = FS.statSync(cacheFile()).mtimeMs;

    const { result, io } = await measureFsIo(scan);

    expect(result.groups).toHaveLength(3);
    expectIoBudget({
      scenario: "duplicates-rescan-unchanged",
      note: "a second scan in the same session on an unchanged tree: every hash is a cache hit, 0 writes",
      io,
    });
    expect(FS.statSync(cacheFile()).mtimeMs).toBe(before);
  });

  it("does not rewrite the cache when the first scan after a restart finds the tree unchanged", async () => {
    await scan();
    await settleFsIo();
    __resetHashCacheForTests();

    const { result, io } = await measureFsIo(scan);

    expect(result.groups).toHaveLength(3);
    expectIoBudget({
      scenario: "duplicates-rescan-after-restart",
      note: "the first scan after a restart on an unchanged tree: reads the cache back, every hash hits, 0 writes",
      io,
    });
  });
});
