import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  _electron as electron,
  test as base,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from "@playwright/test";

import type { AppSettings } from "../../src/shared/contracts";
import { writeScanTree, type ScanTree } from "./scan-tree";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const MAIN = join(REPO_ROOT, "dist-electron", "main.cjs");
const SCANNER_NAME =
  process.platform === "win32" ? "diskhound-native-scanner.exe" : "diskhound-native-scanner";
/** How long app.close() gets before the app is killed. A normal close
 *  takes under a second, even on a slow CI runner. */
const CLOSE_TIMEOUT_MS = 10_000;
/** How long a killed app gets to exit and close its output pipes. */
const KILL_TIMEOUT_MS = 5_000;

/** Settings groups are merged one level deep by settingsStore, so a
 *  seed only needs the keys it changes. */
export type SeedSettings = {
  general?: Partial<AppSettings["general"]>;
  scanning?: Partial<AppSettings["scanning"]>;
  monitoring?: Partial<AppSettings["monitoring"]>;
  notifications?: Partial<AppSettings["notifications"]>;
  storage?: Partial<AppSettings["storage"]>;
};

/**
 * No update checks and no OS notifications. An unpacked app never
 * downloads an update, but it still schedules a check. A scan-complete
 * notification would pop a real banner on the developer's desktop.
 */
const E2E_SETTINGS: SeedSettings = {
  general: { autoUpdate: false },
  notifications: { scanComplete: false, deltaAlerts: false },
};

export type LaunchOptions = {
  /** Reuse the profile of an earlier launch to test a restart. */
  dataDir?: string;
  /** Merged over the E2E defaults. Only written to a fresh profile. */
  settings?: SeedSettings;
};

export type AppHandle = {
  app: ElectronApplication;
  page: Page;
  /** Temp dir that holds this launch's userData (and HOME on Linux). */
  dataDir: string;
  userDataDir: string;
  /** Path the next "Browse for folder..." dialog returns. */
  setPickDirectory: (dir: string | null) => Promise<void>;
  /** Idempotent. The fixture also calls it after each test. Kills the
   *  app, and throws, if it has not exited 10 s after app.close(). Only
   *  the first call throws. */
  close: () => Promise<void>;
  /** Main-process stdout and stderr, and renderer console lines. */
  mainOutput: string[];
  rendererConsole: string[];
};

/** What the report gets for a launch, including one that failed before
 *  it had a window. */
type LaunchDiagnostics = Pick<AppHandle, "userDataDir" | "mainOutput" | "rendererConsole"> & {
  page: Page | null;
};

let nativeScanner: string | undefined;

/**
 * The scanner binary the app is pinned to. E2E tests what ships, so a
 * missing binary is an error, not a quiet switch to the JS worker.
 * `bun run test:e2e` builds the debug binary.
 * DISKHOUND_NATIVE_SCANNER_PATH picks another one, a release build say.
 */
export function nativeScannerPath(): string {
  if (nativeScanner !== undefined) return nativeScanner;
  const override = process.env.DISKHOUND_NATIVE_SCANNER_PATH?.trim();
  const candidate =
    override || join(REPO_ROOT, "native", "diskhound-native-scanner", "target", "debug", SCANNER_NAME);
  if (!existsSync(candidate)) {
    throw new Error(
      `No scanner binary at ${candidate}. ` +
        (override
          ? "Fix DISKHOUND_NATIVE_SCANNER_PATH."
          : "Run `bun run build:native:debug`, or use `bun run test:e2e`, which builds it."),
    );
  }
  nativeScanner = candidate;
  return nativeScanner;
}

function appEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Set by some Electron tooling. It makes the binary run as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  // A parent `bun run dev` would make main load its dev server.
  delete env.VITE_DEV_SERVER_URL;
  delete env.DISKHOUND_NATIVE_SCANNER_PATH;
  return { ...env, ...extra };
}

function writeSeedSettings(userDataDir: string, seed: SeedSettings = {}): void {
  const settings: SeedSettings = {};
  for (const group of new Set([...Object.keys(E2E_SETTINGS), ...Object.keys(seed)])) {
    const key = group as keyof SeedSettings;
    settings[key] = { ...E2E_SETTINGS[key], ...seed[key] } as never;
  }
  writeFileSync(join(userDataDir, "settings.json"), JSON.stringify(settings, null, 2));
}

