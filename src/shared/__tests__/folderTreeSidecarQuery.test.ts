import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseFolderTreeSidecarLine } from "../folderTreeSidecarParse";
import { queryFolderTreeSidecar, relativeDepth } from "../folderTreeSidecarQuery";

type Row = [string, number, number];
type Line = { k: string; d: Row[]; f: Row[] };

let tempDir: string;

beforeEach(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-tree-query-"));
});

afterEach(async () => {
  await FSP.rm(tempDir, { recursive: true, force: true });
});

async function writeSidecar(lines: (Line | string)[]): Promise<string> {
  const path = Path.join(tempDir, "scan.folder-tree.ndjson.gz");
  const text = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n";
  await FSP.writeFile(path, gzipSync(text));
  return path;
}

/** A POSIX tree `/` → a0..a3 → b0..b3 → c0..c3 → d0..d3, one file per folder. */
function posixTree(): Line[] {
  const lines: Line[] = [];
  const walk = (key: string, depth: number) => {
    const children = depth < 4 ? [0, 1, 2, 3].map((i) => `${key}/${"abcd"[depth]}${i}`) : [];
    lines.push({ k: key, d: children.map((c) => [c, 100, 1] as Row), f: [[`file-${depth}.bin`, 10, 1]] });
    for (const child of children) walk(child, depth + 1);
  };
  walk("", 0);
  // A sibling whose name shares the target's prefix must not match.
  lines.push({ k: "/a1x", d: [], f: [["decoy", 1, 1]] });
  // Shuffle deterministically: both writers emit parents in hash order.
  return lines.sort((a, b) => (hash(a.k) - hash(b.k)));
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Brute force: every parsed line within `depth` of the target. */
function oracle(lines: Line[], target: string, separator: string, depth: number): string[] {
  return lines
    .filter((line) => {
      const d = relativeDepth(line.k, target, separator);
      return d >= 0 && d <= depth;
    })
    .map((line) => line.k)
    .sort();
}

const keys = (entries: [string, unknown][]) => entries.map(([k]) => k).sort();

describe("queryFolderTreeSidecar", () => {
  it("returns the target and its subtree to maxDepth, not prefix-sharing siblings", async () => {
    const lines = posixTree();
    const sidecarPath = await writeSidecar(lines);
    const result = await queryFolderTreeSidecar({
      sidecarPath, targetKey: "/a1", separator: "/", maxDepth: 2, maxBytes: 1 << 20,
    });
    expect(result.coveredDepth).toBe(2);
    expect(keys(result.entries)).toEqual(oracle(lines, "/a1", "/", 2));
    expect(keys(result.entries)).toContain("/a1/b2/c3");
    expect(keys(result.entries)).not.toContain("/a1x");
    expect(keys(result.entries)).not.toContain("/a1/b2/c3/d0");
    expect(result.linesScanned).toBe(lines.length);
    const target = result.entries.find(([k]) => k === "/a1")?.[1];
    expect(target?.dirs.map((d) => d.path)).toEqual(["/a1/b0", "/a1/b1", "/a1/b2", "/a1/b3"]);
    expect(target?.files).toEqual([{ name: "file-1.bin", size: 10, modifiedAt: 1 }]);
  });

  it("treats the POSIX root key \"\" as the parent of every absolute key", async () => {
    const lines = posixTree();
    const sidecarPath = await writeSidecar(lines);
    const result = await queryFolderTreeSidecar({
      sidecarPath, targetKey: "", separator: "/", maxDepth: 1, maxBytes: 1 << 20,
    });
    expect(keys(result.entries)).toEqual(["", "/a0", "/a1", "/a1x", "/a2", "/a3"]);
  });

  it("matches escaped Windows keys", async () => {
    const lines: Line[] = [
      { k: "c:", d: [["c:\\users", 30, 3]], f: [] },
      { k: "c:\\users", d: [["c:\\users\\ann", 30, 3]], f: [["ntuser.dat", 5, 1]] },
      { k: "c:\\users\\ann", d: [["c:\\users\\ann\\docs", 20, 2]], f: [["a \"quoted\" name", 10, 1]] },
      { k: "c:\\users\\ann\\docs", d: [], f: [["x.txt", 20, 1]] },
      { k: "c:\\usersx", d: [], f: [] },
    ];
    const sidecarPath = await writeSidecar(lines);
    const fromRoot = await queryFolderTreeSidecar({
      sidecarPath, targetKey: "c:", separator: "\\", maxDepth: 2, maxBytes: 1 << 20,
    });
    expect(keys(fromRoot.entries)).toEqual(["c:", "c:\\users", "c:\\users\\ann", "c:\\usersx"]);

    const fromUsers = await queryFolderTreeSidecar({
      sidecarPath, targetKey: "c:\\users", separator: "\\", maxDepth: 3, maxBytes: 1 << 20,
    });
    expect(keys(fromUsers.entries)).toEqual(["c:\\users", "c:\\users\\ann", "c:\\users\\ann\\docs"]);
    const ann = fromUsers.entries.find(([k]) => k === "c:\\users\\ann")?.[1];
    expect(ann?.files[0].name).toBe('a "quoted" name');
  });

  it("drops whole levels from the bottom when over maxBytes, keeping coverage exact", async () => {
    const lines = posixTree();
    const sidecarPath = await writeSidecar(lines);
    const lineBytes = (depthWanted: number) =>
      lines
        .filter((l) => { const d = relativeDepth(l.k, "", "/"); return d >= 0 && d <= depthWanted; })
        .reduce((sum, l) => sum + Buffer.byteLength(JSON.stringify(l)), 0);
    // Room for levels 0-2 but not 3.
    const maxBytes = lineBytes(2) + 10;
    const result = await queryFolderTreeSidecar({
      sidecarPath, targetKey: "", separator: "/", maxDepth: 4, maxBytes,
    });
    expect(result.coveredDepth).toBe(2);
    expect(result.bytesKept).toBeLessThanOrEqual(maxBytes);
    expect(keys(result.entries)).toEqual(oracle(lines, "", "/", 2));
  });

  it("always keeps the target line, even when it alone is over budget", async () => {
    const lines = posixTree();
    const sidecarPath = await writeSidecar(lines);
    const result = await queryFolderTreeSidecar({
      sidecarPath, targetKey: "/a2", separator: "/", maxDepth: 3, maxBytes: 1,
    });
    expect(result.coveredDepth).toBe(0);
    expect(keys(result.entries)).toEqual(["/a2"]);
  });

  it("reports coverage for a folder with no line (an empty folder)", async () => {
    const sidecarPath = await writeSidecar(posixTree());
    const result = await queryFolderTreeSidecar({
      sidecarPath, targetKey: "/a0/b0/c0/d0/empty", separator: "/", maxDepth: 2, maxBytes: 1 << 20,
    });
    expect(result.entries).toEqual([]);
    expect(result.coveredDepth).toBe(2);
  });

  it("reassembles lines that span gunzip chunks", async () => {
    // One 3 MB line (more than two 1 MB output chunks) between small ones.
    const bigDirs: Row[] = Array.from({ length: 40_000 }, (_, i) => [`/big/child-with-a-long-name-${i}`, i, 1]);
    const filler: Line[] = Array.from({ length: 5_000 }, (_, i) => ({
      k: `/filler/${i}`, d: [], f: [[`f${i}.dat`, i, 1]],
    }));
    const lines: Line[] = [
      ...filler.slice(0, 2_500),
      { k: "/big", d: bigDirs, f: [] },
      ...filler.slice(2_500),
      { k: "/big/child-with-a-long-name-7", d: [], f: [["x", 1, 1]] },
    ];
    const sidecarPath = await writeSidecar(lines);
    const result = await queryFolderTreeSidecar({
      sidecarPath, targetKey: "/big", separator: "/", maxDepth: 1, maxBytes: 8 << 20,
    });
    expect(result.linesScanned).toBe(lines.length);
    expect(keys(result.entries)).toEqual(["/big", "/big/child-with-a-long-name-7"]);
    const big = result.entries.find(([k]) => k === "/big")?.[1];
    expect(big?.dirs).toHaveLength(40_000);
    expect(big?.dirs[39_999].path).toBe("/big/child-with-a-long-name-39999");
  });

  it("compares decoded keys when the target has characters the writers escape differently", async () => {
    // The native writer emits \u0008 where JSON.stringify emits \b.
    const nativeLine = '{"k":"/tmp/odd\\u0008name","d":[["/tmp/odd\\u0008name/sub",1,1]],"f":[]}';
    const lines = [
      nativeLine,
      JSON.stringify({ k: "/tmp/odd\bname/sub", d: [], f: [["y", 1, 1]] }),
      JSON.stringify({ k: "/tmp/other", d: [], f: [] }),
    ];
    const sidecarPath = await writeSidecar(lines);
    const target = parseFolderTreeSidecarLine(nativeLine)?.key;
    expect(target).toBe("/tmp/odd\bname");
    const result = await queryFolderTreeSidecar({
      sidecarPath, targetKey: target as string, separator: "/", maxDepth: 1, maxBytes: 1 << 20,
    });
    expect(keys(result.entries)).toEqual(["/tmp/odd\bname", "/tmp/odd\bname/sub"]);
  });

  it("stops reading once the target is found and nothing deeper is wanted", async () => {
    const lines = posixTree();
    const target = lines[3].k;
    const filler: Line[] = Array.from({ length: 50_000 }, (_, i) => ({ k: `/zz/${i}`, d: [], f: [] }));
    const sidecarPath = await writeSidecar([...lines, ...filler]);
    const result = await queryFolderTreeSidecar({
      sidecarPath, targetKey: target, separator: "/", maxDepth: 0, maxBytes: 1 << 20,
    });
    expect(keys(result.entries)).toEqual([target]);
    expect(result.linesScanned).toBeLessThan(lines.length + filler.length);
  });

  it("prefetches the target's siblings when anchored at its parent", async () => {
    const lines = posixTree();
    const sidecarPath = await writeSidecar(lines);
    const result = await queryFolderTreeSidecar({
      sidecarPath, targetKey: "/a1/b2", anchorKey: "/a1", separator: "/", maxDepth: 2, maxBytes: 1 << 20,
    });
    expect(result.anchorKey).toBe("/a1");
    expect(result.coveredDepth).toBe(2);
    expect(keys(result.entries)).toEqual(oracle(lines, "/a1", "/", 2));
    expect(keys(result.entries)).toContain("/a1/b0/c1");
  });

  it("keeps the target's line when its level is dropped for size", async () => {
    const lines = posixTree();
    const sidecarPath = await writeSidecar(lines);
    const result = await queryFolderTreeSidecar({
      sidecarPath, targetKey: "/a1/b2/c3", anchorKey: "/a1", separator: "/", maxDepth: 3, maxBytes: 1,
    });
    expect(result.coveredDepth).toBe(0);
    expect(keys(result.entries)).toEqual(["/a1", "/a1/b2/c3"]);
    expect(result.entries.find(([k]) => k === "/a1/b2/c3")?.[1].files[0].name).toBe("file-3.bin");
  });

  it("refuses an anchor that isn't an ancestor of the target", async () => {
    const sidecarPath = await writeSidecar(posixTree());
    await expect(queryFolderTreeSidecar({
      sidecarPath, targetKey: "/a1/b2", anchorKey: "/a2", separator: "/", maxDepth: 1, maxBytes: 1024,
    })).rejects.toThrow(/not an ancestor/);
  });

  it("rejects when the sidecar is missing or corrupt", async () => {
    await expect(queryFolderTreeSidecar({
      sidecarPath: Path.join(tempDir, "missing.gz"), targetKey: "/", separator: "/", maxDepth: 1, maxBytes: 1024,
    })).rejects.toThrow(/ENOENT/);
    const corrupt = Path.join(tempDir, "corrupt.gz");
    await FSP.writeFile(corrupt, gzipSync("x".repeat(10_000)).subarray(0, 40));
    await expect(queryFolderTreeSidecar({
      sidecarPath: corrupt, targetKey: "/", separator: "/", maxDepth: 1, maxBytes: 1024,
    })).rejects.toThrow();
  });
});

describe("relativeDepth", () => {
  it("counts levels below the target", () => {
    expect(relativeDepth("/a", "/a", "/")).toBe(0);
    expect(relativeDepth("/a/b/c", "/a", "/")).toBe(2);
    expect(relativeDepth("/ab", "/a", "/")).toBe(-1);
    expect(relativeDepth("/a", "", "/")).toBe(1);
    expect(relativeDepth("c:\\x\\y", "c:", "\\")).toBe(2);
  });
});
