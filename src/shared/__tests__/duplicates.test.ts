import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DuplicateAnalysis } from "../contracts";
import { runDuplicateScan, type DuplicateScanOptions } from "../duplicates";

// Above PREFIX_BYTES, so groups go through the full-hash pass too.
const SIZE = 96 * 1024;

let base: string;

beforeEach(() => {
  base = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-dup-links-")));
});

afterEach(() => {
  FS.rmSync(base, { recursive: true, force: true });
});

const at = (rel: string) => Path.join(base, rel);

function write(rel: string): string {
  const path = at(rel);
  FS.mkdirSync(Path.dirname(path), { recursive: true });
  FS.writeFileSync(path, Buffer.alloc(SIZE, 7));
  return path;
}

function link(target: string, rel: string): string {
  const path = at(rel);
  FS.mkdirSync(Path.dirname(path), { recursive: true });
  FS.linkSync(target, path);
  return path;
}

/** Index lines in the scanner's shape; `extra` holds h / i / v / k. */
function writeIndex(records: Array<{ p: string } & Record<string, unknown>>): string {
  const lines = records.map(({ p, ...extra }) => JSON.stringify({ p, s: SIZE, m: 0, ...extra }));
  const indexPath = at("index.ndjson.gz");
  FS.writeFileSync(indexPath, gzipSync(lines.join("\n") + "\n"));
  return indexPath;
}

function findDuplicates(rel: string, options: DuplicateScanOptions = {}): Promise<DuplicateAnalysis> {
  return new Promise((resolve, reject) => {
    runDuplicateScan(
      at(rel),
      { onProgress: () => {}, onResult: resolve, onError: reject },
      // tmpdir paths match the noise filter.
      { minSizeBytes: 1024, disableNoiseFilter: true, ...options },
    );
  });
}

const groupPaths = (result: DuplicateAnalysis) =>
  result.groups.map((group) => group.files.map((file) => Path.relative(base, file.path)).sort());

describe.skipIf(process.platform === "win32")("duplicates and hardlinks (walk, no index)", () => {
  it("doesn't report a file and its hardlink as duplicates", async () => {
    link(write("root/a.bin"), "root/b.bin");

    const result = await findDuplicates("root");

    expect(result.groups).toEqual([]);
    expect(result.totalWastedBytes).toBe(0);
  });

  it("lists a hardlinked file once in a group with a real copy", async () => {
    link(write("root/original.bin"), "root/link.bin");
    write("root/copy.bin");

    const result = await findDuplicates("root");

    expect(result.groups).toHaveLength(1);
    const [paths] = groupPaths(result);
    expect(paths).toHaveLength(2);
    expect(paths).toContain(Path.join("root", "copy.bin"));
    // Keep the linked file, delete the copy: that frees one copy.
    expect(result.totalWastedBytes).toBe(SIZE);
    expect(result.groups[0]!.reclaimableBytes).toBe(SIZE);
    expect(result.totalDuplicateFiles).toBe(2);
    const linked = result.groups[0]!.files.find((file) => file.sharing === "hardlink");
    expect(linked?.reclaimableBytes).toBe(0);
  });
});

