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
  it("writes updater-state.json once per changed timestamp patch", async () => {
    const filePath = Path.join(dataDir, "updater-state.json");
    const store = createUpdaterStateStore(filePath);

    // The complete scheduler operation is budgeted in updateScheduler.ioBudget.test.ts.
    const { io } = await measureFsIo(() => store.update({ lastCheckedAt: 1_758_800_000_000 }));

    expectIoBudget({
      scenario: "updater-check",
      note: "one changed timestamp patch: 1 small JSON rewrite; complete checks use 2 patches, budgeted separately (stable: 12 writes/day <0.01 MB/day; beta: 96 writes/day <0.05 MB/day)",
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
