import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseIndexLine } from "../indexLineParse";
import {
  buildSnapshotFromIndex,
  indexFilePath,
  initScanIndex,
  openIndexWriter,
} from "../scanIndex";

describe("parseIndexLine", () => {
  it("parses the canonical file shape and unescapes Windows paths", () => {
    const line = JSON.stringify({ p: "C:\\Users\\a.txt", s: 100, m: 2000 });
    expect(parseIndexLine(line)).toEqual({
      t: "f",
      p: "C:\\Users\\a.txt",
      s: 100,
      m: 2000,
    });
  });

  it("keeps the extra-hardlink occupancy flag", () => {
    const line = JSON.stringify({ p: "C:\\cache\\a", s: 10, m: 1, h: 1 });
    expect(parseIndexLine(line)).toEqual({
      t: "f",
      p: "C:\\cache\\a",
      s: 10,
      m: 1,
      h: 1,
    });
  });

  it("reads the APFS clone suffix on the fast path", () => {
    expect(parseIndexLine('{"p":"/u/a.js","s":4096,"m":1,"v":0,"k":1}')).toEqual({
      t: "f", p: "/u/a.js", s: 4096, m: 1, v: 0, k: 1,
    });
    expect(parseIndexLine('{"p":"/u/a.js","s":4096,"m":1,"h":1,"v":12}')).toEqual({
      t: "f", p: "/u/a.js", s: 4096, m: 1, h: 1, v: 12,
    });
    expect(parseIndexLine('{"p":"/u/a.js","s":4096,"m":1,"k":1}')).toEqual({
      t: "f", p: "/u/a.js", s: 4096, m: 1, k: 1,
    });
    // Out-of-order keys still parse through JSON.parse.
    expect(parseIndexLine('{"p":"/u/a.js","s":4096,"m":1,"k":1,"v":3}')).toEqual({
      t: "f", p: "/u/a.js", s: 4096, m: 1, v: 3, k: 1,
    });
  });

  it("decodes every escape the native writer emits on the fast path", () => {
    // append_json_escaped: \" \\ \n \r \t, other control chars as \u00XX.
    const path = 'C:\\odd "dir"\\a\tb\nc\rd\u0001e.bin';
    const line = JSON.stringify({ p: path, s: 1, m: 2 });
    expect(line).toContain("\\u0001");
    expect(parseIndexLine(line)).toEqual({ t: "f", p: path, s: 1, m: 2 });
    expect(parseIndexLine(JSON.stringify({ p: "/x\\\\y\"", s: 1, m: 2 }))).toMatchObject({ p: "/x\\\\y\"" });
  });

  it("reads the hardlink id between h and the clone suffix", () => {
    expect(parseIndexLine('{"p":"/s/a.js","s":4096,"m":1,"i":"16777232:4815"}')).toEqual({
      t: "f", p: "/s/a.js", s: 4096, m: 1, i: "16777232:4815",
    });
    expect(parseIndexLine('{"p":"/p/a.js","s":4096,"m":1,"h":1,"i":"16777232:4815","v":0,"k":1}')).toEqual({
      t: "f", p: "/p/a.js", s: 4096, m: 1, h: 1, i: "16777232:4815", v: 0, k: 1,
    });
    // JSON.stringify order from the JS worker (i before h) still parses.
    expect(parseIndexLine('{"p":"/p/a.js","s":4096,"m":1,"i":"1:2","h":1}')).toEqual({
      t: "f", p: "/p/a.js", s: 4096, m: 1, h: 1, i: "1:2",
    });
  });

  it("parses the canonical directory shape", () => {
    const line = JSON.stringify({ p: "C:\\Users", t: "d", m: 99 });
    expect(parseIndexLine(line)).toEqual({ t: "d", p: "C:\\Users" });
  });

  it("falls back to JSON.parse for odd field order", () => {
    const line = '{"m":9,"t":"d","p":"D:\\\\proj"}';
    expect(parseIndexLine(line)).toEqual({ t: "d", p: "D:\\proj" });
  });

  it("returns null for garbage", () => {
    expect(parseIndexLine("not json")).toBeNull();
    expect(parseIndexLine('{"s":1}')).toBeNull();
  });
});

describe("buildSnapshotFromIndex canonical + fallback lines", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-snapshot-parse-"));
    initScanIndex(tempDir);
  });

  afterEach(async () => {
    await FSP.rm(tempDir, { recursive: true, force: true });
  });

  it("aggregates files, dirs, and hardlink occupancy from mixed lines", async () => {
    const path = indexFilePath("snap-parse");
    const { stream, finalize } = openIndexWriter(path);
    stream.write(JSON.stringify({ p: "C:\\root", t: "d", m: 1 }) + "\n");
    stream.write(JSON.stringify({ p: "C:\\root\\a.txt", s: 100, m: 10 }) + "\n");
    stream.write(JSON.stringify({ p: "C:\\root\\b.bin", s: 50, m: 11, h: 1 }) + "\n");
    stream.write('{"m":12,"s":25,"p":"C:\\\\root\\\\odd.dat"}\n');
    await finalize();

    const snapshot = await buildSnapshotFromIndex({
      indexPath: path,
      rootPath: "C:\\root",
      engine: "native-sidecar",
      startedAt: 1_000,
      elapsedMs: 5,
    });

    expect(snapshot.filesVisited).toBe(3);
    expect(snapshot.bytesSeen).toBe(125);
    expect(snapshot.largestFiles.map((f) => f.path)).toEqual([
      "C:\\root\\a.txt",
      "C:\\root\\odd.dat",
    ]);
    expect(snapshot.directoriesVisited).toBeGreaterThanOrEqual(1);
  });
});
