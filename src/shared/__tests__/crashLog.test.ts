import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CRASH_LOG_FLUSH_DELAY_MS,
  CRASH_LOG_MAX_BUFFERED_BYTES,
  CRASH_LOG_MAX_BYTES,
  createCrashLog,
  formatRendererError,
  type CrashLogOptions,
} from "../crashLog";

let dir = "";
let logPath = "";

function spyFs() {
  return {
    appendFileSync: vi.fn(FS.appendFileSync),
    mkdirSync: vi.fn(FS.mkdirSync),
    renameSync: vi.fn(FS.renameSync),
    statSync: vi.fn(FS.statSync),
  };
}

function makeLog(overrides: Partial<CrashLogOptions> = {}) {
  const fs = spyFs();
  const log = createCrashLog({ path: () => logPath, fs: fs as unknown as CrashLogOptions["fs"], ...overrides });
  return { log, fs };
}

const lines = () => (FS.existsSync(logPath) ? FS.readFileSync(logPath, "utf8").split("\n").filter(Boolean) : []);

beforeEach(() => {
  dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-crash-log-"));
  logPath = Path.join(dir, "crash.log");
  vi.useFakeTimers({ now: new Date("2026-09-25T12:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
  FS.rmSync(dir, { recursive: true, force: true });
});

describe("createCrashLog", () => {
  it("buffers lines and appends them together after the flush delay", () => {
    const { log, fs } = makeLog();
    log.write("scanner", "one");
    log.write("memory", "two");
    log.write("dup", "three");
    expect(fs.appendFileSync).not.toHaveBeenCalled();

    vi.advanceTimersByTime(CRASH_LOG_FLUSH_DELAY_MS);

    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
    expect(lines()).toEqual([
      "[2026-09-25T12:00:00.000Z] [scanner] one",
      "[2026-09-25T12:00:00.000Z] [memory] two",
      "[2026-09-25T12:00:00.000Z] [dup] three",
    ]);
  });

  it("writes a crash-class line before returning, after what was buffered ahead of it", () => {
    const { log, fs } = makeLog();
    log.write("scanner", "before");
    log.write("main-uncaught", "TypeError: boom");

    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
    expect(lines().map((line) => line.slice(27))).toEqual(["[scanner] before", "[main-uncaught] TypeError: boom"]);
    // The timer the buffered line armed has nothing left to write.
    vi.advanceTimersByTime(CRASH_LOG_FLUSH_DELAY_MS);
    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
  });

  it("buffers a crash-class tag when the caller says this one is routine", () => {
    const { log, fs } = makeLog();
    log.write("main-uncaught", "[ENOENT] gone", { sync: false });
    expect(fs.appendFileSync).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CRASH_LOG_FLUSH_DELAY_MS);
    expect(lines()).toHaveLength(1);
  });

  it("flushes at once when the buffer passes its cap", () => {
    const { log, fs } = makeLog();
    const line = "x".repeat(1_000);
    const perLine = line.length + 40;
    const count = Math.ceil(CRASH_LOG_MAX_BUFFERED_BYTES / perLine);
    for (let i = 0; i < count; i++) log.write("scanner", line);
    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
    expect(lines()).toHaveLength(count);
  });

  it("creates the directory only when an append finds it missing", () => {
    logPath = Path.join(dir, "not-yet", "crash.log");
    const { log, fs } = makeLog();
    log.write("startup", "first");
    log.write("startup", "second");
    expect(fs.mkdirSync).toHaveBeenCalledTimes(1);
    expect(fs.appendFileSync).toHaveBeenCalledTimes(3);
    expect(lines()).toHaveLength(2);
  });

  it("stats the file once, then tracks its size", () => {
    const { log, fs } = makeLog();
    for (let i = 0; i < 5; i++) log.write("startup", `line ${i}`);
    expect(fs.statSync).toHaveBeenCalledTimes(1);
  });

  it("renames the log over crash.log.old once it passes the size cap", () => {
    FS.writeFileSync(logPath, "o".repeat(CRASH_LOG_MAX_BYTES - 10));
    const { log, fs } = makeLog();
    log.write("startup", "pushes it over");

    expect(fs.renameSync).toHaveBeenCalledTimes(1);
    expect(FS.existsSync(logPath)).toBe(false);
    expect(FS.readFileSync(`${logPath}.old`, "utf8")).toMatch(/pushes it over\n$/);

    log.write("startup", "fresh file");
    expect(lines()).toHaveLength(1);
  });

  it("checks the real size before rotating", () => {
    FS.writeFileSync(logPath, "o".repeat(CRASH_LOG_MAX_BYTES - 200));
    const { log, fs } = makeLog();
    log.write("startup", "learns the size");
    // Someone cleared the file behind the tracked size.
    FS.writeFileSync(logPath, "");
    log.write("startup", "x".repeat(200));

    expect(fs.statSync).toHaveBeenCalledTimes(2);
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(lines()).toHaveLength(1);
  });

  it("retries a failed rotation only after another full file", () => {
    FS.writeFileSync(logPath, `${"o".repeat(CRASH_LOG_MAX_BYTES - 10)}\n`);
    const { log, fs } = makeLog();
    fs.renameSync.mockImplementation(() => {
      throw Object.assign(new Error("in use"), { code: "EBUSY" });
    });
    log.write("startup", "pushes it over");
    log.write("startup", "next");
    log.write("startup", "and next");

    expect(fs.renameSync).toHaveBeenCalledTimes(1);
    expect(fs.statSync).toHaveBeenCalledTimes(2);
    expect(lines().slice(-3).map((line) => line.slice(27))).toEqual([
      "[startup] pushes it over",
      "[startup] next",
      "[startup] and next",
    ]);
  });

  it("drops lines it cannot write instead of holding them", () => {
    const { log, fs } = makeLog();
    fs.appendFileSync.mockImplementation(() => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    expect(() => log.write("startup", "lost")).not.toThrow();
    fs.appendFileSync.mockImplementation(FS.appendFileSync);
    log.write("startup", "kept");
    expect(lines().map((line) => line.slice(27))).toEqual(["[startup] kept"]);
  });

  describe("repeats", () => {
    it("counts identical lines and logs the count once per window", () => {
      const { log } = makeLog();
      for (let second = 0; second <= 60; second++) {
        log.write("renderer", "poll failed\n    at refresh");
        vi.advanceTimersByTime(1_000);
      }
      vi.advanceTimersByTime(CRASH_LOG_FLUSH_DELAY_MS);

      expect(lines()).toEqual([
        "[2026-09-25T12:00:00.000Z] [renderer] poll failed",
        "    at refresh",
        "[2026-09-25T12:01:01.000Z] [renderer] repeated 60 more times in the last 1 min: poll failed",
      ]);
    });

    it("doubles the window after each count", () => {
      const { log } = makeLog();
      log.write("renderer", "boom");
      for (let minute = 0; minute < 8; minute++) {
        for (let tick = 0; tick < 6; tick++) {
          vi.advanceTimersByTime(10_000);
          log.write("renderer", "boom");
        }
      }
      vi.advanceTimersByTime(CRASH_LOG_FLUSH_DELAY_MS);
      // Windows of 1, 2 and 4 minutes starting at the first repeat.
      expect(lines().map((line) => line.slice(38))).toEqual([
        "boom",
        "repeated 6 more times in the last 1 min: boom",
        "repeated 12 more times in the last 2 min: boom",
        "repeated 24 more times in the last 4 min: boom",
      ]);
    });

    it("logs the line in full again after an hour of silence", () => {
      const { log } = makeLog();
      log.write("renderer", "boom");
      log.write("renderer", "boom");
      vi.advanceTimersByTime(61 * 60_000);
      log.write("renderer", "boom");
      vi.advanceTimersByTime(CRASH_LOG_FLUSH_DELAY_MS);
      expect(lines().map((line) => line.slice(38))).toEqual([
        "boom",
        "repeated 1 more time in the last 1 min: boom",
        "boom",
      ]);
    });

    it("logs counts not yet due on flushAll", () => {
      const { log } = makeLog();
      log.write("main-rejection", "Error: nope");
      vi.advanceTimersByTime(5_000);
      log.write("main-rejection", "Error: nope");
      vi.advanceTimersByTime(20_000);
      log.write("main-rejection", "Error: nope");
      log.flushAll();
      expect(lines().map((line) => line.slice(27))).toEqual([
        "[main-rejection] Error: nope",
        "[main-rejection] repeated 2 more times in the last 20 s: Error: nope",
      ]);
    });

    it("logs the oldest count when it stops tracking a line", () => {
      const { log } = makeLog();
      log.write("renderer", "first");
      log.write("renderer", "first");
      for (let i = 0; i < 64; i++) log.write("renderer", `other ${i}`);
      // "first" was evicted with its count; seen again, it logs in full.
      log.write("renderer", "first");
      log.flush();

      const text = lines().map((line) => line.slice(38));
      expect(text.filter((line) => line === "first")).toHaveLength(2);
      expect(text).toContain("repeated 1 more time in the last 1 s: first");
      expect(text.indexOf("repeated 1 more time in the last 1 s: first")).toBeLessThan(text.indexOf("other 63"));
    });

    it("writes every line for tags that don't count repeats", () => {
      const { log } = makeLog();
      log.write("memory", "rss=400 MB");
      log.write("memory", "rss=400 MB");
      log.flush();
      expect(lines()).toHaveLength(2);
    });
  });
});

describe("formatRendererError", () => {
  it("keeps the crash.log shape main.ts always wrote", () => {
    expect(formatRendererError({ message: "boom", source: "app.js:1:2", stack: "Error: boom" }))
      .toBe("boom @ app.js:1:2\nError: boom");
    expect(formatRendererError({ message: "boom" })).toBe("boom\n");
  });
});
