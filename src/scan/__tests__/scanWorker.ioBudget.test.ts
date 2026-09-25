import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScanSnapshot, ScanStartInput } from "../../shared/contracts";
import { expectIoBudget, measureFsIo, type FsIo } from "../../test/ioBudget";
import { runScan } from "../scanWorker";

/** Set to make every multi-link file's inode look past 2^53. */
const inodes = vi.hoisted(() => ({ huge: false }));

vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) => {
  const counted = (await import("../../test/ioBudget")).instrumentFsPromises(
    await importOriginal<typeof import("node:fs/promises")>(),
  );
  // Test filesystems hand out small inode numbers. This moves them past
  // 2^53 for the plain-number stat, the case where scanWorker's linkStat
  // takes a second, bigint stat. Both calls still go through the counter.
  const stat = (async (path: FS.PathLike, options?: FS.StatOptions) => {
    const result = await counted.stat(path, options);
    if (inodes.huge && !options?.bigint && result.nlink > 1) {
      (result as FS.Stats).ino += 2 ** 53;
    }
    return result;
  }) as typeof counted.stat;
  const out = { ...counted, stat };
  return { ...out, default: out };
});
// The prune plan reads mountinfo on Linux, and the mount table and
// firmlinks on macOS, once per scan. Stubbed so both record the same
// budget; it is not a per-entry read.
vi.mock("../../shared/scanPrune", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../shared/scanPrune")>();
  return { ...original, loadScanPrunePlan: async () => original.emptyPrunePlan() };
});

interface IndexLine {
  p: string;
  t?: "d";
  h?: 1;
}

let base: string;
let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // realpath: macOS tmpdir is a /var → /private/var symlink.
  base = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-scan-io-")));
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  inodes.huge = false;
});

afterEach(() => {
  errorLog.mockRestore();
  FS.rmSync(base, { recursive: true, force: true });
});

const at = (rel: string) => Path.join(base, rel);

function write(rel: string, bytes: number): string {
  const path = at(rel);
  FS.mkdirSync(Path.dirname(path), { recursive: true });
  FS.writeFileSync(path, Buffer.alloc(bytes, 7));
  return path;
}

function link(target: string, rel: string): void {
  FS.mkdirSync(Path.dirname(at(rel)), { recursive: true });
  FS.linkSync(target, at(rel));
}

/** Pin every directory's mtime so Phase-1 sees only the changes a test makes. */
function settleDirMtimes(dir: string): void {
  for (const entry of FS.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) settleDirMtimes(Path.join(dir, entry.name));
  }
  const past = new Date("2024-01-01T00:00:00Z");
  FS.utimesSync(dir, past, past);
}

/**
 * The native walker's fixture: directories root, b, b/d and g (empty);
 * files a.txt, b/c.txt, b/d/e.txt and, with `hardlink`, b/d/f.txt as a
 * second link to a.txt; two symlinks the walker must neither follow nor
 * stat.
 */
function fixture({ hardlink }: { hardlink: boolean }): { dirs: number; files: number } {
  const a = write("root/a.txt", 1024);
  write("root/b/c.txt", 2048);
  write("root/b/d/e.txt", 4096);
  if (hardlink) link(a, "root/b/d/f.txt");
  FS.mkdirSync(at("root/g"));
  FS.symlinkSync(at("root/b"), at("root/link-dir"));
  FS.symlinkSync(a, at("root/link-file"));
  return { dirs: 4, files: hardlink ? 4 : 3 };
}

function readIndex(path: string): IndexLine[] {
  return gunzipSync(FS.readFileSync(path))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as IndexLine);
}

async function measureScan(name: string, extra: Partial<ScanStartInput> = {}) {
  const indexOutput = at(`out/${name}.ndjson.gz`);
  let snapshot: ScanSnapshot | null = null;
  const { io } = await measureFsIo(() =>
    runScan({ rootPath: at("root"), options: {}, indexOutput, ...extra }, (message) => {
      if (message.type === "error") throw new Error(message.message);
      if (message.type === "done") snapshot = message.snapshot;
    }));
  return { io, snapshot: snapshot! as ScanSnapshot, index: readIndex(indexOutput), indexOutput };
}

/**
 * Each path is in the index once, and no inode is listed twice unless the
 * later name is flagged as an extra hardlink. A second walk of a subtree,
 * through a bind mount or a fall-through, fails one of these.
 */
function expectListedOnce(index: IndexLine[], expected: { dirs: number; files: number }): void {
  const paths = index.map((line) => line.p);
  expect(new Set(paths).size, "a path is in the index twice").toBe(paths.length);
  expect(index.filter((line) => line.t === "d")).toHaveLength(expected.dirs);
  expect(index.filter((line) => line.t !== "d")).toHaveLength(expected.files);

  const owned = new Set<string>();
  for (const line of index.filter((entry) => entry.h !== 1)) {
    const stat = FS.lstatSync(line.p, { bigint: true });
    const id = `${stat.dev}:${stat.ino}`;
    expect(owned.has(id), `${line.p} is an inode the index already lists`).toBe(false);
    owned.add(id);
  }
  for (const line of index.filter((entry) => entry.h === 1)) {
    const stat = FS.lstatSync(line.p, { bigint: true });
    expect(owned.has(`${stat.dev}:${stat.ino}`), `${line.p} is h:1 but its owner is not listed`).toBe(true);
  }
}

