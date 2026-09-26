import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScanSnapshot, ScanStartInput } from "../../shared/contracts";
import { readDevArtifactSidecar } from "../../shared/devArtifactSidecar";
import { runScan } from "../scanWorker";

interface IndexLine {
  p: string;
  s?: number;
  t?: "d";
  h?: 1;
}

let base: string;
let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // realpath: macOS tmpdir is a /var → /private/var symlink.
  base = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-scan-hardlinks-")));
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
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
  const path = at(rel);
  FS.mkdirSync(Path.dirname(path), { recursive: true });
  FS.linkSync(target, path);
}

const occupancy = (path: string) => FS.statSync(path).blocks * 512;

/** Pin every directory's mtime so Phase-1 sees only the changes a test makes. */
function settleDirMtimes(dir: string): void {
  for (const entry of FS.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) settleDirMtimes(Path.join(dir, entry.name));
  }
  const past = new Date("2024-01-01T00:00:00Z");
  FS.utimesSync(dir, past, past);
}

function readIndex(path: string): IndexLine[] {
  return gunzipSync(FS.readFileSync(path))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as IndexLine);
}

async function scan(rootRel: string, name: string, extra: Partial<ScanStartInput> = {}) {
  const indexOutput = at(`out/${name}.ndjson.gz`);
  let snapshot: ScanSnapshot | null = null;
  await runScan({ rootPath: at(rootRel), options: {}, indexOutput, ...extra }, (message) => {
    if (message.type === "error") throw new Error(message.message);
    if (message.type === "done") snapshot = message.snapshot;
  });
  const files = readIndex(indexOutput).filter((line) => line.t !== "d");
  const extraLinks = files
    .filter((line) => line.h === 1)
    .map((line) => Path.relative(at(rootRel), line.p))
    .sort();
  return { snapshot: snapshot!, files, extraLinks, indexOutput };
}

const logged = (text: string) =>
  errorLog.mock.calls.some((call: unknown[]) => String(call[0]).includes(text));

it("reports walking, finalizing, and complete on a first scan and baseline rescan", async () => {
  write("root/data.bin", 8 * 1024);
  settleDirMtimes(at("root"));
  let baselineIndex: string | undefined;
  for (const name of ["first", "rescan"]) {
    const snapshots: ScanSnapshot[] = [];
    const indexOutput = at(`out/${name}.ndjson.gz`);
    await runScan({ rootPath: at("root"), options: {}, indexOutput, baselineIndex }, (message) => {
      if (message.type === "error") throw new Error(message.message);
      snapshots.push(message.snapshot);
    });

    expect(snapshots[0]).toMatchObject({ status: "running", scanPhase: "walking", filesVisited: 0 });
    expect(snapshots.some((s) => s.scanPhase === "walking" && s.filesVisited > 0 && s.bytesSeen > 0)).toBe(true);
    expect(snapshots.some((s) => s.scanPhase === "starting")).toBe(false);
    expect(snapshots.at(-2)).toMatchObject({ status: "running", scanPhase: "finalizing", filesVisited: 1 });
    expect(snapshots.at(-1)).toMatchObject({ status: "done", scanPhase: "complete", filesVisited: 1 });
    expect(readIndex(indexOutput).filter((line) => line.t !== "d")).toHaveLength(1);
    baselineIndex = indexOutput;
  }
  expect(logged("Phase-1 inheritance")).toBe(true);
});

