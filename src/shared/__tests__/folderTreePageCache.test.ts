import { describe, expect, it } from "vitest";

import { EMPTY_FOLDER_NODE, FolderTreePageCache } from "../folderTreePageCache";
import type { FolderTreeSidecarQueryResult } from "../folderTreeSidecarQuery";

const node = (file: string) => ({ dirs: [], files: [{ name: file, size: 1, modifiedAt: 1 }] });

function page(anchorKey: string, keys: string[], coveredDepth: number, bytesKept = 100): FolderTreeSidecarQueryResult {
  return {
    anchorKey,
    entries: keys.map((k) => [k, node(k)]),
    coveredDepth,
    linesScanned: 1_000,
    bytesKept,
  };
}

describe("FolderTreePageCache", () => {
  it("serves covered keys, empties for covered folders with no line, and misses outside coverage", () => {
    const cache = new FolderTreePageCache(1 << 20, "/");
    cache.add("scan", page("/a", ["/a", "/a/b", "/a/b/c"], 2));
    expect(cache.lookup("scan", "/a/b")?.files[0].name).toBe("/a/b");
    expect(cache.lookup("scan", "/a/b/c")?.files[0].name).toBe("/a/b/c");
    expect(cache.lookup("scan", "/a/empty")).toBe(EMPTY_FOLDER_NODE);
    expect(cache.lookup("scan", "/a/b/c/d")).toBeNull();
    expect(cache.lookup("scan", "/ab")).toBeNull();
    expect(cache.lookup("other-scan", "/a")).toBeNull();
  });

  it("serves a pinned target deeper than the page's coverage", () => {
    const cache = new FolderTreePageCache(1 << 20, "/");
    cache.add("scan", page("/a", ["/a", "/a/b/c/d"], 0));
    expect(cache.lookup("scan", "/a/b/c/d")?.files[0].name).toBe("/a/b/c/d");
    expect(cache.lookup("scan", "/a/b")).toBeNull();
  });

  it("evicts least recently used pages past the heap budget, whole", () => {
    // 100 line bytes ≈ 250 heap bytes per page; room for two.
    const cache = new FolderTreePageCache(500, "/");
    cache.add("scan", page("/one", ["/one"], 1));
    cache.add("scan", page("/two", ["/two"], 1));
    expect(cache.lookup("scan", "/one")).not.toBeNull(); // now most recent
    cache.add("scan", page("/three", ["/three"], 1));
    expect(cache.lookup("scan", "/two")).toBeNull();
    expect(cache.lookup("scan", "/one")).not.toBeNull();
    expect(cache.lookup("scan", "/three")).not.toBeNull();
    expect(cache.stats()).toEqual({ pages: 2, nodes: 2, heapBytes: 500 });
  });

  it("keeps a single page that is over budget on its own", () => {
    const cache = new FolderTreePageCache(10, "/");
    cache.add("scan", page("/huge", ["/huge"], 0, 1_000));
    expect(cache.lookup("scan", "/huge")).not.toBeNull();
  });

  it("drops every page of a scan on invalidate", () => {
    const cache = new FolderTreePageCache(1 << 20, "\\");
    cache.add("old", page("c:", ["c:", "c:\\users"], 1));
    cache.add("new", page("c:", ["c:"], 1));
    cache.invalidateScan("old");
    expect(cache.lookup("old", "c:\\users")).toBeNull();
    expect(cache.lookup("new", "c:")).not.toBeNull();
    expect(cache.stats().pages).toBe(1);
  });
});
