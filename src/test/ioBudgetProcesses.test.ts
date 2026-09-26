import * as ChildProcess from "node:child_process";
// The fs mocks below only run once something imports these.
import "node:fs";
import "node:fs/promises";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it, vi } from "vitest";

import { expectIoBudget, measureFsIo } from "./ioBudget";

vi.mock("node:fs", async (importOriginal) =>
  (await import("./ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("./ioBudget")).instrumentFsPromises(await importOriginal()));
vi.mock("node:child_process", async (importOriginal) =>
  (await import("./ioBudget")).instrumentChildProcess(await importOriginal()));
vi.mock("node:worker_threads", async (importOriginal) =>
  (await import("./ioBudget")).instrumentWorkerThreads(await importOriginal()));

const node = process.execPath;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("measureFsIo({ countProcesses: true })", () => {
  it("counts every way of starting a process, and workers", async () => {
    const execFileAsync = promisify(ChildProcess.execFile);
    const { io } = await measureFsIo(async () => {
      await new Promise<void>((resolve) => ChildProcess.spawn(node, ["-e", "0"]).once("exit", () => resolve()));
      await new Promise<void>((resolve) => ChildProcess.execFile(node, ["-e", "0"], () => resolve()));
      // The custom promisified form still resolves { stdout, stderr }.
      const { stdout } = await execFileAsync(node, ["-e", "process.stdout.write('ok')"]);
      expect(stdout).toBe("ok");
      ChildProcess.execFileSync(node, ["-e", "0"]);
      await new Promise<void>((resolve) => new Worker("void 0", { eval: true }).once("exit", () => resolve()));
    }, { countProcesses: true });

    expect(io).toMatchObject({ spawn: 4, worker: 1 });
  });

  it("waits for a fire-and-forget child to exit before closing the window", async () => {
    let exited = false;
    const { io } = await measureFsIo(() => {
      ChildProcess.spawn(node, ["-e", "setTimeout(() => {}, 200)"]).once("exit", () => { exited = true; });
    }, { countProcesses: true });

    expect(io.spawn).toBe(1);
    expect(exited).toBe(true);
  });

  it("leaves process counts out unless asked", async () => {
    const { io } = await measureFsIo(() => ChildProcess.execFileSync(node, ["-e", "0"]));
    expect(io.spawn).toBeUndefined();
    expect(io.worker).toBeUndefined();
  });

  it("fails a budget that counts processes against a measurement that does not", async () => {
    const note = "nothing, with processes counted";
    const counted = await measureFsIo(() => undefined, { countProcesses: true });
    expectIoBudget({ scenario: "io-budget-harness-no-processes", note, io: counted.io });
    vi.stubEnv("UPDATE_IO_BUDGETS", "");

    const uncounted = await measureFsIo(() => undefined);
    expect(() => expectIoBudget({ scenario: "io-budget-harness-no-processes", note, io: uncounted.io }))
      .toThrow(/changed/);
  });
});
