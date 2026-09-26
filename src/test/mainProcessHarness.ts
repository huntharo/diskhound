import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import * as OS from "node:os";
import * as Path from "node:path";

import { vi } from "vitest";

import { onSettle } from "./ioBudget";

/**
 * Boots the real `src/main.ts` against a fake `electron`, so a test
 * can call its IPC handlers the way the renderer does and budget the
 * disk I/O behind them.
 *
 * main.ts registers its handlers inside a startup IIFE that runs on
 * import, next to the stores, the disk monitor and the window. Rather
 * than move each handler out to test it, this runs that startup for
 * real against a temp userData, and the handlers under test are the
 * ones the app ships.
 *
 * ## Wiring a test file
 *
 * Put these next to the fs mocks from `ioBudget.ts` (paths relative to
 * the test file), then call `bootMainProcess()` once per file. main.ts
 * keeps its caches in module state, so one boot serves every test in
 * the file; put scenarios that need a cold process in their own file.
 *
 *     vi.mock("electron", async () =>
 *       (await import("../../test/mainProcessHarness")).fakeElectron());
 *     vi.mock("../../shared/crashLog", async (importOriginal) =>
 *       (await import("../../test/mainProcessHarness")).settledCrashLog(await importOriginal()));
 *
 * ## What is faked
 *
 * - `app.getPath()` points into a temp dir: `userData` is the profile,
 *   the other names are siblings of it. `app.whenReady()` resolves at
 *   once and `requestSingleInstanceLock()` is granted.
 * - `ipcMain.handle` and `ipcMain.on` registrations are captured.
 *   `invoke()` and `send()` call them the way the renderer would.
 * - BrowserWindow, Tray, Menu, Notification, dialog, shell, screen,
 *   nativeImage and powerMonitor are inert stand-ins. What main sends
 *   to a window's webContents is kept in `sent`.
 * - `ipcRenderer` and `contextBridge`, for the preload that
 *   `rendererHarness.ts` loads: its IPC calls main's handlers in this
 *   process, and main's sends reach its listeners.
 * - `VITE_DEV_SERVER_URL` is set, so startup skips electron-updater,
 *   and `HOME` points into the temp dir, so the Linux desktop
 *   integration writes there instead of into the real home.
 *
 * Real: every DiskHound module, fs, child processes and workers. Use
 * the `ioBudget.ts` mocks to count them. Startup still runs `df` (or
 * PowerShell on Windows) once for the disk monitor.
 *
 * One change: main's crash log appends its buffered lines when a
 * measurement settles, not 2 s after the first one. See
 * `settledCrashLog`.
 */

type Handler = (event: unknown, ...args: unknown[]) => unknown;
type Listener = (event: unknown, ...args: unknown[]) => void;

interface HarnessState {
  root: string;
  userData: string;
  handlers: Map<string, Handler>;
  listeners: Map<string, Listener[]>;
  app: EventEmitter;
  windows: FakeBrowserWindow[];
  sent: Array<{ channel: string; args: unknown[] }>;
  errorBoxes: string[];
  /** `ipcRenderer.on` listeners of the preload, if a test loaded it. */
  rendererListeners: Map<string, Set<Listener>>;
  /** Channels the preload invoked or sent, oldest first. */
  rendererIpc: string[];
  rendererInflight: number;
}

const realFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");

let state: HarnessState | null = null;

/** Created by whichever comes first: the electron factory or bootMainProcess. */
function current(): HarnessState {
  if (state) return state;
  const root = realFs.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-main-"));
  const userData = Path.join(root, "userData");
  realFs.mkdirSync(userData, { recursive: true });
  realFs.mkdirSync(Path.join(root, "home"), { recursive: true });
  state = {
    root,
    userData,
    handlers: new Map(),
    listeners: new Map(),
    app: new EventEmitter(),
    windows: [],
    sent: [],
    errorBoxes: [],
    rendererListeners: new Map(),
    rendererIpc: [],
    rendererInflight: 0,
  };
  return state;
}

