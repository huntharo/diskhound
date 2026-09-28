import * as FS from "node:fs";
import "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppSettings } from "../shared/contracts";
import { powerEfficiencyWorkers } from "../shared/powerEfficiency";
import { expectIoBudget, measureFsIo } from "../test/ioBudget";
import { bootMainProcess, type MainProcess } from "../test/mainProcessHarness";

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

const CPUS = OS.availableParallelism();

let main: MainProcess;

beforeAll(async () => {
  main = await bootMainProcess();
}, 60_000);

const settingsOnDisk = (): AppSettings =>
  JSON.parse(FS.readFileSync(Path.join(main.userData, "settings.json"), "utf8")) as AppSettings;

describe("choosing a Power Efficiency preset", () => {
  it("saves it once, and a repeat or a bad value writes nothing", async () => {
    await main.invoke("diskhound:set-power-efficiency", "miser");

    const choose = await measureFsIo(
      () => main.invoke<AppSettings>("diskhound:set-power-efficiency", "balanced"),
      { countProcesses: true },
    );
    expect(choose.result.scanning.powerEfficiency).toBe("balanced");
    expect(settingsOnDisk().scanning.powerEfficiency).toBe("balanced");
    expectIoBudget({
      scenario: "main-power-efficiency-choose",
      note: "a menu choice: one settings.json rewrite (~2 KB), no process; only on a click, so a handful of writes a day at most, at any monitoring interval",
      io: choose.io,
    });

    const same = await measureFsIo(async () => {
      await main.invoke("diskhound:set-power-efficiency", "balanced");
      await expect(main.invoke("diskhound:set-power-efficiency", "turbo")).rejects.toThrow(/Unknown Power Efficiency/);
    }, { countProcesses: true });
    expect(settingsOnDisk().scanning.powerEfficiency).toBe("balanced");
    expectIoBudget({
      scenario: "main-power-efficiency-choose-same",
      note: "choosing the saved preset again, then an unknown one: 0 writes",
      io: same.io,
    });
  });
});

// The fake scanner is a shell script, which Windows can't spawn without a
// shell. What it checks, when main reads the setting, is the same there.
describe.skipIf(process.platform === "win32")("a scan and the Power Efficiency setting", () => {
  let scratch: string;
  let log: string;
  const saved = {
    path: process.env.DISKHOUND_NATIVE_SCANNER_PATH,
    log: process.env.DISKHOUND_FAKE_SCANNER_LOG,
  };

  beforeAll(() => {
    scratch = FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-power-"));
    log = Path.join(scratch, "spawns.log");
    const scanner = Path.join(scratch, "fake-scanner");
    // Records its pid and arguments, then waits to be stopped, as a
    // scanner on a big drive would.
    FS.writeFileSync(scanner, '#!/bin/sh\necho "$$ $*" >> "$DISKHOUND_FAKE_SCANNER_LOG"\nexec sleep 600\n', { mode: 0o755 });
    FS.mkdirSync(Path.join(scratch, "root"));
    process.env.DISKHOUND_NATIVE_SCANNER_PATH = scanner;
    process.env.DISKHOUND_FAKE_SCANNER_LOG = log;
  });

  afterAll(() => {
    for (const [name, value] of [["DISKHOUND_NATIVE_SCANNER_PATH", saved.path], ["DISKHOUND_FAKE_SCANNER_LOG", saved.log]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    FS.rmSync(scratch, { recursive: true, force: true });
  });

  const spawns = () => (FS.existsSync(log) ? FS.readFileSync(log, "utf8").trim().split("\n") : [])
    .map((line) => {
      const [pid, ...args] = line.split(" ");
      const at = args.indexOf("--workers");
      return { pid: Number(pid), workers: at >= 0 ? Number(args[at + 1]) : null };
    });
  const waitForSpawns = async (count: number) => {
    const startedAt = Date.now();
    while (spawns().length < count) {
      if (Date.now() - startedAt > 10_000) throw new Error(`expected ${count} scanner spawns, saw ${spawns().length}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return spawns();
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("leaves a running scan alone and gives the next one the new workers", async () => {
    const root = Path.join(scratch, "root");
    await main.invoke("diskhound:set-power-efficiency", "miser");
    await main.invoke("diskhound:start-scan", root, {});
    const [running] = await waitForSpawns(1);
    expect(running!.workers).toBe(powerEfficiencyWorkers("miser", CPUS));

    await main.invoke("diskhound:set-power-efficiency", "drain-my-battery");
    // Give a restart, if there were one, time to happen.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spawns()).toHaveLength(1);
    expect(alive(running!.pid)).toBe(true);
    expect(await main.invoke("diskhound:get-active-scan-roots")).toEqual([root]);

    // The user's rescan, after the choice.
    await main.invoke("diskhound:start-scan", root, {});
    const [, next] = await waitForSpawns(2);
    expect(next!.workers).toBe(powerEfficiencyWorkers("drain-my-battery", CPUS));
    expect(alive(running!.pid)).toBe(false);

    await main.invoke("diskhound:cancel-scan", root);
    expect(await main.invoke("diskhound:get-active-scan-roots")).toEqual([]);
  });
});