/** Only these move with the tree; the rest are the scan's fixed costs. */
function walkCost(io: FsIo) {
  return { readdir: io.readdir, stat: io.stat };
}

describe.skipIf(process.platform === "win32")("scanWorker visit-once budgets", () => {
  it("reads each directory once and stats each entry once", async () => {
    const tree = fixture({ hardlink: true });

    const { io, snapshot, index } = await measureScan("walk");

    expect(snapshot.directoriesVisited).toBe(tree.dirs);
    expect(snapshot.filesVisited).toBe(tree.files);
    expect(walkCost(io)).toEqual({ readdir: tree.dirs, stat: tree.dirs + tree.files });
    expectListedOnce(index, tree);
    expectIoBudget({
      scenario: "scan-worker-walk",
      note: "JS fallback, 4 dirs and 4 files (one a second hardlink) and 2 symlinks: 1 stat + 1 readdir per dir, 1 stat per file, nothing for symlinks; plus the index's mkdir and write stream",
      io,
    });
  });

  it("stats an unchanged subtree's root once and reads nothing under it", async () => {
    fixture({ hardlink: false });
    settleDirMtimes(at("root"));
    const baseline = await measureScan("baseline");
    write("root/n/new.txt", 512);

    const { io, snapshot, index } = await measureScan("rescan", { baselineIndex: baseline.indexOutput });

    // root and n are walked; b (with b/d) and g are inherited.
    expect(snapshot.filesVisited).toBe(4);
    expect(walkCost(io)).toEqual({ readdir: 2, stat: 4 + 2 });
    expectListedOnce(index, { dirs: 5, files: 4 });
    expectIoBudget({
      scenario: "scan-worker-rescan-inherits",
      note: "JS fallback rescan after adding n/new.txt: root and n walked (stat + readdir each, 1 stat per file), b and g inherited for 1 stat each; 1 existsSync and 1 read stream for the baseline",
      io,
    });
  });

  it("walks everything after reading a baseline that has extra links", async () => {
    const tree = fixture({ hardlink: true });
    settleDirMtimes(at("root"));
    const baseline = await measureScan("baseline");
    expect(baseline.index.some((line) => line.h === 1)).toBe(true);

    const { io, index } = await measureScan("rescan", { baselineIndex: baseline.indexOutput });

    expect(walkCost(io)).toEqual({ readdir: tree.dirs, stat: tree.dirs + tree.files });
    expect(io.createReadStream).toBe(1);
    expectListedOnce(index, tree);
    expectIoBudget({
      scenario: "scan-worker-rescan-baseline-has-extra-links",
      note: "Hardlink accounting (#18), deliberate: a baseline with any h:1 line turns Phase-1 off, so nothing changed and the whole tree is walked (the plain walk's cost) after the baseline is read in full (1 read stream) and dropped",
      io,
    });
  });

  it("stats the inherited files once when a new hardlink stops inheritance", async () => {
    const big = write("root/a-store/big.bin", 32 * 1024);
    write("root/keep.txt", 4 * 1024);
    settleDirMtimes(at("root"));
    const baseline = await measureScan("baseline");
    link(big, "root/b-proj/big.bin");

    const { io, index } = await measureScan("rescan", { baselineIndex: baseline.indexOutput });

    // root and b-proj walked, a-store inherited: 3 dir stats, 2 walked
    // files, then 1 for the inherited big.bin once b-proj's link turns up.
    expect(walkCost(io)).toEqual({ readdir: 2, stat: 3 + 2 + 1 });
    expectListedOnce(index, { dirs: 3, files: 3 });
    expectIoBudget({
      scenario: "scan-worker-rescan-stops-inheriting",
      note: "Hardlink accounting (#18), deliberate: the first walked file with nlink > 1 turns Phase-1 off and stats every file inherited so far once (+1 here), so an inherited name keeps its bytes",
      io,
    });
  });

  it("takes a second stat per linked file only when its inode is past 2^53", async () => {
    const tree = fixture({ hardlink: true });
    inodes.huge = true;

    const { io, index } = await measureScan("walk");

    // a.txt and b/d/f.txt are the two names with nlink > 1.
    expect(walkCost(io)).toEqual({ readdir: tree.dirs, stat: tree.dirs + tree.files + 2 });
    expectListedOnce(index, tree);
    expectIoBudget({
      scenario: "scan-worker-walk-huge-inodes",
      note: "Hardlink accounting (#18), deliberate: with inode numbers past 2^53, each file with nlink > 1 takes a second, bigint stat (+2 here: a.txt and its second link); files with one link never do",
      io,
    });
  });
});

// Keeps both fs factories live in this file (see src/test/ioBudget.ts).
void FSP;