describe.skipIf(process.platform === "win32")("duplicates read sharing from the index", () => {
  it("folds names by link id even when every name in the folder is h:1", async () => {
    // pnpm-style: the store owns the inode in a scan of the whole tree, so
    // both links inside proj/ are h:1. The vendored copy is a separate
    // file with the same bytes, so it's still a duplicate.
    const store = write(".pnpm-store/pkg.js");
    link(store, "proj/app/pkg.js");
    link(store, "proj/web/pkg.js");
    write("proj/vendor/pkg.js");
    const id = "16777232:4815";
    const indexPath = writeIndex([
      { p: store, i: id },
      { p: at("proj/app/pkg.js"), h: 1, i: id },
      { p: at("proj/vendor/pkg.js") },
      { p: at("proj/web/pkg.js"), h: 1, i: id },
    ]);

    const result = await findDuplicates("proj", { indexPath });

    expect(groupPaths(result)).toEqual([[
      Path.join("proj", "app", "pkg.js"),
      Path.join("proj", "vendor", "pkg.js"),
    ]]);
    expect(result.totalWastedBytes).toBe(SIZE);
  });

  it("trusts the index: names without an id are separate files until the next scan", async () => {
    // An index from before `i` existed. Duplicates doesn't stat to check,
    // so the two names still show as copies, as they did before.
    const a = write("root/a.bin");
    const b = link(a, "root/b.bin");
    const indexPath = writeIndex([{ p: a }, { p: b }]);

    const result = await findDuplicates("root", { indexPath });

    expect(groupPaths(result)).toEqual([[Path.join("root", "a.bin"), Path.join("root", "b.bin")]]);
    expect(result.totalWastedBytes).toBe(SIZE);
  });

  it("counts APFS clones at their private bytes", async () => {
    // Two full clones of each other (v:0) plus a real copy.
    const cloneA = write("root/a.bin");
    const cloneB = write("root/b.bin");
    const copy = write("root/c.bin");
    const indexPath = writeIndex([
      { p: cloneA, v: 0, k: 1 },
      { p: cloneB, v: 4096, k: 1 },
      { p: copy },
    ]);

    const result = await findDuplicates("root", { indexPath });

    expect(result.groups).toHaveLength(1);
    const files = result.groups[0]!.files;
    expect(files.find((file) => file.path === cloneA)).toMatchObject({ sharing: "clone", reclaimableBytes: 0 });
    expect(files.find((file) => file.path === cloneB)).toMatchObject({ sharing: "clone", reclaimableBytes: 4096 });
    expect(files.find((file) => file.path === copy)?.sharing).toBeUndefined();
    // Keep a.bin (frees 0), delete b.bin (4 KB) and the copy (SIZE).
    expect(result.totalWastedBytes).toBe(4096 + SIZE);
  });

  it("keeps a group of full clones but reclaims nothing from it", async () => {
    const cloneA = write("root/a.bin");
    const cloneB = write("root/b.bin");
    const indexPath = writeIndex([
      { p: cloneA, v: 0, k: 1 },
      { p: cloneB, v: 0, k: 1 },
    ]);

    const result = await findDuplicates("root", { indexPath });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.reclaimableBytes).toBe(0);
    expect(result.totalWastedBytes).toBe(0);
  });

  it("spends a reduced hash depth on real copies, not on clones that free nothing", async () => {
    // Two buckets. The clone pair is bigger, so size × (count − 1) ranked
    // it first; at 50% depth only one bucket is hashed.
    const big = 2 * SIZE;
    const cloneA = at("root/clone-a.bin");
    const cloneB = at("root/clone-b.bin");
    FS.mkdirSync(Path.dirname(cloneA), { recursive: true });
    FS.writeFileSync(cloneA, Buffer.alloc(big, 3));
    FS.writeFileSync(cloneB, Buffer.alloc(big, 3));
    const copyA = write("root/copy-a.bin");
    const copyB = write("root/copy-b.bin");
    const indexPath = writeIndex([
      { p: cloneA, s: big, v: 0, k: 1 },
      { p: cloneB, s: big, v: 0, k: 1 },
      { p: copyA },
      { p: copyB },
    ]);

    const result = await findDuplicates("root", { indexPath, hashDepthPercent: 50 });

    expect(groupPaths(result)).toEqual([[Path.join("root", "copy-a.bin"), Path.join("root", "copy-b.bin")]]);
    expect(result.totalWastedBytes).toBe(SIZE);
  });

  it("treats k without v as fully private (the writer omits v when nothing is shared)", async () => {
    const a = write("root/a.bin");
    const b = write("root/b.bin");
    const indexPath = writeIndex([{ p: a, k: 1 }, { p: b }]);

    const result = await findDuplicates("root", { indexPath });

    expect(result.groups[0]!.files.every((file) => file.sharing === undefined)).toBe(true);
    expect(result.totalWastedBytes).toBe(SIZE);
  });
});
