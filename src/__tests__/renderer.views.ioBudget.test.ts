// @vitest-environment happy-dom
import "node:fs";
import "node:fs/promises";
import * as Path from "node:path";

import { h } from "preact";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ChangesView } from "../renderer/components/ChangesView";
import { DevView } from "../renderer/components/DevView";
import { DuplicatesView } from "../renderer/components/DuplicatesView";
import { FileList } from "../renderer/components/FileList";
import { FolderList } from "../renderer/components/FolderList";
import { Overview } from "../renderer/components/Overview";
import type { DuplicateAnalysis, ScanSnapshot } from "../shared/contracts";
import { expectIoBudget, measureFsIo } from "../test/ioBudget";
import { bootMainProcess, type MainProcess } from "../test/mainProcessHarness";
import { hostRoot, seedProfile } from "../test/mainProfileFixture";
import {
  bootRenderer,
  button,
  click,
  LAYOUT_HEIGHT,
  LAYOUT_WIDTH,
  mouse,
  one,
  type Renderer,
  type,
  withText,
} from "../test/rendererHarness";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFsPromises(await importOriginal()));
vi.mock("node:child_process", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentChildProcess(await importOriginal()));
vi.mock("node:worker_threads", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentWorkerThreads(await importOriginal()));
vi.mock("electron", async () =>
  (await import("../test/mainProcessHarness")).fakeElectron());

// Sorting, filtering, grouping, hovering and drilling into a view the
// app has already loaded should never touch the disk. Each test mounts
// a real view on the real main process, lets the mount's own IPC
// finish, then budgets a burst of the clicks a user makes.

// Re-rendering 1,000 file rows 21 times takes ~1.6 s here and 5-6 s on
// CI runners, past vitest's 5 s default.
vi.setConfig({ testTimeout: 30_000 });

const ROOT = hostRoot("/Volumes/Data");

let main: MainProcess;
let ui: Renderer;
let snapshot: ScanSnapshot;

beforeAll(async () => {
  main = await bootMainProcess({
    seed: (userData) =>
      seedProfile(userData, { roots: [{ rootPath: ROOT, scans: 3, growth: true }] }).then(() => undefined),
  });
  ui = await bootRenderer();
  snapshot = await main.invoke<ScanSnapshot>("diskhound:get-current-snapshot");
}, 60_000);

describe("Files tab", () => {
  it("sorts and filters the largest files without asking main", async () => {
    const view = ui.mount(h(FileList, { snapshot }));
    await ui.settle();
    // The mount's own IPC goes through the harness: settings and icons.
    expect(ui.takeIpc()).toEqual(expect.arrayContaining(["diskhound:get-settings", "diskhound:get-file-icon"]));
    const firstName = () => view.querySelector(".file-name-text")?.textContent;
    const rows = () => view.querySelectorAll(".file-row").length;
    const bySize = firstName();

    const seen: Record<string, unknown> = {};
    const { io } = await measureFsIo(async () => {
      for (const header of ["Name", "Type", "Age", "Size"]) {
        await click(button(view, header));
        await click(button(view, header));
        if (header === "Name") seen.byNameDescending = firstName();
      }
      const filter = one<HTMLInputElement>(view, "input.filter-input");
      for (const text of ["bundle-1", "bundle-12", "workspace-3", ".js", ""]) {
        await type(filter, text);
        seen[`filter:${text}`] = rows();
      }
      for (const chip of ["Video", "Archives", "Installers", "Images", "Audio", "Docs", "Recently large", "All"]) {
        await click(button(view, chip));
        seen[`chip:${chip}`] = rows();
      }
      await ui.settle();
    }, { countProcesses: true });

    // The clicks and keystrokes changed what the list shows.
    expect(seen.byNameDescending).not.toBe(bySize);
    expect(seen["filter:bundle-12"]).toBeLessThan(seen["filter:bundle-1"] as number);
    expect(seen["chip:Video"]).toBe(0);
    expect(seen["chip:All"]).toBeGreaterThan(0);
    expect(ui.takeIpc()).toEqual([]);
    expectIoBudget({
      scenario: "renderer-files-sort-filter",
      note: "Files tab over 5,000 largest files: 8 header sorts, 5 filter edits and 8 quick filters are local state, 0 IPC and 0 reads",
      io,
    });
  });
});