describe.skipIf(process.platform === "win32")("scanWorker hardlinks", () => {
  it("counts a hardlinked file once and flags its later links", async () => {
    const shared = write("root/a.bin", 64 * 1024);
    link(shared, "root/sub/b.bin");
    link(shared, "root/sub/deeper/c.bin");
    const solo = write("root/solo.bin", 16 * 1024);
    // The other name is outside the scan, so the name inside owns it.
    const outside = write("elsewhere/lib.so", 32 * 1024);
    link(outside, "root/vendor/lib.so");

    const { snapshot, files, extraLinks } = await scan("root", "basic");

    expect(snapshot.filesVisited).toBe(5);
    expect(files).toHaveLength(5);
    expect(snapshot.bytesSeen).toBe(occupancy(shared) + occupancy(solo) + occupancy(outside));
    expect(extraLinks).toEqual(["sub/b.bin", "sub/deeper/c.bin"]);
    // Extra links keep their size in the index for display.
    expect(files.find((line) => line.p.endsWith("c.bin"))?.s).toBe(occupancy(shared));

    const sub = snapshot.hottestDirectories.find((dir) => dir.path === at("root/sub"));
    expect(sub).toMatchObject({ size: 0, fileCount: 2 });
    const root = snapshot.hottestDirectories.find((dir) => dir.path === at("root"));
    expect(root?.size).toBe(snapshot.bytesSeen);

    expect(snapshot.largestFiles.map((file) => Path.relative(at("root"), file.path)).sort())
      .toEqual(["a.bin", "solo.bin", "vendor/lib.so"]);
  });

  it("gives the bytes to the first link in walk order, the same one every scan", async () => {
    // Created first, but a file directly in the root is walked before
    // any subdirectory. The native walker uses the same order.
    const original = write("root/aaa/original.bin", 8 * 1024);
    link(original, "root/zzz.bin");
    link(original, "root/bbb/copy.bin");
    // Subdirectories go by name, not creation or readdir order.
    const madeFirst = write("root/zeta/made-first.bin", 4 * 1024);
    link(madeFirst, "root/alpha/made-second.bin");

    for (const run of ["first", "second"]) {
      const { snapshot, extraLinks } = await scan("root", run);
      expect(snapshot.bytesSeen).toBe(occupancy(original) + occupancy(madeFirst));
      expect(extraLinks).toEqual(["aaa/original.bin", "bbb/copy.bin", "zeta/made-first.bin"]);
    }
  });

  it("keeps pnpm-style linked node_modules out of Dev Artifacts", async () => {
    const content = write("root/.pnpm-store/v3/files/ab/cdef-index.js", 48 * 1024);
    for (const app of ["app", "web"]) {
      write(`root/${app}/package.json`, 100);
      link(content, `root/${app}/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.js`);
    }
    const devArtifactsOutput = at("out/dev.json.gz");

    await scan("root", "pnpm", { devArtifactsOutput });
    const sidecar = await readDevArtifactSidecar(devArtifactsOutput);

    expect(sidecar?.roots).toEqual([
      expect.objectContaining({ kind: "package-cache", size: occupancy(content), files: 1 }),
    ]);
  });

  it("stops inheriting at a new hardlink and keeps the inherited owner", async () => {
    const big = write("root/a-store/big.bin", 32 * 1024);
    const keep = write("root/keep.txt", 4 * 1024);
    settleDirMtimes(at("root"));
    const baseline = await scan("root", "baseline");
    expect(baseline.extraLinks).toEqual([]);

    // New dir: the root is walked, a-store is unchanged and inherited
    // first, then b-proj turns up the second name for big.bin.
    link(big, "root/b-proj/big.bin");
    const rescan = await scan("root", "rescan", { baselineIndex: baseline.indexOutput });
    expect(logged("hardlink found after 1 inherited dirs")).toBe(true);

    const fresh = await scan("root", "fresh");
    expect(rescan.extraLinks).toEqual(["b-proj/big.bin"]);
    expect(rescan.extraLinks).toEqual(fresh.extraLinks);
    expect(rescan.snapshot.bytesSeen).toBe(occupancy(big) + occupancy(keep));
    expect(rescan.snapshot.bytesSeen).toBe(fresh.snapshot.bytesSeen);
  });

  it("walks everything when the baseline already has extra links", async () => {
    const x = write("root/a/x.bin", 16 * 1024);
    link(x, "root/b/y.bin");
    settleDirMtimes(at("root"));
    const baseline = await scan("root", "baseline");
    expect(baseline.extraLinks).toEqual(["b/y.bin"]);

    // Only a/'s mtime moves. Inheriting the unchanged root would keep the
    // deleted owner and y.bin's stale h:1.
    FS.unlinkSync(x);
    const rescan = await scan("root", "rescan", { baselineIndex: baseline.indexOutput });

    expect(logged("baseline has 1 extra hardlinks")).toBe(true);
    expect(rescan.snapshot.filesVisited).toBe(1);
    expect(rescan.extraLinks).toEqual([]);
    expect(rescan.snapshot.bytesSeen).toBe(occupancy(at("root/b/y.bin")));
  });

  it("still inherits unchanged subtrees when there are no hardlinks", async () => {
    write("root/a/one.bin", 8 * 1024);
    write("root/b/two.bin", 8 * 1024);
    settleDirMtimes(at("root"));
    const baseline = await scan("root", "baseline");

    write("root/c/three.bin", 8 * 1024);
    const rescan = await scan("root", "rescan", { baselineIndex: baseline.indexOutput });

    expect(logged("Phase-1 inheritance: 2 dirs skipped")).toBe(true);
    expect(rescan.snapshot.filesVisited).toBe(3);
  });
});
