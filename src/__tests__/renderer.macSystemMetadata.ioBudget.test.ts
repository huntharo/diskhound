// @vitest-environment happy-dom
import "node:fs";
import "node:fs/promises";
import { h } from "preact";
import { beforeAll, expect, it, vi } from "vitest";
import { MacSystemMetadataCard } from "../renderer/components/MacSystemMetadataCard";
import { StorageAccountingCard } from "../renderer/components/StorageAccountingCard";
import { createIdleScanSnapshot, type ScanSnapshot, type StorageAccountingReport } from "../shared/contracts";
import { expectIoBudget, measureFsIo } from "../test/ioBudget";
import { bootMainProcess } from "../test/mainProcessHarness";
import { bootRenderer, button, click, type Renderer } from "../test/rendererHarness";

vi.mock("node:fs", async (original) =>
  (await import("../test/ioBudget")).instrumentFs(await original()));
vi.mock("node:fs/promises", async (original) =>
  (await import("../test/ioBudget")).instrumentFsPromises(await original()));
vi.mock("node:child_process", async (original) =>
  (await import("../test/ioBudget")).instrumentChildProcess(await original()));
vi.mock("node:worker_threads", async (original) =>
  (await import("../test/ioBudget")).instrumentWorkerThreads(await original()));
vi.mock("electron", async () => (await import("../test/mainProcessHarness")).fakeElectron());
vi.mock("../shared/crashLog", async (original) =>
  (await import("../test/mainProcessHarness")).settledCrashLog(await original()));

let ui: Renderer;
beforeAll(async () => {
  await bootMainProcess();
  ui = await bootRenderer();
  // Exercise macOS presentation on every CI platform with the real preload methods.
  window.diskhound = { ...window.diskhound, platform: "darwin" };
}, 60_000);

const snapshot = (extra: Partial<ScanSnapshot> = {}): ScanSnapshot => ({
  ...createIdleScanSnapshot(), status: "done", rootPath: "/", finishedAt: Date.now(), ...extra,
});

it("shows partial and unavailable sizes and offers guidance without I/O or IPC", async () => {
  const view = ui.mount(h(MacSystemMetadataCard, { snapshot: snapshot({ macSystemMetadata: [
    { kind: "fsevents", path: "/System/Volumes/Data/.fseventsd", bytes: 20_585_635_840,
      status: "incomplete", issue: "scan-errors" },
    { kind: "spotlight", path: "/System/Volumes/Data/.Spotlight-V100", bytes: null,
      status: "unavailable", issue: "scan-errors" },
  ] }) }));
  await ui.settle();
  expect(view.textContent).toContain("At least");
  expect(view.textContent).toContain("Size unavailable");
  expect(ui.takeIpc()).toEqual([]);
  const { io } = await measureFsIo(async () => {
    await click(button(view, "Guidance"));
    await ui.settle();
    expect(view.textContent).toContain("root-only");
    expect(view.textContent).toContain("Full Disk Access does not bypass root-only");
    expect(view.textContent).toContain("does not disable indexing");
    expect(view.textContent).toContain("Unavailable or incomplete sizes do not mean an empty store");
    await click(button(view, "Hide guidance"));
    await ui.settle();
    ui.mount(h(MacSystemMetadataCard, { snapshot: snapshot() }));
    await ui.settle();
  }, { countProcesses: true });
  expect(ui.takeIpc()).toEqual([]);
  expectIoBudget({
    scenario: "renderer-system-metadata-guidance",
    note: "Expand, collapse and remount scan-backed macOS metadata guidance: 0 reads, writes or subprocesses. Projects 0 writes/day and 0 MB/day at the 60-minute default and 1-minute minimum; no polling or new persisted state.",
    io,
  });
});

it("shows measured Spotlight bytes, keeps old history unknown, and hides on other platforms", async () => {
  const view = ui.mount(h(MacSystemMetadataCard, { snapshot: snapshot({ macSystemMetadata: [
    { kind: "fsevents", path: "/System/Volumes/Data/.fseventsd", bytes: 0, status: "complete" },
    { kind: "spotlight", path: "/System/Volumes/Data/.Spotlight-V100", bytes: 8_597_852_160, status: "complete" },
  ] }) }));
  await ui.settle();
  expect(view.querySelectorAll(".storage-card-value")[1].textContent).toBe("8.6 GB");
  const old = ui.mount(h(MacSystemMetadataCard, { snapshot: snapshot() }));
  await ui.settle();
  expect(old.querySelectorAll(".storage-card-value")[0].textContent).toBe("Size unavailable");
  const oldMount = ui.mount(h(MacSystemMetadataCard, { snapshot: snapshot({ rootPath: "/Users/me/mnt/image" }) }));
  await ui.settle();
  expect(oldMount.textContent).toContain("Volume paths not recorded in this scan");
  expect(oldMount.textContent).not.toContain("Outside this scan");
  expect(oldMount.textContent).not.toContain("/System/Volumes/Data");
  const unresolved = ui.mount(h(MacSystemMetadataCard, { snapshot: snapshot({ macSystemMetadata: [
    { kind: "fsevents", path: "/System/Volumes/Data/.fseventsd", bytes: null,
      status: "unavailable", issue: "volume-unresolved" },
  ] }) }));
  await ui.settle();
  expect(unresolved.textContent).toContain("Could not resolve the volume mount; scan again");
  expect(unresolved.textContent).not.toContain("/System/Volumes/Data");
  window.diskhound = { ...window.diskhound, platform: "linux" };
  const other = ui.mount(h(MacSystemMetadataCard, { snapshot: snapshot() }));
  await ui.settle();
  expect(other.textContent).toBe("");
  window.diskhound = { ...window.diskhound, platform: "darwin" };
});

it("does not turn failed snapshot or purgeable collection into absence or zero", async () => {
  const report: StorageAccountingReport = {
    platform: "darwin", volumePath: "/", supported: true, filesystem: "apfs", checkedAt: Date.now(),
    totalBytes: null, freeBytes: null, availableForImportantUsageBytes: null, purgeableBytes: null,
    container: null, snapshots: [], snapshotStatus: "unavailable", notes: [],
  };
  const bridge = window.diskhound;
  window.diskhound = { ...bridge, getStorageAccounting: async () => report };
  try {
    window.localStorage.clear();
    const view = ui.mount(h(StorageAccountingCard, { snapshot: snapshot() }));
    await ui.settle();
    expect(view.textContent).toContain("Purgeable size unavailable");
    expect(view.textContent).toContain("Snapshot list unavailable or incomplete");
    expect(view.textContent).not.toContain("Nothing purgeable");
    expect(view.textContent).not.toContain("No local snapshots");
    expect(view.textContent).not.toContain("Deleting files frees space right away");
  } finally {
    ui.unmount();
    window.diskhound = bridge;
  }
});