/**
 * Launch the built app (dist-electron/main.cjs) on a throwaway profile.
 *
 * --user-data-dir moves everything main keeps under userData, and the
 * single-instance lock is keyed on that dir, so a DiskHound the
 * developer already has open is left alone. On Linux, HOME is also
 * redirected: startup writes a .desktop file and icons under
 * ~/.local/share, which would replace the developer's real ones.
 *
 * If the launch fails, onFailure gets its output before the app is
 * closed and a fresh profile removed.
 */
export async function launchApp(
  opts: LaunchOptions = {},
  onFailure?: (diagnostics: LaunchDiagnostics) => Promise<void>,
): Promise<AppHandle> {
  if (!existsSync(MAIN)) {
    throw new Error(`${MAIN} is missing. Run \`bun run test:e2e\`, which builds first.`);
  }
  // Before anything is created, so a missing binary leaves nothing behind.
  const scanner = nativeScannerPath();
  // Canonical form, because that is what app.getPath() reports: macOS
  // resolves /var to /private/var, Windows expands 8.3 short names.
  const dataDir = opts.dataDir ?? realpathSync.native(mkdtempSync(join(tmpdir(), "diskhound-e2e-")));
  const userDataDir = join(dataDir, "userData");
  const homeDir = join(dataDir, "home");
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  if (!existsSync(join(userDataDir, "settings.json"))) {
    writeSeedSettings(userDataDir, opts.settings);
  }

  const diagnostics: LaunchDiagnostics = { page: null, userDataDir, mainOutput: [], rendererConsole: [] };
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, MAIN],
      cwd: REPO_ROOT,
      env: appEnv({
        DISKHOUND_NATIVE_SCANNER_PATH: scanner,
        ...(process.platform === "linux" ? { HOME: homeDir } : {}),
      }),
    });
    return await attach(app, dataDir, diagnostics);
  } catch (error) {
    // The fixture only learns about a launch that returns, so report and
    // clean up here.
    await onFailure?.(diagnostics).catch(() => {});
    if (app) await closeApp(app).catch(() => {});
    if (opts.dataDir === undefined) removeDir(dataDir);
    throw error;
  }
}

async function attach(
  app: ElectronApplication,
  dataDir: string,
  diagnostics: LaunchDiagnostics,
): Promise<AppHandle> {
  const { userDataDir, mainOutput, rendererConsole } = diagnostics;
  app.process().stdout?.on("data", (chunk) => mainOutput.push(String(chunk)));
  app.process().stderr?.on("data", (chunk) => mainOutput.push(String(chunk)));

  const page = await app.firstWindow();
  diagnostics.page = page;
  page.on("console", (message) => rendererConsole.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => rendererConsole.push(`[pageerror] ${error.stack ?? error.message}`));
  await page.waitForSelector(".app-shell");

  // Stub the native folder dialog so the picker's "Browse for folder..."
  // button can be driven from a spec.
  await app.evaluate(({ dialog }) => {
    const stub = dialog as unknown as {
      __e2ePick: string | null;
      showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>;
    };
    stub.__e2ePick = null;
    stub.showOpenDialog = async () =>
      stub.__e2ePick === null
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [stub.__e2ePick] };
  });

  let closed: Promise<void> | null = null;
  return {
    app,
    page,
    dataDir,
    userDataDir,
    setPickDirectory: async (dir) => {
      await app.evaluate(({ dialog }, pick) => {
        (dialog as unknown as { __e2ePick: string | null }).__e2ePick = pick;
      }, dir);
    },
    close: () => (closed ? closed.catch(() => {}) : (closed = closeApp(app))),
    mainOutput,
    rendererConsole,
  };
}

/**
 * app.close(), bounded. Playwright's close runs app.quit() over the Node
 * inspector and then waits, with no timeout, for the process to exit.
 * An app that never got ready, or that ignores the quit, would hang
 * the test until it times out. Playwright also closes every app it
 * launched when the worker exits, in the same way. That close hangs
 * too, the worker teardown times out, and the run fails even when the
 * retry passes. So after CLOSE_TIMEOUT_MS the app is killed, and the
 * close throws.
 */
