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

  it("keeps the committed setting when persistence fails", async () => {
    // A file where userData should be makes mkdir/write fail reliably,
    // without depending on the test user's permissions.
    await FSP.rm(paths.userData, { recursive: true, force: true });
    await FSP.writeFile(paths.userData, "not a directory", "utf8");
    const store = await createSettingsStore();
    const before = store.get();
    const listener = vi.fn();
    store.subscribe(listener);

    await expect(store.update((current) => ({
      ...current,
      scanning: { ...current.scanning, powerEfficiency: "miser" },
    }))).rejects.toThrow();

    expect(store.get()).toBe(before);
    expect(store.get().scanning.powerEfficiency).toBe("balanced");
    expect(listener).not.toHaveBeenCalled();
  });

  it("serializes overlapping updates so the last choice wins", async () => {
    const store = await createSettingsStore();
    const realWriteFile = FSP.writeFile;
    let releaseFirstWrite!: () => void;
    const firstWriteCanFinish = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    let writes = 0;
    const writeSpy = vi.spyOn(FSP, "writeFile").mockImplementation(async (...args) => {
      writes += 1;
      if (writes === 1) await firstWriteCanFinish;
      return realWriteFile(...args);
    });

    try {
      const transforms: string[] = [];
      const first = store.update((current) => {
        transforms.push("miser");
        return { ...current, scanning: { ...current.scanning, powerEfficiency: "miser" } };
      });
      // Let the first transform reach its deliberately stalled write.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const second = store.update((current) => {
        transforms.push("aggressive");
        return { ...current, scanning: { ...current.scanning, powerEfficiency: "aggressive" } };
      });

      expect(transforms).toEqual(["miser"]);
      expect(store.get().scanning.powerEfficiency).toBe("balanced");
      releaseFirstWrite();
      await Promise.all([first, second]);

      expect(transforms).toEqual(["miser", "aggressive"]);
      expect(store.get().scanning.powerEfficiency).toBe("aggressive");
      expect(JSON.parse(FS.readFileSync(settingsPath(), "utf8")).scanning.powerEfficiency)
        .toBe("aggressive");
    } finally {
      writeSpy.mockRestore();
    }
  });
});

it("persists size overrides once per choice and removes the key when returning to platform default", async () => {
  const store = await createSettingsStore();
  const { io } = await measureFsIo(async () => {
    await store.update((current) => ({ ...current, general: { ...current.general, sizeUnits: "decimal" } }));
    await store.set(store.get()); // unchanged broadcast is not a rewrite
    await store.update((current) => {
      const general = { ...current.general };
      delete general.sizeUnits;
      return { ...current, general };
    });
  });
  expectIoBudget({
    scenario: "settings-size-units-override-and-reset",
    note: "Two explicit user choices (decimal, then platform default): 2 settings rewrites, one per change; repeated save writes nothing. No polling writes: 0 writes/day and 0 MB/day at both default and 1-minute monitoring intervals.",
    io,
  });
  expect(JSON.parse(FS.readFileSync(settingsPath(), "utf8")).general).not.toHaveProperty("sizeUnits");
  expect((await createSettingsStore()).get().general).not.toHaveProperty("sizeUnits");
});