/** What a handler sees as `event`: sent from the main window. */
function ipcEvent(harness: HarnessState): { sender: unknown } {
  return { sender: harness.windows[0]?.webContents ?? null };
}

async function callHandler<T>(harness: HarnessState, channel: string, args: unknown[]): Promise<T> {
  const handler = harness.handlers.get(channel);
  if (!handler) throw new Error(`main.ts registers no ipcMain.handle("${channel}")`);
  return (await handler(ipcEvent(harness), ...args)) as T;
}

function callListeners(harness: HarnessState, channel: string, args: unknown[]): void {
  const listeners = harness.listeners.get(channel);
  if (!listeners?.length) throw new Error(`main.ts registers no ipcMain.on("${channel}")`);
  for (const listener of listeners) listener(ipcEvent(harness), ...args);
}

/** Any member the fakes below do not define is a no-op returning undefined. */
function lenient<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop in obj || typeof prop === "symbol" || prop === "then") {
        return Reflect.get(obj, prop, receiver);
      }
      return () => undefined;
    },
  });
}

class FakeWebContents extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }

  send(channel: string, ...args: unknown[]): void {
    const harness = current();
    harness.sent.push({ channel, args });
    const listeners = harness.rendererListeners.get(channel);
    if (!listeners?.size) return;
    // Electron delivers to the renderer asynchronously.
    queueMicrotask(() => {
      for (const listener of listeners) listener({ sender: null }, ...args);
    });
  }

  isDestroyed(): boolean {
    return false;
  }

  getURL(): string {
    return "";
  }
}

let nextWindowId = 1;

class FakeBrowserWindow extends EventEmitter {
  readonly id = nextWindowId++;
  readonly webContents = lenient(new FakeWebContents(this.id));
  private destroyed = false;
  private visible = true;
  private bounds: { x: number; y: number; width: number; height: number };

  constructor(options: { width?: number; height?: number; x?: number; y?: number } = {}) {
    super();
    this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 800, height: options.height ?? 600 };
    // `new` returns the lenient proxy, so unknown window methods are no-ops.
    const window = lenient(this);
    current().windows.push(window);
    return window;
  }

  static getAllWindows(): FakeBrowserWindow[] {
    return state ? state.windows.filter((win) => !win.isDestroyed()) : [];
  }

  static getFocusedWindow(): FakeBrowserWindow | null {
    return FakeBrowserWindow.getAllWindows()[0] ?? null;
  }

  static fromWebContents(): FakeBrowserWindow | null {
    return FakeBrowserWindow.getFocusedWindow();
  }

  loadURL(): Promise<void> {
    return Promise.resolve();
  }

  loadFile(): Promise<void> {
    return Promise.resolve();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }

  close(): void {
    let prevented = false;
    this.emit("close", { preventDefault: () => { prevented = true; } });
    if (!prevented) this.destroy();
  }

  show(): void {
    this.visible = true;
    this.emit("show");
  }

  hide(): void {
    this.visible = false;
    this.emit("hide");
  }

  isVisible(): boolean {
    return this.visible && !this.destroyed;
  }

  isMinimized(): boolean {
    return false;
  }

  isMaximized(): boolean {
    return false;
  }

  isFullScreen(): boolean {
    return false;
  }

  isFocused(): boolean {
    return this.visible;
  }

  isAlwaysOnTop(): boolean {
    return false;
  }

  getBounds() {
    return { ...this.bounds };
  }

  getNormalBounds() {
    return { ...this.bounds };
  }

  setBounds(next: Partial<FakeBrowserWindow["bounds"]>): void {
    this.bounds = { ...this.bounds, ...next };
  }

  getSize(): [number, number] {
    return [this.bounds.width, this.bounds.height];
  }

  setSize(width: number, height: number): void {
    this.bounds = { ...this.bounds, width, height };
  }
}

function fakeImage(): object {
  return lenient({
    isEmpty: () => true,
    toPNG: () => Buffer.alloc(0),
    toDataURL: () => "",
    getSize: () => ({ width: 0, height: 0 }),
    resize: () => fakeImage(),
    addRepresentation: () => undefined,
  });
}

