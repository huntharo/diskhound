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
  /** Idempotent. The fixture also calls it after each test. */
  close: () => Promise<void>;
  /** Main-process stdout and stderr, and renderer console lines. */
  mainOutput: string[];
  rendererConsole: string[];
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
 */
export async function launchApp(opts: LaunchOptions = {}): Promise<AppHandle> {
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
    return await attach(app, dataDir, userDataDir);
  } catch (error) {
    // The fixture only learns about a launch that returns, so clean up here.
    await app?.close().catch(() => {});
    if (opts.dataDir === undefined) removeDir(dataDir);
    throw error;
  }
}

async function attach(app: ElectronApplication, dataDir: string, userDataDir: string): Promise<AppHandle> {
  const mainOutput: string[] = [];
  app.process().stdout?.on("data", (chunk) => mainOutput.push(String(chunk)));
  app.process().stderr?.on("data", (chunk) => mainOutput.push(String(chunk)));

  const page = await app.firstWindow();
  const rendererConsole: string[] = [];
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
    close: () => (closed ??= app.close()),
    mainOutput,
    rendererConsole,
  };
}

async function attachDiagnostics(handle: AppHandle, index: number, testInfo: TestInfo): Promise<void> {
  const prefix = `app-${index + 1}`;
  if (!handle.page.isClosed()) {
    try {
      await testInfo.attach(`${prefix}-window.png`, {
        // Bounded, so a hung renderer cannot use up teardown before close().
        body: await handle.page.screenshot({ timeout: 5_000 }),
        contentType: "image/png",
      });
    } catch {
      // The window can go away between the check and the capture.
    }
  }
  const crashLog = join(handle.userDataDir, "crash.log");
  if (existsSync(crashLog)) {
    await testInfo.attach(`${prefix}-crash.log`, {
      body: readFileSync(crashLog),
      contentType: "text/plain",
    });
  }
  await testInfo.attach(`${prefix}-main-output.txt`, {
    body: handle.mainOutput.join(""),
    contentType: "text/plain",
  });
  await testInfo.attach(`${prefix}-renderer-console.txt`, {
    body: handle.rendererConsole.join("\n"),
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
   *  are attached to the report first. */
  launch: (opts?: LaunchOptions) => Promise<AppHandle>;
  /** A small folder tree with known file sizes, removed after the test. */
  scanTree: ScanTree;
};

export const test = base.extend<Fixtures>({
  launch: async ({}, use, testInfo) => {
    const handles: AppHandle[] = [];
    const ownedDirs = new Set<string>();
    await use(async (opts = {}) => {
      const handle = await launchApp(opts);
      handles.push(handle);
      if (opts.dataDir === undefined) ownedDirs.add(handle.dataDir);
      return handle;
    });
    const failed = testInfo.status !== testInfo.expectedStatus;
    // Every app is closed and every profile removed even if one step
    // throws. The first error is rethrown at the end.
    const errors: unknown[] = [];
    for (const [index, handle] of handles.entries()) {
      if (failed) await attachDiagnostics(handle, index, testInfo).catch((error) => errors.push(error));
      await handle.close().catch((error) => errors.push(error));
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
