import * as Path from "node:path";
import { describe, expect, it } from "vitest";

import type { DirectoryHotspot, ScanFileRecord } from "../../shared/contracts";
import {
  biggestFirst,
  createBaseline,
  HottestDirectories,
  inheritSubtree,
  PathIndex,
  rankDirectories,
  rollupDirectorySize,
  subtreeDirs,
  TopN,
  type BaselineFileRecord,
} from "../scanWorker";

/**
 * Scaling tests for the JS scan worker's per-file bookkeeping. They count
 * what the code reads (record fields through getters, array slots and Map
 * entries through proxies), not time, at N and 8N. Where a cost also grows
 * with a list limit L or a folder count K, that grows 8× too: with it
 * fixed, an O(N·L) loop looks linear from N to 8N.
 *
 * From N to 8N, linear work grows 8×. The bound allows 2× that for log
 * factors; the loops these replace grew 60-64×.
 */
const MAX_GROWTH = 16;

type Counter = { reads: number };

function expectScales(label: string, small: number, large: number, cap: number): void {
  if (process.env.SCAN_SCALING_REPORT === "1") {
    process.stdout.write(`${label}: ${small} -> ${large} reads (${(large / small).toFixed(1)}x), cap ${cap}\n`);
  }
  expect(large / small, label).toBeLessThanOrEqual(MAX_GROWTH);
  expect(large, label).toBeLessThanOrEqual(cap);
}

const root = Path.resolve("/scan");
/** Ten files per leaf folder, ten leaves per group: root/gG/dD/fI.bin. */
const leaf = (d: number) => Path.join(root, `g${Math.floor(d / 10)}`, `d${d}`);
const group = (g: number) => Path.join(root, `g${g}`);

/** A file whose `path` and `size` reads are counted. */
function countedFile(i: number, size: number, counter: Counter): ScanFileRecord {
  const parentPath = leaf(Math.floor(i / 10));
  const path = Path.join(parentPath, `f${i}.bin`);
  return {
    get path() {
      counter.reads += 1;
      return path;
    },
    get size() {
      counter.reads += 1;
      return size;
    },
    name: `f${i}.bin`,
    parentPath,
    extension: ".bin",
    modifiedAt: 0,
  };
}

/** A Map whose lookups, writes and iterated entries are counted. */
class CountedMap<K, V> extends Map<K, V> {
  constructor(protected readonly counter: Counter, entries: Iterable<[K, V]> = []) {
    super();
    for (const [key, value] of entries) super.set(key, value);
  }

  override get(key: K): V | undefined {
    this.counter.reads += 1;
    return super.get(key);
  }

  override set(key: K, value: V): this {
    this.counter.reads += 1;
    return super.set(key, value);
  }

  override *entries(): MapIterator<[K, V]> {
    for (const entry of super.entries()) {
      this.counter.reads += 1;
      yield entry;
    }
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  override *keys(): MapIterator<K> {
    for (const [key] of this.entries()) yield key;
  }

  override *values(): MapIterator<V> {
    for (const [, value] of this.entries()) yield value;
  }

  override forEach(callback: (value: V, key: K, map: Map<K, V>) => void): void {
    for (const [key, value] of this.entries()) callback(value, key, this);
  }
}

/** Folder totals that also count reads of each folder's `size`. */
class CountedTotals extends CountedMap<string, DirectoryHotspot> {
  override set(key: string, value: DirectoryHotspot): this {
    let size = value.size;
    const counter = this.counter;
    Object.defineProperty(value, "size", {
      get() {
        counter.reads += 1;
        return size;
      },
      set(next: number) {
        size = next;
      },
      enumerable: true,
      configurable: true,
    });
    return super.set(key, value);
  }
}

function countedSlots<T extends object>(target: T[], counter: Counter): T[] {
  return new Proxy(target, {
    get(array, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) counter.reads += 1;
      return Reflect.get(array, property, receiver);
    },
  });
}