describe("Folders tab", () => {
  it("reads the folder tree once, then drills in and out from memory", async () => {
    let view!: HTMLElement;
    const mounted = await measureFsIo(async () => {
      view = ui.mount(h(FolderList, { snapshot }));
      await ui.settle();
    }, { countProcesses: true });
    ui.takeIpc();
    expectIoBudget({
      scenario: "renderer-folders-first-mount",
      note: "first Folders mount after startup: main pre-warmed the latest scan's folder tree at boot, so 0 reads",
      io: mounted.io,
    });

    const crumbs = () => [...view.querySelectorAll(".folder-breadcrumbs .folder-crumb")].map((c) => c.textContent?.trim());
    const drill = async (name: string) => {
      const rows = [...view.querySelectorAll(".folder-row.folder-row-clickable")]
        .filter((row) => row.querySelector(".folder-row-name")?.textContent?.trim() === name);
      expect(rows).toHaveLength(1);
      await click(rows[0]!);
      await ui.settle();
    };
    const back = async () => {
      await click(one(view, "button.folder-back-btn"));
      await ui.settle();
    };

    const trail: string[][] = [];
    const { io } = await measureFsIo(async () => {
      for (const area of ["Projects-0", "Projects-1", "Projects-2"]) {
        await drill(area);
        await drill("module-1");
        trail.push(crumbs() as string[]);
        await back();
        await back();
      }
    }, { countProcesses: true });

    expect(trail[0]!.slice(-2)).toEqual(["Projects-0", "module-1"]);
    expect(ui.takeIpc()).toEqual(expect.arrayContaining(["diskhound:get-folder-children"]));
    expectIoBudget({
      scenario: "renderer-folders-drill-in",
      note: "3 rounds of drilling two levels into Folders and back up: 12 get-folder-children calls, all from the tree in memory, 0 reads",
      io,
    });
  });
});

describe("Dev tab", () => {
  it("groups, filters by kind and selects trees without asking main", async () => {
    const view = ui.mount(h(DevView, { snapshot }));
    await ui.settle();
    ui.takeIpc();
    const rows = () => view.querySelectorAll(".dev-row").length;
    expect(rows()).toBeGreaterThan(0);
    const groupBy = one(view, '[aria-labelledby="dev-group-by-label"]');

    const seen: Record<string, number> = {};
    const { io } = await measureFsIo(async () => {
      for (const label of ["By kind", "By project", "All"]) {
        await click(button(groupBy, label));
        seen[label] = view.querySelectorAll(".dev-group-header").length;
      }
      const sortBy = view.querySelector('[aria-labelledby="dev-sort-by-label"]');
      if (sortBy) {
        for (const chip of sortBy.querySelectorAll("button:not([disabled])")) await click(chip);
      }
      for (const cell of view.querySelectorAll(".dev-kind-rail button.dev-kind-cell")) await click(cell);
      await click(one(view, ".dev-kind-rail button.dev-kind-cell-all"));
      for (const check of [...view.querySelectorAll(".dev-row-check input.dev-check")].slice(0, 3)) await click(check);
      seen.selected = view.querySelectorAll(".dev-row-check input.dev-check:checked").length;
      await click(button(view, "Select visible"));
      await click(button(view, "Clear visible"));
      await ui.settle();
    }, { countProcesses: true });

    expect(seen["By project"]).toBeGreaterThan(1);
    expect(seen.All).toBe(0);
    expect(seen.selected).toBe(3);
    expect(ui.takeIpc()).toEqual([]);
    expectIoBudget({
      scenario: "renderer-dev-group-filter-select",
      note: "Dev tab over 20 node_modules trees: 3 groupings, the sort chips, every kind filter and 5 selection changes are local state, 0 IPC and 0 reads",
      io,
    });
  });
});

