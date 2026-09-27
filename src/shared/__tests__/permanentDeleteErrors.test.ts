import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PermanentDeleteProgress } from "../contracts";
import { permanentlyDeleteOnDisk } from "../permanentDelete";

vi.mock("node:fs/promises", () => ({
  lstat: vi.fn(), opendir: vi.fn(), unlink: vi.fn(), rmdir: vi.fn(), chmod: vi.fn(),
}));

const root = Path.resolve("retry-fixture");
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const fsError = (code: string) => Object.assign(new Error(code), { code });
const transient = ["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY"];

function fixture(directory = false, symlink = false) {
  let exists = true;
  const stat = { isDirectory: () => directory, isSymbolicLink: () => symlink };
  vi.mocked(FSP.lstat).mockImplementation(async () => {
    if (!exists) throw fsError("ENOENT");
    return stat as never;
  });
  const read = vi.fn().mockResolvedValue(null);
  const close = vi.fn().mockResolvedValue(undefined);
  vi.mocked(FSP.opendir).mockResolvedValue({ read, close } as never);
  vi.mocked(FSP.unlink).mockImplementation(async () => { exists = false; });
  vi.mocked(FSP.rmdir).mockImplementation(async () => { exists = false; });
  vi.mocked(FSP.chmod).mockResolvedValue(undefined);
  return { operation: directory && !symlink ? FSP.rmdir : FSP.unlink, read, close, disappear: () => { exists = false; } };
}

function start() {
  const progress: PermanentDeleteProgress[] = [];
  // Attach the rejection handler immediately, including before fake timers run.
  const outcome = permanentlyDeleteOnDisk(root, (p) => progress.push(p)).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return { outcome, progress };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, "platform", originalPlatform);
});

describe.each([false, true])("permanent delete retries (directory=%s)", (directory) => {
  it.each(transient)("retries %s after exactly 100 ms and 200 ms", async (code) => {
    const { operation } = fixture(directory);
    vi.mocked(operation).mockRejectedValueOnce(fsError(code)).mockRejectedValueOnce(fsError(code));
    const { outcome, progress } = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(progress.some((p) => p.percent === 100)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toEqual({ ok: true });
    expect(operation).toHaveBeenCalledTimes(3);
    expect(progress.at(-1)).toMatchObject({ percent: 100, itemsDeleted: 1 });
    expect(FSP.chmod).not.toHaveBeenCalled();
  });

  it.each(transient)("stops after three attempts when %s persists", async (code) => {
    const { operation } = fixture(directory);
    const error = fsError(code);
    vi.mocked(operation).mockRejectedValue(error);
    const { outcome, progress } = start();
    await vi.runAllTimersAsync();
    expect(await outcome).toEqual({ ok: false, error });
    expect(operation).toHaveBeenCalledTimes(3);
    expect(progress.some((p) => p.percent === 100)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["EACCES", "EIO"])("does not retry permanent error %s", async (code) => {
    const { operation } = fixture(directory);
    const error = fsError(code);
    vi.mocked(operation).mockRejectedValue(error);
    const { outcome } = start();
    await vi.runAllTimersAsync();
    expect(await outcome).toEqual({ ok: false, error });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(FSP.chmod).not.toHaveBeenCalled();
  });

  it("accepts an entry disappearing during removal", async () => {
    const { operation, disappear } = fixture(directory);
    vi.mocked(operation).mockImplementationOnce(async () => { disappear(); throw fsError("ENOENT"); });
    const { outcome } = start();
    await vi.runAllTimersAsync();
    expect(await outcome).toEqual({ ok: true });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe("platform-specific permissions", () => {
  it.each([false, true])("repairs Windows read-only permissions then retries (directory=%s)", async (directory) => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { operation } = fixture(directory);
    vi.mocked(operation).mockRejectedValueOnce(fsError("EPERM"));
    const { outcome } = start();
    await vi.runAllTimersAsync();
    expect(await outcome).toEqual({ ok: true });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(FSP.chmod).toHaveBeenCalledExactlyOnceWith(root, directory ? 0o777 : 0o666);
  });

  it("limits persistent Windows EPERM to three attempts and two permission repairs", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { operation } = fixture();
    const error = fsError("EPERM");
    vi.mocked(operation).mockRejectedValue(error);
    const { outcome } = start();
    await vi.runAllTimersAsync();
    expect(await outcome).toEqual({ ok: false, error });
    expect(operation).toHaveBeenCalledTimes(3);
    expect(FSP.chmod).toHaveBeenCalledTimes(2);
  });

  it("does not chmod a Windows symlink target after EPERM", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { operation } = fixture(false, true);
    const error = fsError("EPERM");
    vi.mocked(operation).mockRejectedValue(error);
    const { outcome } = start();
    await vi.runAllTimersAsync();
    expect(await outcome).toEqual({ ok: false, error });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(FSP.chmod).not.toHaveBeenCalled();
  });

  it.each(["lstat", "chmod"])("accepts a Windows entry disappearing during repair %s", async (step) => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { operation, disappear } = fixture();
    vi.mocked(operation).mockRejectedValueOnce(fsError("EPERM"));
    if (step === "lstat") {
      const initialStat = vi.mocked(FSP.lstat).getMockImplementation()!;
      vi.mocked(FSP.lstat).mockImplementationOnce(initialStat)
        .mockImplementationOnce(async () => { disappear(); throw fsError("ENOENT"); });
    } else {
      vi.mocked(FSP.chmod).mockImplementationOnce(async () => { disappear(); throw fsError("ENOENT"); });
    }
    const { outcome } = start();
    await vi.runAllTimersAsync();
    expect(await outcome).toEqual({ ok: true });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("returns a failed permission repair without continuing deletion", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { operation } = fixture();
    vi.mocked(operation).mockRejectedValueOnce(fsError("EPERM"));
    const error = fsError("EACCES");
    vi.mocked(FSP.chmod).mockRejectedValueOnce(error);
    const { outcome } = start();
    await vi.runAllTimersAsync();
    expect(await outcome).toEqual({ ok: false, error });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each(["darwin", "linux"])("does not chmod or retry EPERM on %s", async (platform) => {
    Object.defineProperty(process, "platform", { value: platform });
    const { operation } = fixture();
    const error = fsError("EPERM");
    vi.mocked(operation).mockRejectedValue(error);
    const { outcome } = start();
    await vi.runAllTimersAsync();
    expect(await outcome).toEqual({ ok: false, error });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(FSP.chmod).not.toHaveBeenCalled();
  });
});

it("preserves the original enumeration error if closing the handle also fails", async () => {
  const { read, close } = fixture(true);
  const error = fsError("EACCES");
  read.mockRejectedValue(error);
  close.mockRejectedValue(fsError("EIO"));
  const { outcome } = start();
  await vi.runAllTimersAsync();
  expect(await outcome).toEqual({ ok: false, error });
  expect(close).toHaveBeenCalledTimes(1);
  expect(FSP.rmdir).not.toHaveBeenCalled();
});
