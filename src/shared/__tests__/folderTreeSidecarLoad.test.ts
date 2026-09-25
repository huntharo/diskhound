import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadFolderTreeSidecar } from "../folderTreeSidecarLoad";

let tempDir: string;

beforeEach(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-tree-load-"));
});

afterEach(async () => {
  await FSP.rm(tempDir, { recursive: true, force: true });
});

async function writeSidecar(count: number): Promise<string> {
  const lines = Array.from({ length: count }, (_, i) =>
    JSON.stringify({ k: `/root/${i}`, d: [[`/root/${i}/sub`, i, 1]], f: [[`f${i}`, i, 7]] }),
  );
  const path = Path.join(tempDir, "scan.folder-tree.ndjson.gz");
  await FSP.writeFile(path, gzipSync(lines.join("\n") + "\nnot json\n"));
  return path;
}

describe("loadFolderTreeSidecar", () => {
  it("loads every line when the heap stays under the ceiling", async () => {
    const path = await writeSidecar(10_000);
    const result = await loadFolderTreeSidecar(path, {
      heapCeilingBytes: Number.MAX_SAFE_INTEGER,
      checkEveryLines: 1_000,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.tree.size).toBe(10_000);
    expect(result.parseFailures).toBe(1);
    expect(result.tree.get("/root/42")).toEqual({
      dirs: [{ path: "/root/42/sub", size: 42, fileCount: 1 }],
      files: [{ name: "f42", size: 42, modifiedAt: 7 }],
    });
  });

  it("stops and drops the partial tree once the heap passes the ceiling", async () => {
    const path = await writeSidecar(10_000);
    let checks = 0;
    const result = await loadFolderTreeSidecar(path, {
      heapCeilingBytes: 3_000,
      // Pretend each check finds 1,000 more bytes in use.
      heapUsedBytes: () => ++checks * 1_000,
      checkEveryLines: 1_000,
    });
    expect(result).toEqual({ status: "heap-ceiling", lines: 4_000, heapUsedBytes: 4_000 });
  });

  it("returns an error instead of hanging when the file is missing or corrupt", async () => {
    const missing = await loadFolderTreeSidecar(Path.join(tempDir, "missing.gz"), {
      heapCeilingBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(missing.status).toBe("error");

    const corrupt = Path.join(tempDir, "corrupt.gz");
    await FSP.writeFile(corrupt, gzipSync("x".repeat(100_000)).subarray(0, 64));
    const truncated = await loadFolderTreeSidecar(corrupt, { heapCeilingBytes: Number.MAX_SAFE_INTEGER });
    expect(truncated.status).toBe("error");
  });
});