function duplicateAnalysis(groups: number): DuplicateAnalysis {
  const analysis: DuplicateAnalysis = {
    groups: Array.from({ length: groups }, (_, g) => ({
      hash: `hash-${g}`,
      size: 50_000_000 + g * 1_000_003,
      files: Array.from({ length: 2 + (g % 4) }, (_, copy) => {
        const parentPath = Path.join(ROOT, `Projects-${copy}`, `module-${1 + (g % 8)}`);
        const name = `clip-${g}.mov`;
        return { path: Path.join(parentPath, name), name, parentPath, modifiedAt: 1_758_000_000_000 + copy * 60_000 };
      }),
    })),
    totalWastedBytes: 0,
    totalGroups: groups,
    totalDuplicateFiles: 0,
    rootPath: ROOT,
    filesWalked: 5_000,
    filesHashed: 500,
    elapsedMs: 4_000,
    analyzedAt: 1_758_800_000_000,
  };
  for (const group of analysis.groups) {
    analysis.totalWastedBytes += group.size * (group.files.length - 1);
    analysis.totalDuplicateFiles += group.files.length;
  }
  return analysis;
}

describe("Duplicates tab", () => {
  it("sorts, expands and selects duplicate groups without asking main", async () => {
    const view = ui.mount(h(DuplicatesView, {
      snapshot,
      analysis: duplicateAnalysis(40),
      progress: null,
      isScanning: false,
      onClearAnalysis: () => undefined,
    }));
    await ui.settle();
    ui.takeIpc();
    const firstGroup = () => view.querySelector(".duplicate-group-name")?.textContent;

    const seen: Record<string, unknown> = {};
    const { io } = await measureFsIo(async () => {
      for (const mode of ["By copies", "By file size", "By wasted space"]) {
        await click(button(one(view, ".duplicates-sort-bar"), mode));
        seen[mode] = firstGroup();
      }
      const headers = [...view.querySelectorAll(".duplicate-group-header")].slice(0, 5);
      for (const header of headers) await click(header);
      seen.expanded = view.querySelectorAll(".duplicate-group.expanded").length;
      for (const check of [...view.querySelectorAll(".duplicate-group-checkbox input")].slice(0, 5)) await click(check);
      await click(button(view, "Select all, keep newest"));
      await click(button(view, "Select all, keep oldest"));
      for (const header of headers) await click(header);
      await ui.settle();
    }, { countProcesses: true });

    expect(seen["By copies"]).not.toBe(seen["By file size"]);
    expect(seen.expanded).toBe(5);
    expect(ui.takeIpc()).toEqual([]);
    expectIoBudget({
      scenario: "renderer-duplicates-sort-expand-select",
      note: "Duplicates tab over 40 groups: 3 sorts, expanding and collapsing 5 groups, and 7 selection changes are local state, 0 IPC and 0 reads",
      io,
    });
  });
});

