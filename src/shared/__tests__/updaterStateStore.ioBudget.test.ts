import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { createUpdaterStateStore } from "../updaterStateStore";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));

let dataDir: string;

beforeEach(async () => {
  dataDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-updater-io-"));
});

afterEach(async () => {
  await FSP.rm(dataDir, { recursive: true, force: true });
});

describe("updater state store", () => {
  it("writes updater-state.json once per update check", async () => {
    const filePath = Path.join(dataDir, "updater-state.json");
    const store = createUpdaterStateStore(filePath);

    // main.ts's recordCheck, on update-available, update-not-available or error.
    const { io } = await measureFsIo(() => store.update({ lastCheckedAt: 1_758_800_000_000 }));

    expectIoBudget({
      scenario: "updater-check",
      note: "one update check: 1 sync rewrite of the ~90-byte updater-state.json; 6/day on stable (4 h), 48/day on beta (30 min)",
      io,
    });
    expect(createUpdaterStateStore(filePath).get().lastCheckedAt).toBe(1_758_800_000_000);
  });

  it("does not rewrite updater-state.json when a launch has no install to clear", async () => {
    const filePath = Path.join(dataDir, "updater-state.json");
    const store = createUpdaterStateStore(filePath);
    store.update({ lastCheckedAt: 1_758_800_000_000 });

    // main.ts's clearPendingInstall, with nothing pending.
    const { io } = await measureFsIo(() =>
      store.update({ pendingInstallVersion: null, pendingInstallStartedAt: null }));

    expectIoBudget({
      scenario: "updater-clear-nothing-pending",
      note: "clearing a pending install that is already clear: 0 writes",
      io,
    });
    expect(FS.readFileSync(filePath, "utf8")).toContain("1758800000000");
  });
});
