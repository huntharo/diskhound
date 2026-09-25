import { EventEmitter } from "node:events";
import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { createWindowStateStore } from "../windowStateStore";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));

const paths = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => paths.userData },
  screen: {
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 2560, height: 1440 } }],
  },
}));

/** The BrowserWindow surface windowStateStore reads. */
class FakeWindow extends EventEmitter {
  bounds = { x: 100, y: 80, width: 1560, height: 980 };
  maximized = false;
  isDestroyed() { return false; }
  isMaximized() { return this.maximized; }
  isFullScreen() { return false; }
  isMinimized() { return false; }
  getBounds() { return { ...this.bounds }; }
  asBrowserWindow() { return this as unknown as BrowserWindow; }
}

// The two stores main.ts creates at startup.
const mainStore = () => createWindowStateStore({
  defaults: { width: 1560, height: 980 },
  minWidth: 960,
  minHeight: 640,
});
const widgetStore = () => createWindowStateStore({
  defaults: { width: 390, height: 650 },
  minWidth: 330,
  minHeight: 500,
  fileName: "widget-window-state.json",
});

/** A user dragging the window for ~1.6 s at 60 fps. */
function drag(window: FakeWindow, events: number): void {
  for (let i = 0; i < events; i++) {
    window.bounds = { ...window.bounds, x: window.bounds.x + 3, y: window.bounds.y + 1 };
    window.emit(i % 2 === 0 ? "move" : "resize");
    vi.advanceTimersByTime(16);
  }
}

beforeEach(async () => {
  paths.userData = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-window-io-"));
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await FSP.rm(paths.userData, { recursive: true, force: true });
});

describe("window state store", () => {
  it("writes once for a whole drag", async () => {
    const store = await mainStore();
    const window = new FakeWindow();
    store.track(window.asBrowserWindow());

    const { io } = await measureFsIo(() => {
      drag(window, 100);
      vi.advanceTimersByTime(400);
    });

    expectIoBudget({
      scenario: "window-state-drag",
      note: "100 move/resize events 16 ms apart, then the 400 ms debounce: 1 write of window-state.json",
      io,
    });
    const saved = JSON.parse(FS.readFileSync(Path.join(paths.userData, "window-state.json"), "utf8"));
    expect(saved.bounds).toEqual(window.bounds);
  });

  it("writes nothing on quit when neither window changed", async () => {
    // The main window was restored from disk; the widget was never opened.
    const seed = await mainStore();
    const seedWindow = new FakeWindow();
    seed.track(seedWindow.asBrowserWindow());
    drag(seedWindow, 1);
    await seed.flush();

    const main = await mainStore();
    const widget = await widgetStore();
    main.track(new FakeWindow().asBrowserWindow());

    const { io } = await measureFsIo(async () => {
      await main.flush();
      await widget.flush();
    });

    expectIoBudget({
      scenario: "window-state-quit-unchanged",
      note: "before-quit flush of both stores after a session with no move, resize, maximize or fullscreen: 0 writes; was 2 per quit, one for a widget that was never opened",
      io,
    });
    expect(FS.existsSync(Path.join(paths.userData, "widget-window-state.json"))).toBe(false);
  });

  it("does not write again on quit after the debounce saved a drag", async () => {
    const store = await mainStore();
    const window = new FakeWindow();
    store.track(window.asBrowserWindow());

    const { io } = await measureFsIo(async () => {
      drag(window, 100);
      vi.advanceTimersByTime(400);
      await Promise.resolve();
      await store.flush();
    });

    expectIoBudget({
      scenario: "window-state-drag-then-quit",
      note: "a drag, its debounced save, then the before-quit flush: 1 write in total; was 2",
      io,
    });
  });

  it("does not rewrite the saved state when a maximized window is restored", async () => {
    const seed = await mainStore();
    const seedWindow = new FakeWindow();
    seed.track(seedWindow.asBrowserWindow());
    seedWindow.maximized = true;
    seedWindow.emit("maximize");
    await seed.flush();

    const store = await mainStore();
    expect(store.shouldRestoreMaximized()).toBe(true);
    const window = new FakeWindow();
    store.track(window.asBrowserWindow());

    const { io } = await measureFsIo(async () => {
      // main.ts calls maximize() and Electron reports it after track().
      window.maximized = true;
      window.emit("maximize");
      window.emit("resize");
      vi.advanceTimersByTime(400);
      await Promise.resolve();
      await store.flush();
    });

    expectIoBudget({
      scenario: "window-state-restore-maximized",
      note: "a launch that restores a maximized window and quits: 0 writes, the saved state already says maximized; was 2 per launch",
      io,
    });
  });
});
