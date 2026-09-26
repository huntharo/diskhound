import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetScheduledTaskCacheForTests,
  hasScheduledTask,
  registerScheduledTask,
  unregisterScheduledTask,
} from "../elevation";

type Outcome = { exitCode: number } | { error: true };

const spawned: Array<{ command: string; args: string[] }> = [];
let outcome: Outcome = { exitCode: 0 };

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[]) => {
    spawned.push({ command, args });
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => true,
    });
    const result = outcome;
    setImmediate(() => {
      if ("error" in result) child.emit("error", new Error("spawn schtasks ENOENT"));
      else child.emit("exit", result.exitCode);
    });
    return child;
  },
}));

const schtasksQueries = () => spawned.filter((s) => s.command === "schtasks" && s.args[0] === "/query").length;

describe("hasScheduledTask on Windows", () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
    __resetScheduledTaskCacheForTests();
    spawned.length = 0;
    outcome = { exitCode: 0 };
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform });
  });

  it("asks schtasks once, however often App and Settings ask", async () => {
    for (let i = 0; i < 5; i++) expect(await hasScheduledTask()).toBe(true);
    expect(schtasksQueries()).toBe(1);
  });

  it("remembers that the task is missing too", async () => {
    outcome = { exitCode: 1 };
    expect(await hasScheduledTask()).toBe(false);
    expect(await hasScheduledTask()).toBe(false);
    expect(schtasksQueries()).toBe(1);
  });

  it("asks again after a spawn error, which is not an answer", async () => {
    outcome = { error: true };
    expect(await hasScheduledTask()).toBe(false);
    outcome = { exitCode: 0 };
    expect(await hasScheduledTask()).toBe(true);
    expect(schtasksQueries()).toBe(2);
  });

  it("follows the app's own register and unregister without asking schtasks", async () => {
    expect(await unregisterScheduledTask()).toBe(true);
    expect(await hasScheduledTask()).toBe(false);
    expect(await registerScheduledTask("C:\\Program Files\\DiskHound\\DiskHound.exe")).toBe(true);
    expect(await hasScheduledTask()).toBe(true);
    expect(schtasksQueries()).toBe(0);
  });
});