describe("Changes tab", () => {
  it("revisits diff modes, ranges, baselines and tabs from memory", async () => {
    let view!: HTMLElement;
    const mount = async () => {
      view = ui.mount(h(ChangesView, { rootPath: ROOT, snapshot, drives: [] }));
      await ui.settle();
    };
    // What a user flicks through. Every click picks a scan pair, and
    // which pair depends on what was picked before, so "again" means
    // the same clicks from a fresh mount.
    const browse = async () => {
      const mode = one(view, ".changes-diff-mode");
      for (const label of ["vs next", "vs current"]) {
        await click(button(mode, label));
        await ui.settle();
      }
      for (const pill of view.querySelectorAll<HTMLButtonElement>(".changes-quickselect button.changes-range-pill:not([disabled])")) {
        await click(pill);
        await ui.settle();
      }
      for (let i = 0; i < view.querySelectorAll("button.changes-history-item").length; i++) {
        await click(view.querySelectorAll("button.changes-history-item")[i]!);
        await ui.settle();
      }
      for (const tab of ["Directories", "Files"]) {
        await click(withText(view, ".changes-detail-tabs button.changes-tab", tab));
        await ui.settle();
      }
      const filter = view.querySelector<HTMLInputElement>(".changes-full-diff-controls input.filter-input");
      if (filter) {
        for (const text of ["asset", "report-", ""]) await type(filter, text);
      }
    };
    const first = await measureFsIo(async () => {
      await mount();
      await browse();
    }, { countProcesses: true });
    expect(view.querySelectorAll(".changes-row").length).toBeGreaterThan(0);
    expect(view.querySelector(".changes-full-diff-controls input.filter-input")).not.toBeNull();
    ui.takeIpc();
    expectIoBudget({
      scenario: "renderer-changes-browse-first",
      note: "first Changes visit over 3 scans: mount, both diff modes, every range pill and baseline, both tabs and the full-diff filter; the full diffs stream both indexes of each new pair (a worker in the app; it fails under vitest, which has no bundled worker, and main falls back in-process) and write the diff cache",
      io: first.io,
    });

    const again = await measureFsIo(async () => {
      await mount();
      await browse();
    }, { countProcesses: true });
    const ipc = ui.takeIpc();
    expect(ipc).toEqual(expect.arrayContaining(["diskhound:compute-scan-diff", "diskhound:compute-full-scan-diff"]));
    expectIoBudget({
      scenario: "renderer-changes-browse-again",
      note: `the same Changes visit again: ${ipc.length} IPC calls, all answered from main's snapshot, diff and full-diff caches, 0 reads`,
      io: again.io,
    });
  });
});

describe("Overview tab", () => {
  it("switches treemap layouts and filters, and hovers the treemap, without asking main", async () => {
    const view = ui.mount(h(Overview, { snapshot, onFilterExtension: () => undefined, drives: [] }));
    await ui.settle();
    // Expanding the dominant files mounts cards with larger icons. Warm them.
    const featured = view.querySelector(".treemap-featured-header");
    if (featured) {
      await click(featured);
      await ui.settle();
      await click(featured);
    }
    ui.takeIpc();

    const canvas = () => one(view, ".treemap-container canvas");
    let tooltips = 0;
    const hover = async () => {
      for (let x = 20; x < LAYOUT_WIDTH; x += 97) {
        for (let y = 15; y < LAYOUT_HEIGHT; y += 83) {
          await mouse(canvas(), "mousemove", x, y);
          if (view.querySelector(".treemap-tooltip")) tooltips++;
        }
      }
      await mouse(canvas(), "click", 200, 200);
      await mouse(canvas(), "mouseleave");
    };

    const { io } = await measureFsIo(async () => {
      const layout = one(view, ".treemap-mode-switch");
      await hover();
      await click(button(layout, "Tree"));
      await hover();
      await click(withText(view, "button.treemap-folders-toggle", "Folders"));
      await click(withText(view, "button.treemap-folders-toggle", "Folders"));
      await click(button(layout, "Size"));
      await click(withText(view, "button.treemap-folders-toggle", "Recent"));
      for (const window of ["7d", "30d", "90d"]) await click(button(one(view, ".treemap-recent-window"), window));
      await click(withText(view, "button.treemap-folders-toggle", "Recent"));
      const mode = view.querySelector('[aria-label="Treemap mode"]');
      if (mode) {
        await click(button(mode, "All"));
        await click(button(mode, "Condensed"));
      }
      const chips = one(view, '[aria-label="Filter overview by type"]');
      for (const chip of ["Video", "Archives", "Images", "Docs", "All"]) await click(button(chips, chip));
      if (featured) {
        await click(featured);
        await click(featured);
      }
      await click(one(view, 'button[aria-label="Hide extensions"]'));
      await click(one(view, 'button[aria-label="Show extensions"]'));
      await ui.settle();
    }, { countProcesses: true });

    expect(tooltips).toBeGreaterThan(0);
    expect(ui.takeIpc()).toEqual([]);
    expectIoBudget({
      scenario: "renderer-overview-treemap-toolbar-hover",
      note: "Overview over 5,000 files: 216 treemap hovers and clicks in both layouts, layout, folder, recent, mode and type switches, and the sidebar toggle are local state, 0 IPC and 0 reads",
      io,
    });
  });
});
