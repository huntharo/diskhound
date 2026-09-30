import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, it, vi } from "vitest";

import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { AgentSecurityLog, type SecurityEventInput } from "../securityLog";

vi.mock("node:fs", async (original) => (await import("../../test/ioBudget")).instrumentFs(await original()));
vi.mock("node:fs/promises", async (original) => (await import("../../test/ioBudget")).instrumentFsPromises(await original()));

let dir: string;
let file: string;
let clock: number;

const refusal = (detail: string, tool = "diskhound_move_to_trash"): SecurityEventInput => ({
  sessionId: "session_0123456789abcdef",
  sessionName: "Claude Code — ~/github/diskhound",
  roleName: "Cleanup Guide",
  kind: detail.startsWith("Asked") ? "protected_path" : "tool_not_allowed",
  tool,
  detail,
});

beforeEach(async () => {
  dir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-security-io-"));
  file = Path.join(dir, "agent-security.log");
  clock = Date.UTC(2026, 8, 30, 12);
  // A used log: a few hundred lines from earlier runs.
  const old = Array.from({ length: 300 }, (_, i) =>
    JSON.stringify({ ...refusal(`Asked to move /Users/me/Library/Old ${i} to the Trash; agents may never remove it.`), id: `old-${i}`, at: clock - i * 60_000, count: 1 }),
  );
  await FSP.writeFile(file, `${old.join("\n")}\n`);
});

afterEach(() => {
  vi.useRealTimers();
  FS.rmSync(dir, { recursive: true, force: true });
});

const log = () => new AgentSecurityLog({ file, now: () => clock });

function budget(scenario: string, io: Awaited<ReturnType<typeof measureFsIo>>["io"], detail: string) {
  expectIoBudget({
    scenario,
    io,
    note: `${detail} Only an agent's refused request writes, so the monitoring interval doesn't change it: `
      + "the same at the default and at the 1-minute interval. Appends are at least 5 minutes apart after the first "
      + "and capped at 60 lines an hour, so an agent refused nonstop for a day costs at most 288 appends and "
      + "1,440 lines (about 0.5 MB/day); the file rotates at 256 KB.",
  });
}

it("budgets one refused request", async () => {
  const security = log();
  const { io } = await measureFsIo(async () => {
    security.record(refusal("Tried to delete items permanently; Cleanup Guide doesn't allow it.", "diskhound_delete_permanently"));
    await security.flush();
  });
  budget("agent-security-log-one-refusal", io,
    "One refusal: one stat for the file's size, then one append of one line. A few refusals a day is a few appends and under 1 KB/day.");
});

it("budgets one Trash request naming 20 protected folders", async () => {
  const security = log();
  const { io } = await measureFsIo(async () => {
    for (let i = 0; i < 20; i++) {
      security.record(refusal(`Asked to move /System/Library/Folder ${i} to the Trash; agents may never remove it.`));
    }
    await security.flush();
  });
  budget("agent-security-log-burst", io, "20 refusals in one request become one append of 20 lines.");
});

it("budgets an agent refused nonstop for an hour", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const security = log();
  const { io } = await measureFsIo(async () => {
    // Every 10 s, a new blocked call, and the same one repeated twice.
    for (let second = 0; second < 3_600; second += 10) {
      clock += 10_000;
      security.record(refusal(`Asked to move /Users/me/Protected ${second} to the Trash; agents may never remove it.`));
      security.record(refusal("Tried to delete items permanently; Cleanup Guide doesn't allow it.", "diskhound_delete_permanently"));
      security.record(refusal("Tried to delete items permanently; Cleanup Guide doesn't allow it.", "diskhound_delete_permanently"));
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await security.flush();
  });
  budget("agent-security-log-looping-agent", io,
    "360 distinct refusals and 720 repeats in an hour: the 60-line cap fills within minutes, so 60 lines reach disk in 3 appends "
      + "(2 s after the first refusal, 5 minutes later, and at quit). Later refusals stay in memory for Settings.");
});

it("budgets loading the log for Settings once, and later reads from memory", async () => {
  const security = log();
  const { io } = await measureFsIo(async () => {
    for (let i = 0; i < 20; i++) await security.list();
    security.recent();
  });
  budget("agent-security-log-load", io, "Opening Settings → AI Agents reads the log once per run; 20 more opens read nothing. No writes.");
});
