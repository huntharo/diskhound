import * as FS from "node:fs";
import "node:fs/promises";
import * as Path from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import type { EasyMoveRecord, EasyMoveVerification, StorageStats } from "../shared/contracts";
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

const DATA = hostRoot("/Volumes/Data");
const BACKUP = hostRoot("/Volumes/Backup");
const EASY_MOVES = 20;

let main: MainProcess;

beforeAll(async () => {
  main = await bootMainProcess({
    seed: async (userData) => {
      await seedProfile(userData, { roots: [{ rootPath: DATA, scans: 7 }, { rootPath: BACKUP, scans: 7 }] });
      // Moves whose files are gone: verifying costs the same lstat and stat either way.
      const records: EasyMoveRecord[] = Array.from({ length: EASY_MOVES }, (_, i) => ({
        id: `move-${i}`,
        originalPath: Path.join(DATA, "Videos", `clip-${i}.mov`),
        symlinkPath: Path.join(DATA, "Videos", `clip-${i}.mov`),
        movedToPath: Path.join(BACKUP, "Moved", `clip-${i}.mov`),
        size: 4_000_000_000 + i,
        movedAt: 1_758_000_000_000 + i,
        isDirectory: false,
      }));
      FS.writeFileSync(Path.join(userData, "easy-moves.json"), JSON.stringify(records, null, 2));
    },
  });
}, 60_000);

/** What App's mount and SettingsView's sections ask main for. */
async function openSettings(): Promise<StorageStats> {
  const [, , stats] = await Promise.all([
    main.invoke("diskhound:get-settings"),
    main.invoke("diskhound:get-monitoring-snapshot"),
    main.invoke<StorageStats>("diskhound:get-storage-stats"),
    main.invoke("diskhound:get-elevation-status"),
    main.invoke("diskhound:get-update-state"),
  ]);
  return stats;
}

async function mountEasyMove(): Promise<EasyMoveVerification[]> {
  await main.invoke("diskhound:get-easy-moves");
  return main.invoke<EasyMoveVerification[]>("diskhound:verify-easy-moves");
}

describe("Settings", () => {
  it("sums storage once, then reopens from memory", async () => {
    const first = await measureFsIo(openSettings, { countProcesses: true });
    expect(first.result.fileCount).toBeGreaterThan(0);
    expectIoBudget({
      scenario: "main-settings-open-first",
      note: "first Settings open: Storage lists and stats every file under scan-indexes, scan-history and full-diff-cache (2 drives x 7 scans here); elevation status comes from the startup probe",
      io: first.io,
    });

    const again = await measureFsIo(async () => {
      for (let i = 0; i < 10; i++) await openSettings();
    }, { countProcesses: true });
    expectIoBudget({
      scenario: "main-settings-open-again",
      note: "10 more Settings opens within 10 minutes and no scan in between: 0 reads, 0 processes (was 3 readdir and a stat per file each open, and on Windows a schtasks spawn per get-elevation-status)",
      io: again.io,
    });
  });
});

describe("Easy Move tab", () => {
  it("verifies once on mount, then remounts from memory", async () => {
    const first = await measureFsIo(mountEasyMove, { countProcesses: true });
    expect(first.result).toHaveLength(EASY_MOVES);
    expectIoBudget({
      scenario: "main-easy-move-mount-first",
      note: "first Easy Move mount with 20 moves: an lstat of each link and a stat of each moved file",
      io: first.io,
    });

    const again = await measureFsIo(async () => {
      for (let i = 0; i < 10; i++) await mountEasyMove();
    }, { countProcesses: true });
    expectIoBudget({
      scenario: "main-easy-move-mount-again",
      note: "10 more mounts within 10 minutes: the last verification is reused, 0 reads (was an lstat and a stat per move per mount)",
      io: again.io,
    });

    const verify = await measureFsIo(
      () => main.invoke<EasyMoveVerification[]>("diskhound:verify-easy-moves", { force: true }),
      { countProcesses: true },
    );
    expectIoBudget({
      scenario: "main-easy-move-verify-button",
      note: "the Verify button always checks the disk: an lstat and a stat per move",
      io: verify.io,
    });
  });
});
