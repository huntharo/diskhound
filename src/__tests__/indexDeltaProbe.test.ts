import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { IndexDeltaProbe, indexNeedsRewrite } from "../shared/indexDeltaProbe";
import { normPath } from "../shared/pathUtils";

const key = normPath("/root/a");

describe("index delta preflight", () => {
  it("distinguishes unchanged updates, additions, modifications, and file deletions", () => {
    const probe = new IndexDeltaProbe({
      deletes: new Set([key]),
      updates: new Map([[normPath("/root/b"), { size: 1, mtime: 2 }]]),
    });
    expect(probe.changesRow({ p: key, t: "d" })).toBe(false);
    expect(probe.changesRow({ p: key, s: 1, m: 2 })).toBe(true);
    expect(probe.hasAdditions).toBe(true);
    expect(probe.changesRow({ p: "/root/b", s: 1, m: 2 })).toBe(false);
    expect(probe.hasAdditions).toBe(false);
    for (const row of [{ p: key, s: 2, m: 2 }, { p: key, s: 1, m: 3 }]) {
      const modified = new IndexDeltaProbe({ deletes: new Set(), updates: new Map([[key, { size: 1, mtime: 2 }]]) });
      expect(modified.changesRow(row)).toBe(true);
    }
  });

  it("propagates missing/corrupt baseline errors and closes early on effective changes", async () => {
    const dir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-delta-probe-"));
    const path = Path.join(dir, "index.gz");
    const deltas = { deletes: new Set([key]), updates: new Map() };
    try {
      await expect(indexNeedsRewrite(path, deltas)).rejects.toThrow();
      await FSP.writeFile(path, "not gzip");
      await expect(indexNeedsRewrite(path, deltas)).rejects.toThrow();
      await FSP.writeFile(path, gzipSync(JSON.stringify({ p: key, s: 1, m: 2 }) + "\n"));
      expect(await indexNeedsRewrite(path, deltas)).toBe(true);
    } finally {
      await FSP.rm(dir, { recursive: true, force: true });
    }
  });

  it("scales linearly when both the baseline and ineffective deltas grow 8x", () => {
    function run(n: number): number {
      let operations = 0;
      class CountedDeletes extends Set<string> {
        override has(value: string): boolean { operations++; return super.has(value); }
        override *[Symbol.iterator](): SetIterator<string> {
          for (const value of super[Symbol.iterator]()) { operations++; yield value; }
          return undefined;
        }
      }
      const deletes = new CountedDeletes();
      const updates = new Map<string, { size: number; mtime: number }>();
      for (let i = 0; i < n; i++) {
        deletes.add(normPath(`/root/transient-${i}`));
        updates.set(normPath(`/root/${i}`), {
          get size() { operations++; return i; },
          get mtime() { operations++; return 1; },
        });
      }
      const probe = new IndexDeltaProbe({ deletes, updates });
      for (let i = 0; i < n; i++) {
        const row = new Proxy({ p: `/root/${i}`, s: i, m: 1 }, {
          get(target, property, receiver) { operations++; return Reflect.get(target, property, receiver); },
        });
        expect(probe.changesRow(row)).toBe(false);
      }
      expect(probe.hasAdditions).toBe(false);
      return operations;
    }
    const small = run(2_000);
    const large = run(16_000);
    expect(large).toBeLessThanOrEqual(small * 16);
    expect(large).toBeLessThanOrEqual(16_000 * 12);
  });
});
