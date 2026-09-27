import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScanSnapshot } from "../../shared/contracts";
import type { ScanPrunePlan } from "../../shared/scanPrune";
import { inheritSubtree, loadBaseline, runScan } from "../scanWorker";

const prune = vi.hoisted(() => ({ plan: null as ScanPrunePlan | null }));

vi.mock("../../shared/scanPrune", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/scanPrune")>()),
  loadScanPrunePlan: async () => prune.plan,
}));

let base: string;

beforeEach(() => {
  // realpath: macOS tmpdir is a /var → /private/var symlink.
  base = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-scan-prune-")));
});

afterEach(() => {
  prune.plan = null;
  FS.rmSync(base, { recursive: true, force: true });
});

const at = (rel: string) => Path.join(base, rel);

function write(rel: string, bytes: number): string {
  const path = at(rel);
  FS.mkdirSync(Path.dirname(path), { recursive: true });
  FS.writeFileSync(path, Buffer.alloc(bytes, 7));
  return path;
}

const occupancy = (path: string) => FS.statSync(path).blocks * 512;

describe("scanWorker prune plan", () => {
  it.skipIf(process.platform === "win32")("removes pre-change iCloud records before an unchanged ancestor is inherited", async () => {
    const indexPath = at("old-index.ndjson.gz");
    const root = "/Users/me";
    const cloud = `${root}/Library/Mobile Documents`;
    const kept = `${root}/Documents/keep.txt`;
    const lines = [
      { p: root, t: "d", m: 1 },
      { p: `${root}/Library`, t: "d", m: 1 },
      { p: cloud, t: "d", m: 1 },
      { p: `${cloud}/com~apple~CloudDocs`, t: "d", m: 1 },
      { p: `${cloud}/com~apple~CloudDocs/old.txt`, s: 4096, m: 1 },
      { p: `${root}/Documents`, t: "d", m: 1 },
      { p: kept, s: 2048, m: 1 },
    ];
    FS.writeFileSync(indexPath, gzipSync(lines.map((line) => JSON.stringify(line)).join("\n") + "\n"));

    const baseline = await loadBaseline(indexPath, true);
    expect(inheritSubtree(root, baseline).map((file) => file.path)).toEqual([kept]);
    expect(baseline.dirMtimes.has(cloud)).toBe(false);
    expect(baseline.dirMtimes.has(`${cloud}/com~apple~CloudDocs`)).toBe(false);
    expect(baseline.dirMtimes.has(`${root}/Documents`)).toBe(true);

    const explicit = await loadBaseline(indexPath, false);
    expect(inheritSubtree(root, explicit).map((file) => file.path)).toContain(`${cloud}/com~apple~CloudDocs/old.txt`);
  });

  // A small `/` on macOS: Users is the firmlinked name and Data/Users its
  // twin (a copy stands in for the firmlink), Data/.Spotlight-V100 is
  // Data-only, and Volumes/USB is another disk. bind stands in for a Linux
  // bind mount's second copy.
  it("skips twins, second copies and other disks, walks Data-only folders, and reports only the disks", async () => {
    const home = write("root/Users/me/a.bin", 8 * 1024);
    write("root/Data/Users/me/a.bin", 8 * 1024);
    const dataOnly = write("root/Data/.Spotlight-V100/store.db", 4 * 1024);
    write("root/Volumes/USB/photo.jpg", 16 * 1024);
    write("root/bind/me/a.bin", 8 * 1024);
    prune.plan = {
      otherMounts: new Set([at("root/Volumes/USB")]),
      duplicateMounts: new Set([at("root/bind")]),
      firmlinkTwins: new Set([at("root/Data/Users")]),
      pruneICloudDrive: false,
    };
    const indexOutput = at("out/index.ndjson.gz");

    let snapshot: ScanSnapshot | null = null;
    await runScan({ rootPath: at("root"), options: {}, indexOutput }, (message) => {
      if (message.type === "error") throw new Error(message.message);
      if (message.type === "done") snapshot = message.snapshot;
    });

    const lines = gunzipSync(FS.readFileSync(indexOutput)).toString("utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { p: string; t?: "d" });
    const files = lines.filter((line) => line.t !== "d").map((line) => line.p).sort();
    const dirs = lines.filter((line) => line.t === "d").map((line) => line.p);
    expect(files).toEqual([dataOnly, home].sort());
    expect(dirs).toContain(at("root/Data/.Spotlight-V100"));
    expect(dirs.some((dir) => dir.startsWith(at("root/Data/Users")))).toBe(false);
    expect(dirs.some((dir) => dir.startsWith(at("root/Volumes/USB")))).toBe(false);
    expect(dirs.some((dir) => dir.startsWith(at("root/bind")))).toBe(false);
    expect(snapshot!.bytesSeen).toBe(occupancy(home) + occupancy(dataOnly));
    expect(snapshot!.skippedMounts).toEqual([at("root/Volumes/USB")]);
  });

  it("leaves skippedMounts off when nothing was left out", async () => {
    write("root/a.txt", 10);
    prune.plan = { otherMounts: new Set(), duplicateMounts: new Set(), firmlinkTwins: new Set(), pruneICloudDrive: false };
    let snapshot: ScanSnapshot | null = null;
    await runScan({ rootPath: at("root"), options: {} }, (message) => {
      if (message.type === "done") snapshot = message.snapshot;
    });
    expect(snapshot!.filesVisited).toBe(1);
    expect(snapshot!).not.toHaveProperty("skippedMounts");
  });
});
