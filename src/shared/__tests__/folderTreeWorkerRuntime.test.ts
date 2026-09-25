import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFolderTreeFromIndex } from "../folderTreeWorkerRuntime";
import { normPath } from "../pathUtils";

describe("buildFolderTreeFromIndex line parsing", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-folder-tree-parse-"));
  });

  afterEach(async () => {
    await FSP.rm(tempDir, { recursive: true, force: true });
  });

  async function treeFor(lines: string[]) {
    const indexPath = Path.join(tempDir, "scan.ndjson.gz");
    await FSP.writeFile(indexPath, gzipSync(lines.map((line) => line + "\n").join("")));
    return new Map(await buildFolderTreeFromIndex(indexPath));
  }

  /** Where the worker files `path`, split with the host's Path like the worker does. */
  function placement(path: string) {
    const key = normPath(path).replace(/[\\/]+$/, "");
    return { parent: normPath(Path.dirname(key)), name: Path.basename(key) };
  }

  it("decodes every escape the native writer emits on the fast path", async () => {
    // append_json_escaped: \" \\ \n \r \t, other control chars as \u00XX.
    const path = 'C:\\odd "dir"\\a\tb\nc\rd\u0001e.bin';
    const line = JSON.stringify({ p: path, s: 7, m: 9 });
    expect(line).toContain("\\u0001");

    // `/` splits on every host, so this one nests under a real parent
    // on POSIX CI too, where the `C:\` path is a single name under ".".
    const slashPath = '/odd "dir"/a\tb\nc\rd\u0001e.bin';

    const tree = await treeFor([line, JSON.stringify({ p: slashPath, s: 5, m: 6 })]);
    const { parent, name } = placement(path);
    expect(name.endsWith("a\tb\nc\rd\u0001e.bin")).toBe(true);
    expect(tree.get(parent)?.files).toEqual([{ name, size: 7, modifiedAt: 9 }]);

    const slash = placement(slashPath);
    expect(slash.parent).toBe(normPath('/odd "dir"'));
    expect(slash.name).toBe("a\tb\nc\rd\u0001e.bin");
    expect(tree.get(slash.parent)?.files).toEqual([{ name: slash.name, size: 5, modifiedAt: 6 }]);
  });

  it("still unescapes plain Windows separators and skips an invalid escape", async () => {
    const path = "C:\\Users\\a.txt";
    const { parent, name } = placement(path);
    const tree = await treeFor([
      JSON.stringify({ p: "C:\\Users", t: "d", m: 1 }),
      JSON.stringify({ p: path, s: 3, m: 4 }),
      '{"p":"C:\\\\Users\\\\b\\q.txt","s":8,"m":8}',
    ]);
    expect(tree.get(parent)?.files).toEqual([{ name, size: 3, modifiedAt: 4 }]);
  });
});
