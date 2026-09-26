import "node:fs";
import "node:fs/promises";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { expectIoBudget, measureFsIo } from "../test/ioBudget";
import { bootMainProcess, type MainProcess } from "../test/mainProcessHarness";
import { hostRoot, seedProfile, type SeededRoot } from "../test/mainProfileFixture";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFsPromises(await importOriginal()));
vi.mock("node:child_process", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentChildProcess(await importOriginal()));
vi.mock("node:worker_threads", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentWorkerThreads(await importOriginal()));
vi.mock("electron", async () =>
  (await import("../test/mainProcessHarness")).fakeElectron());

const DATA = hostRoot("/Volumes/Data");
const BACKUP = hostRoot("/Volumes/Backup");
const MEDIA = hostRoot("/Volumes/Media");
/** Scanned before folder-tree sidecars existed: Folders has to build from the index. */
const LEGACY = hostRoot("/Volumes/Legacy");

// Each tree is 201 folders and 5,000 files, which folderTreeLoadPlan
// prices at ~0.7 MB of heap. A 1.6 MB cap holds two of them, not three.
const TREE_HEAP_CAP_MB = "1.6";

type FolderChildren = { dirs: Array<{ path: string }>; files: unknown[]; unavailableMessage?: string };

let main: MainProcess;
let roots: Map<string, SeededRoot>;

beforeAll(async () => {
  vi.stubEnv("DISKHOUND_FOLDER_TREE_MAX_HEAP_MB", TREE_HEAP_CAP_MB);
  main = await bootMainProcess({
    seed: async (userData) => {
      const seeded = await seedProfile(userData, {
        roots: [
          { rootPath: DATA, scans: 2 },
          { rootPath: BACKUP, scans: 2 },
          { rootPath: MEDIA, scans: 2 },
          { rootPath: LEGACY, scans: 1, folderTree: false },
        ],
      });
      roots = new Map(seeded.map((root) => [root.rootPath, root]));
    },
  });
}, 60_000);

/** Opens Folders at the drive's root, then drills into `count` of its folders. */
async function browse(rootPath: string, count: number): Promise<void> {
  const top = await main.invoke<FolderChildren>("diskhound:get-folder-children", rootPath, rootPath);
  expect(top.dirs.length).toBeGreaterThan(0);
  for (const folder of roots.get(rootPath)!.folders.slice(0, count)) {
    await main.invoke("diskhound:get-folder-children", rootPath, folder);
  }
}

describe("Folders tab", () => {
  it("drills into every folder of the pre-warmed drive from memory", async () => {
    // Startup pre-warmed the tree of the scan last-scan.json restored,
    // and bootMainProcess waited for that load.
    const { io } = await measureFsIo(() => browse(DATA, 200), { countProcesses: true });
    expectIoBudget({
      scenario: "main-folders-drill-in-warm",
      note: "201 get-folder-children calls once startup's pre-warm has loaded the drive's tree: 0 reads",
      io,
    });
  });

  it("loads a second drive's tree once, then switches between the two from memory", async () => {
    const first = await measureFsIo(() => browse(BACKUP, 5), { countProcesses: true });
    expectIoBudget({
      scenario: "main-folders-second-drive-first-visit",
      note: "first Folders visit to a second drive: its folder-tree sidecar is planned (stat, exists) and streamed once, with 3 crash.log lines",
      io: first.io,
    });

    const switching = await measureFsIo(async () => {
      for (let i = 0; i < 10; i++) {
        await browse(DATA, 5);
        await browse(BACKUP, 5);
      }
    }, { countProcesses: true });
    expectIoBudget({
      scenario: "main-folders-switch-two-drives",
      note: "20 Folders visits alternating between two drives whose trees fit the tree heap cap together: 0 reads (the old 600k-entry cap evicted down to one tree and re-read the other drive's ~50 MB sidecar on every switch)",
      io: switching.io,
    });
  });

  it("evicts the least recently used tree when a third drive would pass the heap cap", async () => {
    const { io } = await measureFsIo(async () => {
      await browse(MEDIA, 5); // loads MEDIA, evicts DATA (BACKUP was used last)
      await browse(BACKUP, 5); // still cached
      await browse(DATA, 5); // loads DATA again, evicts MEDIA
    }, { countProcesses: true });
    expectIoBudget({
      scenario: "main-folders-third-drive-evicts-lru",
      note: "a third drive when two trees fill the heap cap: its sidecar is read, the least recently used tree goes, and returning to that drive reads its sidecar again; the drive in between stays in memory",
      io,
    });
  });

  it("does not retry a failed folder-tree build on every click", async () => {
    // Under vitest the bundled worker script is not built, so the
    // rebuild from the index fails the way a worker OOM does in the field.
    const first = await measureFsIo(
      () => main.invoke<FolderChildren>("diskhound:get-folder-children", LEGACY, LEGACY),
      { countProcesses: true },
    );
    expect(first.result.dirs).toEqual([]);
    expectIoBudget({
      scenario: "main-folders-build-failure-first",
      note: "Folders on a scan with no folder-tree sidecar whose rebuild fails: 1 worker is started to rebuild from the index (it fails under vitest, which has no bundled worker), and the failure is logged in 3 crash.log lines",
      io: first.io,
    });

    const again = await measureFsIo(async () => {
      for (let i = 0; i < 10; i++) {
        await main.invoke("diskhound:get-folder-children", LEGACY, LEGACY);
      }
    }, { countProcesses: true });
    expectIoBudget({
      scenario: "main-folders-build-failure-repeat",
      note: "10 more clicks on that drive within 10 minutes of the failure: the failure is remembered, so 0 workers and 0 crash.log lines (was 1 worker streaming the whole index and 3 log writes per click)",
      io: again.io,
    });
  });
});