async function closeApp(app: ElectronApplication): Promise<void> {
  const child = app.process();
  // "close" comes after "exit", once stdout and stderr have closed.
  // That is also when Playwright stops tracking the app.
  const gone = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const closing = app.close();
  if (await settlesWithin(closing, CLOSE_TIMEOUT_MS)) return closing;
  killProcessTree(child);
  const killed = await settlesWithin(gone, KILL_TIMEOUT_MS);
  throw new Error(
    `The app did not exit within ${CLOSE_TIMEOUT_MS} ms of app.close(), so it was killed` +
      (killed ? "." : `, and it had still not exited ${KILL_TIMEOUT_MS} ms later.`),
  );
}

/** Whether the promise settles, either way, within the time limit. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kill the app together with its helpers and the scanner. On Windows,
 * Playwright starts Electron through cmd.exe, so app.process() is the
 * shell. Elsewhere it makes the app the leader of a new process group.
 */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function attachDiagnostics(
  diagnostics: LaunchDiagnostics,
  prefix: string,
  testInfo: TestInfo,
): Promise<void> {
  const { page } = diagnostics;
  if (page && !page.isClosed()) {
    try {
      await testInfo.attach(`${prefix}-window.png`, {
        // Bounded, so a hung renderer cannot use up teardown before close().
        body: await page.screenshot({ timeout: 5_000 }),
        contentType: "image/png",
      });
    } catch {
      // The window can go away between the check and the capture.
    }
  }
  const crashLog = join(diagnostics.userDataDir, "crash.log");
  if (existsSync(crashLog)) {
    await testInfo.attach(`${prefix}-crash.log`, {
      body: readFileSync(crashLog),
      contentType: "text/plain",
    });
  }
  await testInfo.attach(`${prefix}-main-output.txt`, {
    body: diagnostics.mainOutput.join(""),
    contentType: "text/plain",
  });
  await testInfo.attach(`${prefix}-renderer-console.txt`, {
    body: diagnostics.rendererConsole.join("\n"),
    contentType: "text/plain",
  });
}

function removeDir(dir: string): void {
  // Windows can hold a handle for a moment after the app exits.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

type Fixtures = {
  /** Launches the app. Every launch is closed, and its profile removed,
   *  after the test. On failure the window, crash.log and process output
   *  are attached to the report first. A launch that throws attaches
   *  them straight away. */
  launch: (opts?: LaunchOptions) => Promise<AppHandle>;
  /** A small folder tree with known file sizes, removed after the test. */
  scanTree: ScanTree;
};

export const test = base.extend<Fixtures>({
  launch: async ({}, use, testInfo) => {
    const handles: { handle: AppHandle; prefix: string }[] = [];
    const ownedDirs = new Set<string>();
    let launches = 0;
    await use(async (opts = {}) => {
      const prefix = `app-${++launches}`;
      const handle = await launchApp(opts, (diagnostics) =>
        attachDiagnostics(diagnostics, `${prefix}-failed-launch`, testInfo),
      );
      handles.push({ handle, prefix });
      if (opts.dataDir === undefined) ownedDirs.add(handle.dataDir);
      return handle;
    });
    const failed = testInfo.status !== testInfo.expectedStatus;
    // Every app is closed and every profile removed even if one step
    // throws. The first error is rethrown at the end.
    const errors: unknown[] = [];
    for (const { handle, prefix } of handles) {
      if (failed) await attachDiagnostics(handle, prefix, testInfo).catch((error) => errors.push(error));
      try {
        await handle.close();
      } catch (error) {
        errors.push(error);
        // The main output shows what the app did with the quit.
        if (!failed) await attachDiagnostics(handle, prefix, testInfo).catch(() => {});
      }
    }
    for (const dir of ownedDirs) {
      try {
        removeDir(dir);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw errors[0];
  },

  scanTree: async ({}, use, testInfo) => {
    const tree = writeScanTree(testInfo.outputPath("scan-root"));
    await use(tree);
    removeDir(tree.root);
  },
});

export { expect } from "@playwright/test";
