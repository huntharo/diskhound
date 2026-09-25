import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectIoBudget, measureFsIo } from "./ioBudget";

vi.mock("node:fs", async (importOriginal) =>
  (await import("./ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("./ioBudget")).instrumentFsPromises(await importOriginal()));

let dir: string;

beforeEach(() => {
  dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-io-harness-"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  FS.rmSync(dir, { recursive: true, force: true });
});

describe("measureFsIo", () => {
  it("counts sync, callback, promise and stream calls under one name", async () => {
    const { io } = await measureFsIo(async () => {
      FS.writeFileSync(Path.join(dir, "a"), "abc");
      await new Promise<void>((resolve, reject) =>
        FS.writeFile(Path.join(dir, "b"), Buffer.alloc(10), (error) => (error ? reject(error) : resolve())));
      await FSP.writeFile(Path.join(dir, "c"), "é", "utf8");
      await FS.promises.appendFile(Path.join(dir, "c"), "x");
      FS.existsSync(Path.join(dir, "a"));
      await FSP.readFile(Path.join(dir, "a"));
      await new Promise<void>((resolve) => {
        const out = FS.createWriteStream(Path.join(dir, "d"));
        out.on("close", resolve);
        out.end(Buffer.alloc(100));
      });
    });

    expect(io).toMatchObject({
      writeFile: 3,
      appendFile: 1,
      createWriteStream: 1,
      existsSync: 1,
      readFile: 1,
      // 3 + 10 + 2 (é is two bytes in UTF-8) + 1 + 100
      bytesWritten: 116,
    });
  });

  it("leaves setup outside the window uncounted", async () => {
    FS.writeFileSync(Path.join(dir, "setup"), "setup");
    const { io } = await measureFsIo(() => FS.readFileSync(Path.join(dir, "setup"), "utf8"));
    expect(io.writeFile).toBe(0);
    expect(io.readFile).toBe(1);
  });

  it("waits for fire-and-forget writes under fake timers", async () => {
    vi.useFakeTimers();
    const persist = async () => {
      await FSP.mkdir(Path.join(dir, "nested"), { recursive: true });
      await FSP.writeFile(Path.join(dir, "nested", "state.json"), "{}");
    };
    const { io } = await measureFsIo(() => {
      setTimeout(() => void persist(), 400);
      vi.advanceTimersByTime(400);
    });
    expect(io).toMatchObject({ mkdir: 1, writeFile: 1, bytesWritten: 2 });
    expect(FS.readFileSync(Path.join(dir, "nested", "state.json"), "utf8")).toBe("{}");
  });
});

describe("expectIoBudget", () => {
  it("throws with the measured counts for an unknown scenario", async () => {
    const { io } = await measureFsIo(() => FS.writeFileSync(Path.join(dir, "x"), "x"));
    // Assert even during a re-record run, which would record it instead.
    vi.stubEnv("UPDATE_IO_BUDGETS", "");
    expect(() => expectIoBudget({ scenario: "no-such-scenario", note: "", io }))
      .toThrow(/No I\/O budget recorded for "no-such-scenario"[\s\S]*1 writeFile/);
  });

  it("fails when a count rises or drops", async () => {
    const one = await measureFsIo(() => FS.writeFileSync(Path.join(dir, "x"), "x"));
    const note = "one known write";
    expectIoBudget({ scenario: "io-budget-harness-one-write", note, io: one.io });
    vi.stubEnv("UPDATE_IO_BUDGETS", "");

    const two = await measureFsIo(() => {
      FS.writeFileSync(Path.join(dir, "x"), "x");
      FS.writeFileSync(Path.join(dir, "y"), "y");
    });
    expect(() => expectIoBudget({ scenario: "io-budget-harness-one-write", note, io: two.io }))
      .toThrow(/changed/);

    const none = await measureFsIo(() => undefined);
    expect(() => expectIoBudget({ scenario: "io-budget-harness-one-write", note, io: none.io }))
      .toThrow(/changed/);
  });
});