class FakeTray extends EventEmitter {
  constructor() {
    super();
    return lenient(this);
  }
}

class FakeNotification extends EventEmitter {
  static isSupported(): boolean {
    return false;
  }

  constructor() {
    super();
    return lenient(this);
  }
}

/** `vi.mock("electron")` factory body. See the module comment. */
export function fakeElectron(): Record<string, unknown> {
  const harness = current();
  const app = lenient(Object.assign(harness.app, {
    name: "DiskHound",
    isPackaged: false,
    commandLine: lenient({ appendSwitch: () => undefined, hasSwitch: () => false }),
    whenReady: () => Promise.resolve(),
    isReady: () => true,
    getPath: (name: string) =>
      name === "userData" ? harness.userData : Path.join(harness.root, name),
    getVersion: () => "0.0.0-test",
    getName: () => "DiskHound",
    getLocale: () => "en-US",
    requestSingleInstanceLock: () => true,
    getLoginItemSettings: () => ({ openAtLogin: false }),
    getFileIcon: () => Promise.resolve(fakeImage()),
    quit: () => undefined,
    exit: () => undefined,
  }));
  const ipcMain = lenient({
    handle: (channel: string, handler: Handler) => {
      harness.handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      harness.handlers.delete(channel);
    },
    on: (channel: string, listener: Listener) => {
      harness.listeners.set(channel, [...(harness.listeners.get(channel) ?? []), listener]);
    },
  });
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  const electron = {
    app,
    ipcMain,
    BrowserWindow: FakeBrowserWindow,
    Tray: FakeTray,
    Notification: FakeNotification,
    Menu: lenient({ buildFromTemplate: () => lenient({}), setApplicationMenu: () => undefined }),
    nativeImage: lenient({
      createEmpty: () => fakeImage(),
      createFromPath: () => fakeImage(),
      createFromBitmap: () => fakeImage(),
      createFromBuffer: () => fakeImage(),
      createFromDataURL: () => fakeImage(),
    }),
    dialog: lenient({
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
      showSaveDialog: () => Promise.resolve({ canceled: true }),
      showMessageBox: () => Promise.resolve({ response: 0, checkboxChecked: false }),
      showErrorBox: (title: string, content: string) => {
        harness.errorBoxes.push(`${title}: ${content}`);
      },
    }),
    shell: lenient({
      showItemInFolder: () => undefined,
      openPath: () => Promise.resolve(""),
      openExternal: () => Promise.resolve(),
      trashItem: () => Promise.resolve(),
    }),
    screen: lenient(Object.assign(new EventEmitter(), {
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
      getDisplayMatching: () => display,
      getDisplayNearestPoint: () => display,
    })),
    powerMonitor: lenient(Object.assign(new EventEmitter(), { getSystemIdleTime: () => 0 })),
    nativeTheme: lenient(Object.assign(new EventEmitter(), { shouldUseDarkColors: true, themeSource: "system" })),
    // For the preload (see rendererHarness.ts): IPC goes straight to
    // main's handlers in this process.
    ipcRenderer: lenient({
      invoke: async (channel: string, ...args: unknown[]) => {
        harness.rendererIpc.push(channel);
        harness.rendererInflight++;
        try {
          return await callHandler(harness, channel, args);
        } finally {
          harness.rendererInflight--;
        }
      },
      send: (channel: string, ...args: unknown[]) => {
        harness.rendererIpc.push(channel);
        callListeners(harness, channel, args);
      },
      on: (channel: string, listener: Listener) => {
        const listeners = harness.rendererListeners.get(channel) ?? new Set();
        listeners.add(listener);
        harness.rendererListeners.set(channel, listeners);
      },
      removeListener: (channel: string, listener: Listener) => {
        harness.rendererListeners.get(channel)?.delete(listener);
      },
    }),
    contextBridge: lenient({
      exposeInMainWorld: (key: string, api: unknown) => {
        (globalThis as Record<string, unknown>)[key] = api;
      },
    }),
  };
  return { ...electron, default: electron };
}

