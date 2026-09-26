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

const ROOT = hostRoot("/Volumes/Data");

let main: MainProcess;

beforeAll(async () => {
  main = await bootMainProcess({
    seed: (userData) => seedProfile(userData, { roots: [{ rootPath: ROOT, scans: 2 }] }).then(() => undefined),
  });
}, 60_000);

describe("renderer polls that answer from memory", () => {
  it("serves an hour of the renderer's snapshot, monitoring and schedule polls without disk or processes", async () => {
    // The System widget polls get-current-snapshot every 10 s (App
    // reads it once at boot), Settings polls get-monitoring-snapshot
    // every 15 s, and Changes polls get-scan-schedule-info every 30 s.
    // 120 of each is an hour of Changes and half an hour of Settings:
    const { io } = await measureFsIo(async () => {
      for (let i = 0; i < 120; i++) {
        await main.invoke("diskhound:get-current-snapshot");
        await main.invoke("diskhound:get-monitoring-snapshot");
        await main.invoke("diskhound:get-scan-schedule-info");
      }
    }, { countProcesses: true });

    const snapshot = await main.invoke<{ rootPath: string; status: string }>("diskhound:get-current-snapshot");
    expect(snapshot).toMatchObject({ rootPath: ROOT, status: "done" });
    expectIoBudget({
      scenario: "main-polls-snapshot-monitoring-schedule",
      note: "120 rounds of get-current-snapshot, get-monitoring-snapshot and get-scan-schedule-info (20 min of the widget's 10 s poll, 30 min of Settings' 15 s, an hour of Changes' 30 s): all from memory, 0 reads and 0 processes at any setting",
      io,
    });
  });
});
