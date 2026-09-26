import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  atomicWritesSettled,
  hasPendingAtomicWrite,
  writeFileAtomic,
  writeFileAtomicSync,
} from "../atomicWrite";

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const out = { ...real, writeFileSync: vi.fn(real.writeFileSync), renameSync: vi.fn(real.renameSync) };
  return { ...out, default: out };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const out = { ...real, writeFile: vi.fn(real.writeFile), rename: vi.fn(real.rename) };
  return { ...out, default: out };
});

const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const realSync = await vi.importActual<typeof import("node:fs")>("node:fs");
const realPlatform = process.platform;

let dir: string;
let target: string;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

/** A promise the test resolves by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

beforeEach(async () => {
  dir = await real.mkdtemp(Path.join(OS.tmpdir(), "diskhound-atomic-"));
  target = Path.join(dir, "state.json");
  await real.writeFile(target, "old");
});

afterEach(async () => {
  onPlatform(realPlatform);
  vi.mocked(FSP.writeFile).mockImplementation(real.writeFile);
  vi.mocked(FSP.rename).mockImplementation(real.rename);
  vi.mocked(FS.writeFileSync).mockImplementation(realSync.writeFileSync);
  vi.mocked(FS.renameSync).mockImplementation(realSync.renameSync);
  vi.clearAllMocks();
  await real.rm(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("replaces the file through a flushed temp file and leaves nothing else behind", async () => {
    await writeFileAtomic(target, "new");

    expect(await real.readFile(target, "utf8")).toBe("new");
    expect(await real.readdir(dir)).toEqual(["state.json"]);
    expect(FSP.writeFile).toHaveBeenCalledWith(`${target}.tmp`, "new", { encoding: "utf8", flush: true });
  });

  it("creates the parent directory", async () => {
    const nested = Path.join(dir, "a", "b", "state.json");

    await writeFileAtomic(nested, "new");

    expect(await real.readFile(nested, "utf8")).toBe("new");
  });

  it("keeps the old file when the write dies partway", async () => {
    vi.mocked(FSP.writeFile).mockImplementationOnce(async (path) => {
      await real.writeFile(path as string, "ne");
      throw errno("ENOSPC");
    });

    await expect(writeFileAtomic(target, "new")).rejects.toThrow("ENOSPC");

    expect(await real.readFile(target, "utf8")).toBe("old");
    expect(await real.readdir(dir)).toEqual(["state.json"]);
  });

  it("runs saves to one file one at a time and writes only the newest of those waiting", async () => {
    let running = 0;
    let mostRunning = 0;
    const firstWrite = gate();
    vi.mocked(FSP.writeFile).mockImplementation(async (...args) => {
      running += 1;
      mostRunning = Math.max(mostRunning, running);
      if (vi.mocked(FSP.writeFile).mock.calls.length === 1) await firstWrite.promise;
      try {
        return await real.writeFile(...args);
      } finally {
        running -= 1;
      }
    });

    const saves = ["1", "2", "3", "4"].map((text) => writeFileAtomic(target, text));
    expect(hasPendingAtomicWrite(target)).toBe(true);
    firstWrite.open();
    await Promise.all(saves);

    expect(mostRunning).toBe(1);
    // "1" was running; "2" and "3" were replaced by "4" while they waited.
    expect(vi.mocked(FSP.writeFile).mock.calls.map((call) => call[1])).toEqual(["1", "4"]);
    expect(await real.readFile(target, "utf8")).toBe("4");
    expect(hasPendingAtomicWrite(target)).toBe(false);
  });

  it("does not hold one file's save behind another's", async () => {
    const other = Path.join(dir, "other.json");
    const slowWrite = gate();
    // By path: each save runs its mkdir first, so either may write first.
    vi.mocked(FSP.writeFile).mockImplementation(async (...args) => {
      if (args[0] === `${target}.tmp`) await slowWrite.promise;
      return real.writeFile(...args);
    });

    const slow = writeFileAtomic(target, "slow");
    await writeFileAtomic(other, "fast");
    slowWrite.open();
    await slow;

    expect(await real.readFile(other, "utf8")).toBe("fast");
    expect(await real.readFile(target, "utf8")).toBe("slow");
  });

  it("runs the waiting save after the running one fails", async () => {
    const firstWrite = gate();
    vi.mocked(FSP.writeFile).mockImplementationOnce(async () => {
      await firstWrite.promise;
      throw errno("EIO");
    });

    const failed = writeFileAtomic(target, "1");
    const waiting = writeFileAtomic(target, "2");
    firstWrite.open();

    await expect(failed).rejects.toThrow("EIO");
    await waiting;
    expect(await real.readFile(target, "utf8")).toBe("2");
  });

  it("settles once the running and waiting saves have landed", async () => {
    const firstWrite = gate();
    vi.mocked(FSP.writeFile).mockImplementationOnce(async (...args) => {
      await firstWrite.promise;
      return real.writeFile(...args);
    });
    void writeFileAtomic(target, "1");
    void writeFileAtomic(target, "2");

    let settled = false;
    const done = atomicWritesSettled(target).then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    firstWrite.open();
    await done;

    expect(await real.readFile(target, "utf8")).toBe("2");
  });

  it("retries a rename Windows refuses while the file is held open", async () => {
    onPlatform("win32");
    vi.mocked(FSP.rename)
      .mockRejectedValueOnce(errno("EPERM"))
      .mockRejectedValueOnce(errno("EBUSY"));

    await writeFileAtomic(target, "new");

    expect(FSP.rename).toHaveBeenCalledTimes(3);
    expect(await real.readFile(target, "utf8")).toBe("new");
    expect(await real.readdir(dir)).toEqual(["state.json"]);
  });

  it("writes in place when Windows keeps the file held open past the retries", async () => {
    onPlatform("win32");
    vi.mocked(FSP.rename).mockRejectedValue(errno("EACCES"));

    await writeFileAtomic(target, "new");

    expect(FSP.rename).toHaveBeenCalledTimes(8);
    expect(FSP.writeFile).toHaveBeenLastCalledWith(target, "new", { encoding: "utf8", flush: true });
    expect(await real.readFile(target, "utf8")).toBe("new");
    expect(await real.readdir(dir)).toEqual(["state.json"]);
  });

  it("does not retry or write in place off Windows, where EPERM is a real permission error", async () => {
    onPlatform("linux");
    vi.mocked(FSP.rename).mockRejectedValueOnce(errno("EPERM"));

    await expect(writeFileAtomic(target, "new")).rejects.toThrow("EPERM");

    expect(FSP.rename).toHaveBeenCalledTimes(1);
    expect(await real.readFile(target, "utf8")).toBe("old");
    expect(await real.readdir(dir)).toEqual(["state.json"]);
  });
});

describe("writeFileAtomicSync", () => {
  it("replaces the file through its own flushed temp file", () => {
    writeFileAtomicSync(target, "new");

    expect(realSync.readFileSync(target, "utf8")).toBe("new");
    expect(realSync.readdirSync(dir)).toEqual(["state.json"]);
    expect(FS.writeFileSync).toHaveBeenCalledWith(`${target}.sync.tmp`, "new", { encoding: "utf8", flush: true });
  });

  it("keeps the old file when the write dies partway", () => {
    vi.mocked(FS.writeFileSync).mockImplementationOnce((path) => {
      realSync.writeFileSync(path as string, "ne");
      throw errno("ENOSPC");
    });

    expect(() => writeFileAtomicSync(target, "new")).toThrow("ENOSPC");

    expect(realSync.readFileSync(target, "utf8")).toBe("old");
    expect(realSync.readdirSync(dir)).toEqual(["state.json"]);
  });

  it("supersedes the async saves queued for the same file", async () => {
    const firstWrite = gate();
    vi.mocked(FSP.writeFile).mockImplementationOnce(async (...args) => {
      await firstWrite.promise;
      return real.writeFile(...args);
    });
    const running = writeFileAtomic(target, "running");
    const waiting = writeFileAtomic(target, "waiting");

    // At quit: the newest state, written before the event loop turns again.
    writeFileAtomicSync(target, "quit");
    await waiting;
    firstWrite.open();
    await running;

    expect(await real.readFile(target, "utf8")).toBe("quit");
    // The running save dropped its rename, and the waiting one never started.
    expect(FSP.rename).not.toHaveBeenCalled();
    expect(FSP.writeFile).toHaveBeenCalledTimes(1);
    expect(await real.readdir(dir)).toEqual(["state.json"]);
  });

  it("leaves the queue running when it fails", async () => {
    const firstWrite = gate();
    vi.mocked(FSP.writeFile).mockImplementationOnce(async (...args) => {
      await firstWrite.promise;
      return real.writeFile(...args);
    });
    const running = writeFileAtomic(target, "running");
    vi.mocked(FS.writeFileSync).mockImplementationOnce(() => { throw errno("ENOSPC"); });

    expect(() => writeFileAtomicSync(target, "quit")).toThrow("ENOSPC");
    firstWrite.open();
    await running;

    expect(await real.readFile(target, "utf8")).toBe("running");
  });

  it("retries on Windows, then writes in place", () => {
    onPlatform("win32");
    vi.mocked(FS.renameSync).mockImplementation(() => { throw errno("EBUSY"); });

    writeFileAtomicSync(target, "new");

    expect(FS.renameSync).toHaveBeenCalledTimes(5);
    expect(realSync.readFileSync(target, "utf8")).toBe("new");
    expect(realSync.readdirSync(dir)).toEqual(["state.json"]);
  });
});