/** The preload's side of the fake IPC, for rendererHarness.ts. */
/** setTimeout's largest delay, ~24.8 days. */
const MAX_TIMER_MS = 2 ** 31 - 1;
let crashLogSettled = false;

/**
 * crash.log with its 2 s flush timer pushed out of any test's reach.
 * Its buffered lines reach disk each time a measurement settles
 * (`onSettle`), so a scenario's lines count as one append in its own
 * window, as they would in the app, instead of in whichever window is
 * open when the timer fires. Lines logged outside a measurement, by
 * startup or a test's setup, flush before the next window opens.
 */
export function settledCrashLog(
  original: typeof import("../shared/crashLog"),
): typeof import("../shared/crashLog") {
  return {
    ...original,
    createCrashLog: (options) => {
      const log = original.createCrashLog({ ...options, flushDelayMs: MAX_TIMER_MS });
      onSettle(() => log.flush());
      crashLogSettled = true;
      return log;
    },
  };
}

export function rendererIpcState(): Pick<HarnessState, "rendererIpc" | "rendererInflight"> {
  return current();
}

export interface MainProcess {
  /** The temp profile main is running against. */
  userData: string;
  /** Calls an `ipcMain.handle` handler the way `ipcRenderer.invoke` does. */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  /** Calls the `ipcMain.on` listeners for a channel, as `ipcRenderer.send` does. */
  send(channel: string, ...args: unknown[]): void;
  /** Everything main sent to a window's webContents, oldest first. */
  sent: Array<{ channel: string; args: unknown[] }>;
  /** Emits an `app` event, such as "before-quit". */
  emitApp(event: string, ...args: unknown[]): void;
}

export interface BootOptions {
  /**
   * Fills the profile before main starts, the way a previous session
   * left it. main reads it during startup.
   */
  seed?: (userData: string) => void | Promise<void>;
}

/** The last channel main registers; once it exists, startup has run. */
const READY_CHANNEL = "diskhound:quit-and-install";
const BOOT_TIMEOUT_MS = 20_000;

let booted: MainProcess | null = null;

/**
 * Starts main.ts once per test file and resolves when every handler is
 * registered. Later calls return the same process.
 */
export async function bootMainProcess(options: BootOptions = {}): Promise<MainProcess> {
  if (booted) return booted;
  const harness = current();
  const { userData } = harness;
  vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:1/");
  vi.stubEnv("HOME", Path.join(harness.root, "home"));

  await options.seed?.(userData);
  // Imported for its side effects: the startup IIFE registers the handlers.
  await import("../main");
  if (!crashLogSettled) {
    throw new Error(
      "main.ts's crash log still flushes on its own timer, so its lines would land in random "
        + "measurements.\nAdd the vi.mock(\"../shared/crashLog\") line from this harness's doc "
        + "comment to the test file.",
    );
  }

  const startedAt = Date.now();
  while (!harness.listeners.has(READY_CHANNEL)) {
    if (harness.errorBoxes.length > 0) {
      throw new Error(`main.ts startup failed:\n${harness.errorBoxes.join("\n")}`);
    }
    if (Date.now() - startedAt > BOOT_TIMEOUT_MS) {
      throw new Error(`main.ts did not finish startup in ${BOOT_TIMEOUT_MS} ms (${harness.handlers.size} handlers registered).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  booted = {
    userData,
    sent: harness.sent,
    invoke: <T>(channel: string, ...args: unknown[]) => callHandler<T>(harness, channel, args),
    send: (channel, ...args) => callListeners(harness, channel, args),
    emitApp: (name, ...args) => {
      harness.app.emit(name, ...args);
    },
  };

  // Startup pre-warms the folder tree of the scan last-scan.json
  // restored, without awaiting it. Wait for that load here, or its
  // reads can land in a test's first measurement on a slow machine.
  // Asking for the root's folders joins the load in flight.
  const restored = await booted.invoke<{ status?: string; rootPath?: string | null } | null>("diskhound:get-current-snapshot");
  if (restored?.status === "done" && restored.rootPath) {
    await booted.invoke("diskhound:get-folder-children", restored.rootPath, restored.rootPath);
  }
  return booted;
}
