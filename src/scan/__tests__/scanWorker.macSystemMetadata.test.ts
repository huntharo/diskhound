import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ScanSnapshot } from "../../shared/contracts";
import { runScan } from "../scanWorker";

vi.mock("../../shared/scanPrune", async (original) => {
  const mod = await original<typeof import("../../shared/scanPrune")>();
  return { ...mod, loadScanPrunePlan: async () => mod.emptyPrunePlan() };
});
// Keep every scan and fixture in a temp profile, including on non-macOS CI.
vi.mock("../../shared/macSystemMetadata", async (original) => {
  const mod = await original<typeof import("../../shared/macSystemMetadata")>();
  return { ...mod, MacSystemMetadataTracker: class extends mod.MacSystemMetadataTracker {
    constructor(root: string) { super(root, [`${root}/.fseventsd`, `${root}/.Spotlight-V100`]); }
  } };
});
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
}));

let root: string;
const platform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  root = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-metadata-")));
  FS.mkdirSync(`${root}/.fseventsd`);
  FS.mkdirSync(`${root}/.Spotlight-V100`);
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
  vi.restoreAllMocks();
  FS.rmSync(root, { recursive: true, force: true });
});

async function scan(extra: { indexOutput?: string; baselineIndex?: string } = {}): Promise<ScanSnapshot> {
  let snapshot: ScanSnapshot | undefined;
  await runScan({ rootPath: root, options: {}, limits: { topFileLimit: 100, topDirectoryLimit: 1 }, ...extra }, (m) => {
    if (m.type === "done") snapshot = m.snapshot;
    if (m.type === "error") throw new Error(m.message);
  });
  return snapshot!;
}

it.skipIf(platform === "win32")("counts allocated bytes and cross-category hardlinks once, even below hotspot limits", async () => {
  FS.writeFileSync(`${root}/.fseventsd/log`, Buffer.alloc(8192));
  FS.linkSync(`${root}/.fseventsd/log`, `${root}/.Spotlight-V100/link`);
  FS.writeFileSync(`${root}/.Spotlight-V100/store`, Buffer.alloc(16384));
  const snapshot = await scan();
  const bytes = (p: string) => FS.statSync(p).blocks * 512;
  const eventsBytes = bytes(`${root}/.fseventsd/log`);
  const spotlightBytes = bytes(`${root}/.Spotlight-V100/store`);
  expect(snapshot.macSystemMetadata).toEqual([
    { kind: "fsevents", path: `${root}/.fseventsd`, bytes: 0, status: "complete" },
    { kind: "spotlight", path: `${root}/.Spotlight-V100`, bytes: eventsBytes + spotlightBytes, status: "complete" },
  ]);
  expect(snapshot.bytesSeen).toBe(eventsBytes + spotlightBytes);
  expect(snapshot.hottestDirectories).toHaveLength(1);
});

it.skipIf(platform === "win32")("shows denied stores as unavailable and partial reads as incomplete", async () => {
  FS.writeFileSync(`${root}/.fseventsd/log`, Buffer.alloc(8192));
  FS.mkdirSync(`${root}/.fseventsd/denied`);
  const read = FSP.readdir;
  vi.spyOn(FSP, "readdir").mockImplementation(((path: FS.PathLike, options: unknown) => {
    if (String(path).endsWith("/.Spotlight-V100") || String(path).endsWith("/denied")) {
      return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
    }
    return read(path, options as never);
  }) as typeof FSP.readdir);
  const snapshot = await scan();
  expect(snapshot.macSystemMetadata![0]).toMatchObject({ status: "incomplete", bytes: FS.statSync(`${root}/.fseventsd/log`).blocks * 512 });
  expect(snapshot.macSystemMetadata![1]).toMatchObject({ status: "unavailable", bytes: null });
});

it.skipIf(platform === "win32")("recounts changing stores even when directory mtimes match the baseline", async () => {
  const log = `${root}/.fseventsd/log`;
  FS.writeFileSync(log, Buffer.alloc(8192));
  const first = `${root}/first.gz`;
  await scan({ indexOutput: first });
  // Updating an existing file does not change its parent's mtime.
  FS.writeFileSync(log, Buffer.alloc(32768));
  const next = await scan({ indexOutput: `${root}/next.gz`, baselineIndex: first });
  expect(next.macSystemMetadata![0]).toMatchObject({ bytes: FS.statSync(log).blocks * 512, status: "complete" });
});