describe("scanWorker scaling", () => {
  function offerAll(order: number[], limit: number) {
    const counter = { reads: 0 };
    const top = new TopN<ScanFileRecord>(limit, biggestFirst);
    for (const i of order) top.offer(countedFile(i, i + 1, counter));
    const sizes = top.sorted().map((file) => file.size);
    return { reads: counter.reads, sizes };
  }

  it("keeps the largest files in O(N log L), whatever order they arrive in", () => {
    // Before, ascending: 208,674 reads -> 12,526,778 (60.0x). Each file
    // searched the list for its own path, then re-sorted it.
    for (const reverse of [false, true]) {
      const order = (n: number) => {
        const indexes = Array.from({ length: n }, (_, i) => i);
        return reverse ? indexes.reverse() : indexes;
      };
      const small = offerAll(order(1_000), 50);
      const large = offerAll(order(8_000), 400);
      expectScales(reverse ? "largest files, descending" : "largest files, ascending", small.reads, large.reads, 8_000 * 40);
      expect(large.sizes).toEqual(Array.from({ length: 400 }, (_, i) => 8_000 - i));
    }
  });

  it("breaks size ties by path, so the list doesn't depend on walk order", () => {
    const file = (name: string, size: number) =>
      ({ path: Path.join(root, name), name, parentPath: root, extension: "", size, modifiedAt: 0 });
    for (const order of [["c", "b", "a"], ["a", "b", "c"], ["b", "c", "a"]]) {
      const top = new TopN<ScanFileRecord>(2, biggestFirst);
      for (const name of order) top.offer(file(name, 5));
      top.offer(file("small", 1));
      expect(top.sorted().map((f) => f.name)).toEqual(["a", "b"]);
    }
    expect(new TopN<ScanFileRecord>(0, biggestFirst).sorted()).toEqual([]);
  });

  /** Every file's folder rollup, with a running snapshot after each one. */
  function rollUp(files: number, limit: number) {
    const counter = { reads: 0 };
    const totals = new CountedTotals(counter);
    const hottest = new HottestDirectories(totals, limit);
    for (let i = 0; i < files; i += 1) {
      rollupDirectorySize(root, leaf(Math.floor(i / 10)), i + 1, totals);
      hottest.current(i + 1, false);
    }
    const final = hottest.current(files, true);
    return { reads: counter.reads, final, totals };
  }

  it("rolls folder sizes up in O(N·depth) and ranks them for snapshots in O(N log L)", () => {
    // Before: 148,905 reads -> 8,955,704 (60.1x). Every ancestor of every
    // file searched and re-sorted the 10k folder ranking.
    const small = rollUp(1_000, 50);
    const large = rollUp(8_000, 400);
    expectScales("folder rollup and ranking", small.reads, large.reads, 8_000 * 40);

    const everyFolder = [...large.totals.values()].sort(biggestFirst).slice(0, 400);
    expect(large.final.map((d) => d.path)).toEqual(everyFolder.map((d) => d.path));
    expect(large.final[0]).toMatchObject({ path: root, fileCount: 8_000 });
  });

  it("re-ranks folders for a running snapshot once per folder's worth of files", () => {
    const totals = new Map<string, DirectoryHotspot>();
    const hottest = new HottestDirectories(totals, 10);
    rollupDirectorySize(root, leaf(0), 1, totals);
    expect(hottest.current(1, false).map((d) => d.path)).toEqual([root, group(0), leaf(0)]);
    for (const [i, expected] of [[2, 3], [3, 3], [4, 6]] as const) {
      rollupDirectorySize(root, leaf(i - 1), 1, totals);
      expect(hottest.current(i, false)).toHaveLength(expected);
    }
    rollupDirectorySize(root, leaf(4), 1, totals);
    expect(hottest.current(5, false)).toHaveLength(6);
    expect(hottest.current(5, true)).toHaveLength(7);
    // Empty folders stay off the list.
    totals.set(Path.join(root, "empty"), { path: Path.join(root, "empty"), size: 0, fileCount: 0, depth: 1 });
    expect(rankDirectories(totals, 10)).toHaveLength(7);
  });

  /** `groups` folders of ten subfolders, five files each; inherit each one. */
  function inherit(groups: number) {
    const counter = { reads: 0 };
    const dirMtimes = new Map<string, number>([[root, 0]]);
    const filesByParent = new Map<string, BaselineFileRecord[]>();
    for (let g = 0; g < groups; g += 1) {
      dirMtimes.set(group(g), 0);
      for (let d = g * 10; d < g * 10 + 10; d += 1) {
        dirMtimes.set(leaf(d), 0);
        filesByParent.set(leaf(d), Array.from({ length: 5 }, (_, k) => fileIn(leaf(d), `f${k}`)));
      }
    }
    // Building the indexes reads each key once, then sorts: once per scan.
    const baseline = createBaseline(
      new CountedMap(counter, dirMtimes),
      new CountedMap(counter, filesByParent),
      0,
    );
    for (const index of [baseline.dirs, baseline.parents]) {
      const slots = index as unknown as { byPath: object[] };
      slots.byPath = countedSlots(slots.byPath, counter);
    }

    for (let g = 0; g < groups; g += 1) {
      expect(inheritSubtree(group(g), baseline)).toHaveLength(50);
      expect(subtreeDirs(group(g), baseline)).toHaveLength(10);
    }
    return counter.reads;
  }

  it("finds an inherited folder's files and subfolders in O(log K + subtree)", () => {
    // Before: 210,100 reads -> 13,440,800 (64.0x). Each inherited folder
    // walked every baseline folder and every folder with files.
    const small = inherit(100);
    const large = inherit(800);
    expectScales("inherited subtrees", small, large, 800 * 100);
  });

  it("inherits a folder of 300k files without overflowing the stack", () => {
    // Before: RangeError: Maximum call stack size exceeded, from
    // out.push(...list).
    const big = Path.join(root, "big");
    const nested = Path.join(big, "nested");
    const many = (dir: string) => Array.from({ length: 300_000 }, (_, k) => fileIn(dir, `f${k}`));
    const baseline = createBaseline(
      new Map([[big, 0], [nested, 0]]),
      new Map([[big, many(big)], [nested, many(nested)]]),
      0,
    );
    expect(inheritSubtree(big, baseline)).toHaveLength(600_000);
  });

  it("returns direct files first, then descendants in baseline order", () => {
    const a = Path.join(root, "a");
    // Path order would put "a-b" between "a" and "a/x"; baseline order wins.
    const parents = [Path.join(a, "z"), a, Path.join(root, "a-b"), Path.join(a, "x"), Path.join(a, "x", "y")];
    const baseline = createBaseline(
      new Map(parents.map((dir) => [dir, 0])),
      new Map(parents.map((dir) => [dir, [fileIn(dir, "f")]])),
      0,
    );
    const inherited = inheritSubtree(a, baseline).map((file) => Path.relative(root, file.parentPath));
    expect(inherited).toEqual(["a", Path.join("a", "z"), Path.join("a", "x"), Path.join("a", "x", "y")]);
    expect(subtreeDirs(a, baseline)).toEqual([Path.join(a, "z"), Path.join(a, "x"), Path.join(a, "x", "y")]);
    expect(new PathIndex([root, a]).under(Path.parse(root).root)).toEqual([root, a]);
  });
});

function fileIn(dir: string, name: string): BaselineFileRecord {
  return { path: Path.join(dir, name), name, parentPath: dir, extension: "(no ext)", size: 1, modifiedAt: 0 };
}
