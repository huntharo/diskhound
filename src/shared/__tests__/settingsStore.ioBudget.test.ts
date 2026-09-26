import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { createSettingsStore } from "../settingsStore";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));

const paths = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: () => paths.userData } }));

beforeEach(async () => {
  paths.userData = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-settings-io-"));
});

afterEach(async () => {
  await FSP.rm(paths.userData, { recursive: true, force: true });
});

const settingsPath = () => Path.join(paths.userData, "settings.json");

describe("settings store", () => {
  it("persists the fast delete opt-in once and retains it after restart", async () => {
    const store = await createSettingsStore();
    const { io } = await measureFsIo(async () => {
      await store.update((current) => ({
        ...current, cleanup: { ...current.cleanup, fastPermanentDelete: true },
      }));
      await store.set(store.get());
    });
    expectIoBudget({
      scenario: "settings-fast-delete-opt-in",
      note: "One user opt-in plus one unchanged save: one settings rewrite. No recurring writes; 0 writes/day and 0 MB/day at default or 1-minute monitoring. One manual toggle writes about 1.2 KB.",
      io,
    });
    const reopened = await createSettingsStore();
    expect(reopened.get().cleanup.fastPermanentDelete).toBe(true);
  });

  it("writes settings.json once when a setting changes", async () => {
    const store = await createSettingsStore();
    const current = store.get();

    const { io } = await measureFsIo(() =>
      store.set({ ...current, general: { ...current.general, theme: "light" } }));

    expectIoBudget({
      scenario: "settings-set-changed",
      note: "one settings change: 1 pretty-printed rewrite of settings.json (~1 KB), per user action",
      io,
    });
    expect(JSON.parse(FS.readFileSync(settingsPath(), "utf8")).general.theme).toBe("light");
  });

  it("leaves settings.json untouched when set() and update() change nothing", async () => {
    const seeded = await createSettingsStore();
    await seeded.set(seeded.get());
    const before = FS.readFileSync(settingsPath(), "utf8");
    // A fresh store, as after a restart: it has only read the file.
    const store = await createSettingsStore();
    const listener = vi.fn();
    store.subscribe(listener);

    const { io } = await measureFsIo(async () => {
      await store.set(store.get());
      await store.set(structuredClone(store.get()));
      await store.update((current) => ({ ...current }));
    });

    expectIoBudget({
      scenario: "settings-set-unchanged",
      note: "three no-op saves (set of the same object, of a deep copy, and an identity update): 0 writes; was 3 rewrites",
      io,
    });
    expect(FS.readFileSync(settingsPath(), "utf8")).toBe(before);
    // Subscribers still hear every save, as before.
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
