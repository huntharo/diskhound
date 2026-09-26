import "node:fs";
import "node:fs/promises";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { expectIoBudget, measureFsIo } from "../test/ioBudget";
import { bootMainProcess, type MainProcess } from "../test/mainProcessHarness";
import { hostRoot, seedProfile } from "../test/mainProfileFixture";

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
vi.mock("../shared/crashLog", async (importOriginal) =>
  (await import("../test/mainProcessHarness")).settledCrashLog(await importOriginal()));

const DATA = hostRoot("/Volumes/Data");
const BACKUP = hostRoot("/Volumes/Backup");
/** Overview asks for the dense treemap at this size (DENSE_TREEMAP_LIMIT). */
const DENSE_TREEMAP_LIMIT = 5_000;

let main: MainProcess;

beforeAll(async () => {
  main = await bootMainProcess({
    seed: (userData) => seedProfile(userData, {
      roots: [{ rootPath: DATA, scans: 3 }, { rootPath: BACKUP, scans: 3 }],
    }).then(() => undefined),
  });
}, 60_000);

/** What App.tsx and a freshly mounted Overview ask main for when the user picks a scanned drive. */
async function switchTo(rootPath: string): Promise<void> {
  const latest = await main.invoke<{ rootPath: string } | null>("diskhound:get-latest-snapshot-for-root", rootPath);
  expect(latest?.rootPath).toBe(rootPath);
  await Promise.all([
    main.invoke("diskhound:get-treemap-files", rootPath, DENSE_TREEMAP_LIMIT),
    main.invoke("diskhound:get-latest-diff", rootPath),
    main.invoke("diskhound:get-dev-artifacts", rootPath, { sidecarOnly: true }),
    main.invoke("diskhound:get-settings"),
  ]);
}

describe("switching between two scanned drives", () => {
  it("reads each drive's saved scan once, then switches from memory", async () => {
    const first = await measureFsIo(async () => {
      await switchTo(DATA);
      await switchTo(BACKUP);
    }, { countProcesses: true });
    expectIoBudget({
      scenario: "main-drive-switch-first-visit",
      note: "first visit to each of two drives this session (App's get-latest-snapshot-for-root, then Overview's treemap, latest diff, Dev summary and settings): each drive's latest and previous snapshot (~2.8 MB each) and its latest two Dev sidecars (the older one for deltas) are read once",
      io: first.io,
    });

    const again = await measureFsIo(async () => {
      for (let i = 0; i < 5; i++) {
        await switchTo(DATA);
        await switchTo(BACKUP);
      }
    }, { countProcesses: true });
    expectIoBudget({
      scenario: "main-drive-switch-revisit",
      note: "10 more switches between the same two drives: everything from memory, 0 reads",
      io: again.io,
    });
  });
});
