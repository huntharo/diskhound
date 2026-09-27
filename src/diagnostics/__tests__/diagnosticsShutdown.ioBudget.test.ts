import { afterEach, expect, it, vi } from "vitest";

import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { createDiagnosticsShutdown } from "../diagnosticsShutdown";
import { crashLogLike, tempDir } from "./diagnosticsTestKit";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));

afterEach(() => vi.useRealTimers());

it.each(["timeout", "error"])("writes one warning when the shutdown flush hits %s", async (outcome) => {
  const dir = await tempDir();
  try {
    vi.useFakeTimers();
    const crash = crashLogLike(dir.path);
    const resumeQuit = vi.fn();
    const shutdown = createDiagnosticsShutdown({
      stop: () => outcome === "error" ? Promise.reject(new Error("disk unavailable")) : new Promise<void>(() => {}),
      resumeQuit,
      warn: (message) => crash("diagnostics", message),
    });
    const { io } = await measureFsIo(async () => {
      shutdown.beforeQuit({ preventDefault: vi.fn() });
      shutdown.beforeQuit({ preventDefault: vi.fn() });
      await vi.advanceTimersByTimeAsync(10_000);
      crash.flush();
    });
    expect(resumeQuit).toHaveBeenCalledOnce();
    expectIoBudget({
      scenario: `diagnostics-shutdown-${outcome}`,
      note: "one crash.log warning per failed or timed-out shutdown, even with repeated quits. No periodic writes. At default or most aggressive diagnostics settings: <= 1 append and <0.001 MB per quit (<0.001 MB/day at one quit/day)",
      io,
    });
  } finally {
    await dir.cleanup();
  }
});
