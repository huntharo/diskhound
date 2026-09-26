import * as FS from "node:fs/promises";
import * as FS_SYNC from "node:fs";
import * as Path from "node:path";
import { getHeapStatistics } from "node:v8";
import { Worker } from "node:worker_threads";
import { createGunzip, createGzip } from "node:zlib";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import {
  createIdleScanSnapshot,
  defaultScanOptions,
  FOLDER_CHILDREN_MAX_DIRS,
  normalizeAppSettings,
  type AffinityRule,
  type AppSettings,
  type DevArtifactReport,
  type DevBranch,
  type DiskIoSnapshot,
  type DuplicateAnalysis,
  type DuplicateScanProgress,
  type FullDiffStatus,
  type IndexSearchQuery,
  type MonitoringSnapshot,
  type NavigateViewPayload,
  type PathActionResult,
  type PermanentDeleteProgress,
  type ScanEngine,
  type ScanFileRecord,
  type ScanOptions,
  type ScanSnapshot,
  ALLOCATED_SIZE_SEMANTICS,
  hardlinkAccountingCompatible,
  indexUsesAllocatedSize,
  sizeSemanticsCompatible,
  UNIX_HARDLINK_ACCOUNTING,
  MAC_VOLUME_ACCOUNTING,
  volumeAccountingCompatible,
  type SystemMemorySnapshot,
  type ToastMessage,
  type UpdateChannel,
  type UpdateStatus,
  type WorkerToMainMessage,
} from "./shared/contracts";
import {
  checkDiskDeltas,
  flushDiskMonitor,
  getDiskDeltaHistory,
  getDiskSpace,
  getLastFullScanAt,
  getMonitoringSnapshot,
  initDiskMonitor,
  markFullScan,
  startDiskMonitoring,
} from "./shared/diskMonitor";
import { readDevBranch } from "./shared/devBranch";
import { createScanSnapshotStore, type SnapshotWriteOptions } from "./shared/scanStore";
import { createAffinityEnforcer, upsertAffinityRule } from "./shared/affinityEnforcer";
import { createSettingsStore, type SettingsStore } from "./shared/settingsStore";
import { createUpdaterStateStore } from "./shared/updaterStateStore";
import { createWindowStateStore, type WindowStateStore } from "./shared/windowStateStore";
import { CRASH_LOG_FILENAME, createCrashLog, formatRendererError } from "./shared/crashLog";
import { createMemoryDiagnostics, type MemorySample } from "./shared/memoryDiagnostics";
import {
  easyMove,
  easyMoveBack,
  getEasyMoves,
  initEasyMoveStore,
  setEasyMoveLogger,
  setEasyMoveProgress,
  verifyEasyMoves,
} from "./shared/easyMoveStore";
import { classifyPermanentDeleteError, isEnoentFsError, tryPermanentDelete } from "./shared/permanentDelete";
import {
  resolveBundledPermanentDeleteWorkerPath,
  runPermanentDeleteWorker,
} from "./shared/permanentDeleteWorkerRuntime";
import {
  clearAllHistory,
  getAllEntries,
  getScanHistory,
  getLatestPair,
  initScanHistory,
  loadHistoricalSnapshot,
  setMaxHistoryPerRoot,
} from "./shared/scanHistory";
import { computeDiff } from "./shared/scanDiff";
import {
  deleteIndex,
  devArtifactsSidecarPath,
  folderTreeSidecarPath,
  indexFilePath,
  initScanIndex,
  listPendingDevArtifactSidecars,
} from "./shared/scanIndex";
import {
  runDuplicateScan,
  setDuplicateLogger,
  setDuplicateVerbose,
  type DuplicateScanHandle,
} from "./shared/duplicates";
import { randomUUID } from "node:crypto";
import { normPath } from "./shared/pathUtils";
import {
  findExcludedFolderActionBlocker,
  isHiddenExcludedPath,
} from "./shared/pathProtection";

import { killProcess as killProcessImpl, sampleSystemMemory } from "./shared/processMonitor";
import {
  computeFullDiffFromIndexFiles,
  resolveBundledFullDiffWorkerPath,
  runFullDiffWorker,
} from "./shared/fullDiffWorkerRuntime";
import {
  resolveBundledFolderTreeWorkerPath,
  runFolderTreeQueryWorker,
  runFolderTreeWorker,
} from "./shared/folderTreeWorkerRuntime";
import {
  MAX_HEAP_FRACTION_DURING_LOAD,
  planFolderTreeLoad,
  type FolderTreeLoadPlan,
} from "./shared/folderTreeLoadPlan";
import { loadFolderTreeSidecar } from "./shared/folderTreeSidecarLoad";
import { EMPTY_FOLDER_NODE, FolderTreePageCache } from "./shared/folderTreePageCache";
import type { FolderTreeSidecarQueryResult } from "./shared/folderTreeSidecarQuery";
import {
  dropSidecarRoots,
  loadDevArtifactReport,
  readDevArtifactSidecar,
  reportFromSidecar,
  sidecarFromReport,
  writeDevArtifactSidecar,
} from "./shared/devArtifactSidecar";
import { dropArtifactsFromReport } from "./shared/devArtifacts";
import {
  resolveBundledDevArtifactsWorkerPath,
  runDevArtifactsClassifyWorker,
  runDevArtifactsRescanWorker,
} from "./shared/devArtifactsWorkerRuntime";
import {
  deleteFullDiffCachesForScan,
  hasFullDiffCache,
  initFullDiffCacheStore,
} from "./shared/fullDiffCacheStore";
import { createTreemapCache } from "./shared/treemapCache";
import { flushUsnCursorStore, initUsnCursorStore } from "./shared/usnCursorStore";
import {
  captureCursorAfterScan,
  checkUsnForAnyChanges,
} from "./usnMonitor";
import { setCursor, volumeForPath } from "./shared/usnCursorStore";
import { resolveNativeScannerBinary } from "./nativeScanner";
import { commitCompletedScan, settingsWithRecentScan } from "./scanCommit";
import { runIncrementalRescan } from "./incrementalRescan";
import { createFullDiffLoader, normalizeDiffLimit } from "./shared/fullDiffLoader";
import { initNativeProcessSample } from "./nativeProcessSample";
import { searchIndexFile } from "./shared/scanIndex";
import { analyzeCleanupFromIndex } from "./shared/suggestions";
import { createNativeScannerSession, type NativeScannerSession } from "./nativeScanner";
import * as elevationModule from "./elevation";
import { createAgentHost, type AgentHost } from "./mcp/electronHost";

const SCAN_SNAPSHOT_CHANNEL = "diskhound:scan-snapshot";
const DISK_DELTA_CHANNEL = "diskhound:disk-delta";
const NOTIFICATION_CHANNEL = "diskhound:notification";
const DUPLICATE_PROGRESS_CHANNEL = "diskhound:duplicate-progress";
const DUPLICATE_RESULT_CHANNEL = "diskhound:duplicate-result";
const DEV_ARTIFACTS_PROGRESS_CHANNEL = "diskhound:dev-artifacts-progress";
const PERMANENT_DELETE_PROGRESS_CHANNEL = "diskhound:permanent-delete-progress";
/** Broadcast from main to every renderer window after settings
 *  are persisted. Replaces the widget's prior 12 s poll — see the
 *  `settingsStore.subscribe` wiring in whenReady. */
const SETTINGS_UPDATED_CHANNEL = "diskhound:settings-updated";
/** Push from main to the MAIN window's renderer only (not the
 *  widget). Carries a NavigateViewPayload — App.tsx subscribes
 *  and switches its active tab in response. Powers the System
 *  Widget's click-through tiles. */
const NAVIGATE_VIEW_CHANNEL = "diskhound:navigate-view";

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const rendererEntryUrl = process.env.VITE_DEV_SERVER_URL;
const projectRoot = Path.join(__dirname, "..");
const rendererEntryFile = Path.join(projectRoot, "dist-renderer", "index.html");
const scanWorkerEntry = Path.join(__dirname, "scan", "scanWorker.cjs");
const fullDiffWorkerEntry = resolveBundledFullDiffWorkerPath(__dirname);
const folderTreeWorkerEntry = resolveBundledFolderTreeWorkerPath(__dirname);
const devArtifactsWorkerEntry = resolveBundledDevArtifactsWorkerPath(__dirname);
const permanentDeleteWorkerEntry = resolveBundledPermanentDeleteWorkerPath(__dirname);
const RELEASES_URL = "https://github.com/tzarebczan/diskhound/releases";

type WorkerScanSession = {
  kind: "worker";
  active: boolean;
  trigger: "manual" | "scheduled";
  stop: () => Promise<void>;
  tempIndexPath?: string;
  tempFolderTreePath?: string;
  tempDevArtifactsPath?: string;
  rootPath: string;
};

type ActiveScanSession = (WorkerScanSession | NativeScannerSession) & {
  active: boolean;
  trigger: "manual" | "scheduled";
  tempIndexPath?: string;
  /** Temp path the scanner emits its folder-tree sidecar to during the
   *  run. Renamed to `folderTreeSidecarPath(historyId)` on success so
   *  the Folders-tab loader can skip the multi-minute NDJSON re-parse. */
  tempFolderTreePath?: string;
  tempDevArtifactsPath?: string;
  /** The scan root this session is working on. Used as the activeScans
   *  Map key so concurrent scans on different drives stay isolated. */
  rootPath: string;
};

let mainWindow: BrowserWindow | null = null;
let widgetWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/**
 * Per-root scan sessions. Keyed by normPath(rootPath) so a "C:\" key and a
 * "C:\\" key collide. Allows concurrent scans on different drives; a new
 * scan on the same root cancels the previous one for that root only.
 */
const activeScans: Map<string, ActiveScanSession> = new Map();
const scanKey = (rootPath: string): string => normPath(rootPath);
/**
 * Per-root duplicate scans. Lets users kick off duplicate detection on
 * multiple drives in parallel without one cancelling the other, and
 * preserves a running scan when the user navigates away and back.
 * Key: normPath(rootPath). Value: the handle returned by runDuplicateScan.
 */
const activeDuplicateScans: Map<string, DuplicateScanHandle> = new Map();
let monitoringInterval: ReturnType<typeof setInterval> | null = null;
let settingsStore: SettingsStore | null = null;
let windowStateStore: WindowStateStore | null = null;
let widgetWindowStateStore: WindowStateStore | null = null;
// Track whether the user explicitly quit (vs. close-to-tray)
let isQuitting = false;

function quitDiskHound(): void {
  isQuitting = true;
  app.quit();
}
/** Second instance arrived before createWindow finished. */
let pendingSecondInstanceFocus = false;
/** Filled after createWindow is defined inside whenReady. */
let createMainWindowFn: (() => Promise<void>) | null = null;
/** In-flight createWindow so second-instance / activate cannot spawn a duplicate. */
let creatingWindow: Promise<void> | null = null;

async function ensureMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) return;
  if (creatingWindow) {
    await creatingWindow;
    return;
  }
  const create = createMainWindowFn;
  if (!create) return;
  const pending = create();
  creatingWindow = pending;
  try {
    await pending;
  } finally {
    if (creatingWindow === pending) creatingWindow = null;
  }
}

app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-oop-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");

// Disable Chromium's background throttling of timers / renderer / IPC.
// Without these, alt-tabbing away from DiskHound while a long scan is
// running freezes the scan-progress UI and stalls setInterval/IPC
// delivery for seconds at a time (Chromium aggressively throttles
// hidden or occluded windows). We want progress heartbeats and the
// [memory] interval to keep ticking regardless of focus state.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// Raise V8's old-generation heap ceiling for the main process from the
// default ~4 GB to 8 GB. On big drives (1M+ directories) the post-scan
// pipeline briefly holds BOTH the old cached folder tree (evicted just
// after) AND the newly-built one (being pre-warmed) — heapTotal spikes
// past 4 GB and V8 hard-aborts the process with NO crash-log line,
// because the abort bypasses our uncaughtException/unhandledRejection
// handlers. Observed in the wild: RSS 3886 MB + heapTotal 3524 MB right
// before the process vanished at 17:11:05 (see crash.log).
//
// Extra ceiling only commits pages when touched; the common case pays
// nothing. 8 GB is comfortable on a modern 16+ GB machine and still
// leaves room for renderer + GPU + tray processes.
//
// NOTE: Electron builds V8 with pointer compression, so this does not
// take effect. On Electron 40 `heap_size_limit` still reads 4096 MB with
// the flag set, and the main isolate and its worker_threads share that
// one 4 GB cage. folderTreeLoadPlan sizes the Folders-tab tree against
// the real limit.
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=8192");
if (process.platform === "linux") {
  app.commandLine.appendSwitch("class", "diskhound");
}

let toastCounter = 0;
const sendToast = (level: ToastMessage["level"], title: string, body?: string) => {
  const toast: ToastMessage = {
    id: `toast-${++toastCounter}`,
    level,
    title,
    body,
    dismissAfterMs: 5_000,
  };
  mainWindow?.webContents.send(NOTIFICATION_CHANNEL, toast);
};

function resolveAppIconPath(): string | null {
  const iconPaths = [
    Path.join(process.resourcesPath ?? projectRoot, "icon.png"),
    Path.join(projectRoot, "build", "icon.png"),
  ];

  for (const iconPath of iconPaths) {
    try {
      if (FS_SYNC.existsSync(iconPath)) {
        return iconPath;
      }
    } catch {
      // Try the next fallback.
    }
  }

  return null;
}

function resolveIconsDir(): string | null {
  const dirs = [
    Path.join(process.resourcesPath ?? projectRoot, "icons"),
    Path.join(projectRoot, "build", "icons"),
  ];
  for (const dir of dirs) {
    try {
      if (FS_SYNC.existsSync(dir) && FS_SYNC.statSync(dir).isDirectory()) {
        return dir;
      }
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Build a window icon with every size we ship as a separate
 * representation. Linux window managers read _NET_WM_ICON as a list
 * of (w, h, ARGB) tuples and pick the best match for each chrome
 * target (dock 48 px, title-bar 16/24 px, Alt-Tab switcher 128 px,
 * Activities overview 256 px, etc.). Passing one 512×512 PNG forces
 * them to downscale — fine for a simple logo, terrible for the
 * DiskHound treemap tiles which alias into an unreadable smudge at
 * 16 px. With explicit 16/24/32/48/64/128/256/512 reps the WM picks
 * the pre-rendered one and the sidebar + title-bar icons both look
 * crisp.
 *
 * Returns null if neither the packaged nor the dev icons/ directory
 * exists — caller falls back to the single-size 512 PNG.
 */
function createAppIconImage(): Electron.NativeImage | null {
  const iconsDir = resolveIconsDir();
  if (!iconsDir) return null;

  const sizes = [512, 256, 128, 64, 48, 32, 24, 16];
  const base = nativeImage.createEmpty();
  let added = 0;

  for (const size of sizes) {
    const pngPath = Path.join(iconsDir, `${size}x${size}.png`);
    try {
      if (!FS_SYNC.existsSync(pngPath)) continue;
      const img = nativeImage.createFromPath(pngPath);
      if (img.isEmpty()) continue;
      if (added === 0) {
        // First representation becomes the base; subsequent calls add
        // extra scale factors. We use 1x as the base scale and express
        // the others as fractional scaleFactors relative to it — this
        // is how Electron's NativeImage lets you bundle multiple pixel
        // densities for a single logical image.
        base.addRepresentation({
          scaleFactor: 1,
          width: size,
          height: size,
          buffer: img.toPNG(),
        });
      } else {
        // Anchor scaleFactor off the base (512 → 1.0). Linux WMs read
        // all reps out of the NativeImage regardless of scaleFactor
        // semantics, but keeping the ratios honest avoids surprising
        // HiDPI tray-icon behavior on macOS if we ever reuse this
        // image there.
        base.addRepresentation({
          scaleFactor: size / sizes[0],
          width: size,
          height: size,
          buffer: img.toPNG(),
        });
      }
      added += 1;
    } catch {
      // Skip a bad file, keep whatever reps we've collected.
    }
  }

  return added > 0 ? base : null;
}

function createTrayIconImage(): Electron.NativeImage {
  const iconPath = resolveAppIconPath();
  if (iconPath) {
    try {
      const icon = nativeImage.createFromPath(iconPath);
      return icon.resize({ width: 16, height: 16 });
    } catch {
      // Fall through to the generated fallback below.
    }
  }

  // Fallback: simple amber square if icon file not found
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 11; buf[i * 4 + 1] = 158; buf[i * 4 + 2] = 245; buf[i * 4 + 3] = 255;
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// ─ Crash + diagnostic logging ────────────────────────────────────────────
//
// We write to %APPDATA%/DiskHound/crash.log (cross-platform: userData).
// The same file covers startup diagnostics, main-process exceptions,
// unhandled rejections, renderer errors (forwarded via IPC), and scan
// worker failures. The Settings UI has a "View crash logs" button so
// users can zip-and-send the file when asking for help.
//
// Crash-class tags append synchronously; everything else is buffered
// for a couple of seconds and flushed at quit. Rotation, buffering and
// repeat counting live in shared/crashLog.ts.

const crashLog = createCrashLog({
  path: () => Path.join(app.getPath("userData"), CRASH_LOG_FILENAME),
});

function crashLogPath(): string {
  return crashLog.path();
}

/**
 * Append a timestamped line to crash.log. Categorized by `tag` so it's
 * easy to grep for a specific failure class when triaging.
 */
function writeCrashLog(tag: string, message: string, options?: { sync?: boolean }): void {
  crashLog.write(tag, message, options);
}

// Buffered lines and repeat counts reach disk on every way out:
// will-quit covers app.quit(), "exit" covers process.exit().
app.on("will-quit", () => crashLog.flushAll());
process.on("exit", () => crashLog.flushAll());

// Back-compat alias — older call sites still use writeStartupLog.
function writeStartupLog(message: string): void {
  writeCrashLog("startup", message);
}

// Errors codes that we treat as "routine, not user-actionable":
// the file vanished, was locked, or we lacked permission to read it.
// These happen all the time on a live filesystem (Brave deleting
// its crash metrics file mid-scan, Defender rotating its
// definition updates, etc.) and aren't bugs we can fix in code —
// the user just sees a confusing "Unexpected error" dialog they
// have to click through. Log them quietly to crash.log so we can
// still see the pattern in support data, but skip the dialog.
//
// Anything else (TypeError, RangeError, panics from native code,
// our own throws) still pops the dialog so real bugs aren't
// hidden.
const ROUTINE_FS_ERROR_CODES = new Set([
  "ENOENT",   // file doesn't exist (anymore)
  "EPERM",    // permission denied
  "EACCES",   // access denied (POSIX flavor of EPERM)
  "EBUSY",    // file in use
  "EMFILE",   // too many open files — transient
  "ENFILE",   // OS-wide file table full — transient
  "EISDIR",   // tried to open a dir as a file — index drift
  "ENOTDIR",  // tried to readdir a file — same
]);

function isRoutineFsError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && ROUTINE_FS_ERROR_CODES.has(code);
}

// Surface uncaught exceptions so a silent crash at least shows up and
// leaves breadcrumbs in crash.log. Routine FS errors get logged but
// not dialogged — too noisy on live filesystems where files come and
// go independently of our scan.
process.on("uncaughtException", (err) => {
  const stackOrMsg = (err as { stack?: string })?.stack
    ?? (err as { message?: string })?.message
    ?? String(err);
  const code = (err as { code?: string })?.code ?? "";
  const routine = isRoutineFsError(err);
  // A routine error doesn't end in a dialog or a dead process, so its
  // line can wait for the next buffered flush like any other.
  writeCrashLog("main-uncaught", `${code ? `[${code}] ` : ""}${stackOrMsg}`, routine ? { sync: false } : undefined);
  if (routine) {
    // Silent: the user can't do anything about a file that vanished
    // mid-scan. The crash.log entry above is sufficient for us to
    // diagnose if the rate gets out of hand.
    return;
  }
  // The dialog blocks the main thread, and the user may kill the app
  // from it. Whatever is buffered goes to disk first.
  crashLog.flush();
  try {
    dialog.showErrorBox(
      "DiskHound — Unexpected error",
      String((err as { stack?: string })?.stack ?? (err as { message?: string })?.message ?? err),
    );
  } catch { /* noop */ }
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  const code = (reason as { code?: string })?.code ?? "";
  writeCrashLog("main-rejection", `${code ? `[${code}] ` : ""}${err.stack ?? err.message}`);
});

/**
 * Summarize main-process memory usage in a one-line-friendly string.
 * Called from the periodic diagnostic + on demand (e.g. when a user
 * clicks "Refresh" in the crash-log viewer).
 */
function describeMemoryUsage(mem: NodeJS.MemoryUsage = process.memoryUsage()): string {
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `rss=${mb(mem.rss)} heapUsed=${mb(mem.heapUsed)} heapTotal=${mb(mem.heapTotal)} external=${mb(mem.external)} arrayBuffers=${mb(mem.arrayBuffers)}`;
}

// ─ Single-instance lock ────────────────────────────────────────────────────
//
// Only one DiskHound window should ever be up — double-click shortcut,
// post-crash relaunch, file-manager "Open" etc. shouldn't spawn
// duplicates that race to rebuild the folder-tree cache or corrupt the
// shared index files.
//
// Three elevation-related scenarios have to ALL work without the user
// ever seeing "nothing happened":
//
//   A. Normal duplicate launch (user double-clicks shortcut twice):
//      second instance fails lock → focus existing → exit. Quick.
//   B. Scheduled-task auto-relaunch: non-elevated parent triggers task,
//      parent waits ~2.5 s to verify elevated sibling then quits. The
//      elevated child hits whenReady before parent quits, so it needs
//      to wait for the lock.
//   C. User hits "Relaunch as admin" in Settings: parent invokes
//      Start-Process -Verb RunAs, schedules its own quit in 500 ms.
//      The elevated child starts BEFORE the parent quits and without
//      any `--launched-by-task` flag — so the scenario-B special-case
//      doesn't catch it, and the child dies silently. User sees
//      nothing reopen.
//
// Original v0.4.1 only special-cased `--launched-by-task` for the
// retry loop, which broke scenario C. The correct fix is to always
// retry briefly on Windows — any user-initiated duplicate can tolerate
// a 3 s "wait for predecessor to quit" before giving up and focusing
// the existing window. Non-Windows platforms keep the strict behaviour.
const SECOND_INSTANCE_FOCUS_EVENT = "second-instance";
const singleInstanceLaunchedByTask = process.argv.includes("--launched-by-task");
const singleInstanceRelaunchedAsAdmin = process.argv.includes("--relaunched-as-admin");
const WINDOWS_LOCK_RETRY_MS = 5_000; // 20 × 250 ms polls
const NORMAL_LOCK_RETRY_MS = 1_500; //  6 × 250 ms polls — covers brief races without blocking duplicate-launch UX

function bringWindowToFront(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.moveTop();
  win.focus();
  if (process.platform === "win32") {
    app.focus({ steal: true });
    win.setAlwaysOnTop(true);
    win.setAlwaysOnTop(false);
  }
}

function focusOrShowMainWindow(): void {
  pendingSecondInstanceFocus = true;
  const win = mainWindow;
  if (win && !win.isDestroyed()) {
    bringWindowToFront(win);
    return;
  }
  void ensureMainWindow()
    .then(() => {
      if (!pendingSecondInstanceFocus) return;
      const created = mainWindow;
      if (!created || created.isDestroyed()) return;
      pendingSecondInstanceFocus = false;
      bringWindowToFront(created);
    })
    .catch((err: unknown) => {
      writeStartupLog(
        `ensureMainWindow failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

function hideMainWindow(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  win.hide();
}

function showMainWindowIfPresent(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  bringWindowToFront(win);
}

function registerSecondInstanceHandler(): void {
  app.on(SECOND_INSTANCE_FOCUS_EVENT, () => {
    writeStartupLog("second-instance: focusing existing window");
    focusOrShowMainWindow();
  });
}

function showCloseToTrayHint(): void {
  const settings = settingsStore?.get();
  if (!settings || settings.general.hasShownCloseToTrayHint) return;

  const title = "DiskHound is still running";
  const body =
    "The window was hidden to the tray. Launch DiskHound again or click the tray icon to bring it back. Choose Quit in the tray menu to exit.";

  if (process.platform === "win32" && tray) {
    tray.displayBalloon({ iconType: "info", title, content: body });
  } else if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }

  void settingsStore?.update((current) => ({
    ...current,
    general: { ...current.general, hasShownCloseToTrayHint: true },
  }));
}

async function acquireSingleInstanceLockOrExit(): Promise<void> {
  if (app.requestSingleInstanceLock()) {
    registerSecondInstanceHandler();
    return;
  }

  // Lock is held. How long are we willing to wait for it?
  //   - Launched by the scheduled task or a relaunch-as-admin handoff:
  //     5 s (parent is deliberately quitting, we WILL succeed).
  //   - Any other Windows launch: 1.5 s — enough to survive a quick
  //     double-click race without making duplicate-launch feel slow.
  //   - Non-Windows: no retry, exit immediately.
  const maxWaitMs =
    process.platform !== "win32"
      ? 0
      : singleInstanceLaunchedByTask || singleInstanceRelaunchedAsAdmin
        ? WINDOWS_LOCK_RETRY_MS
        : NORMAL_LOCK_RETRY_MS;

  const polls = Math.floor(maxWaitMs / 250);
  for (let i = 0; i < polls; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (app.requestSingleInstanceLock()) {
      writeStartupLog(
        `single-instance lock acquired after ${(i + 1) * 250} ms retry (launchedByTask=${singleInstanceLaunchedByTask}, relaunchedAsAdmin=${singleInstanceRelaunchedAsAdmin})`,
      );
      registerSecondInstanceHandler();
      return;
    }
  }

  // Still held — assume a genuinely-concurrent instance. Electron has
  // already signalled the primary with `second-instance`; our job is
  // just to exit cleanly.
  writeStartupLog(
    `single-instance lock not acquired after ${maxWaitMs} ms — another DiskHound is already running (launchedByTask=${singleInstanceLaunchedByTask}, relaunchedAsAdmin=${singleInstanceRelaunchedAsAdmin}), exiting`,
  );
  app.quit();
  process.exit(0);
}

if (process.platform === "win32") {
  app.setAppUserModelId("com.diskhound.app");
}

void (async () => {
  writeStartupLog("acquiring single-instance lock");
  await acquireSingleInstanceLockOrExit();
  await app.whenReady();
  writeStartupLog("whenReady fired");
  initNativeProcessSample(projectRoot);

  if (process.platform === "linux") {
    // First-run (and every-run, idempotently) XDG desktop integration:
    // drop the .desktop file into ~/.local/share/applications and the
    // hicolor icons into ~/.local/share/icons/hicolor so GNOME's dock
    // can match the running window to a proper launcher entry. Without
    // this, AppImage users saw a blank/generic icon in the sidebar
    // because the .desktop file embedded *inside* the AppImage isn't
    // on the XDG search path. Runs in parallel with the rest of
    // startup — the window doesn't block on it.
    const { integrateLinuxDesktop } = await import("./linuxDesktopIntegration");
    const os = await import("node:os");
    void integrateLinuxDesktop({
      homeDir: os.homedir(),
      iconsDir: resolveIconsDir(),
      // APPIMAGE is the env var set by the AppImage runtime and points
      // at the .AppImage file the user double-clicked. process.execPath
      // inside an AppImage resolves to /tmp/.mount_XXXXX/... which
      // vanishes the moment the AppImage unmounts — useless as an
      // Exec= target. Outside AppImage (tar.gz extract, dev run) fall
      // back to the real binary path.
      execPath: process.env.APPIMAGE || process.execPath,
      logger: writeCrashLog,
    }).catch((err) => {
      writeCrashLog(
        "linux-integration",
        `top-level await rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  if (process.platform === "win32") {
    // Auto-relaunch via the registered Scheduled Task (if any). This
    // is what makes "Always run as admin" actually always: normal
    // shortcut click → this non-elevated instance detects the task,
    // fires it, quits. The task launches a new elevated instance
    // with NO UAC prompt because Windows honors the saved HighestAvailable
    // RunLevel credential. Guarded by process.argv to avoid a loop
    // (the elevated task invocation passes `--launched-by-task` so we
    // know not to relaunch AGAIN).
    const launchedByTask = process.argv.includes("--launched-by-task");
    const relaunchedAsAdmin = process.argv.includes("--relaunched-as-admin");
    const launchedFromInstaller = process.argv.includes("--launched-from-installer");
    const launchedAfterUpdate = process.argv.includes("--updated");
    writeStartupLog(
      `elevation-probe: argv flags launchedByTask=${launchedByTask} relaunchedAsAdmin=${relaunchedAsAdmin} launchedFromInstaller=${launchedFromInstaller} launchedAfterUpdate=${launchedAfterUpdate} pid=${process.pid}`,
    );
    // Installer/update "run the app" must not hand off to the scheduled
    // task: that quits this process and the elevated sibling often never
    // surfaces (stale task path, window behind the installer, lock race).
    if (!launchedByTask && !launchedFromInstaller && !launchedAfterUpdate) {
      try {
        const [elevated, taskRegistered] = await Promise.all([
          elevationModule.isElevated(),
          elevationModule.hasScheduledTask(),
        ]);
        writeStartupLog(
          `elevation-probe: isElevated=${elevated} hasScheduledTask=${taskRegistered}`,
        );
        if (!elevated && taskRegistered) {
          writeStartupLog("auto-relaunch via scheduled task (not elevated, task registered)");
          // Always re-register the task on startup before we run it.
          // This catches the "reinstalled to a new path" failure mode
          // where the registered task points at a stale exe location.
          // Re-registering requires UAC. Since the user is being
          // prompted anyway (first run after install), we skip the
          // silent re-register here and just run the existing task;
          // if that fails with "cannot find file" we'll surface the
          // error in the Settings UI where the user can re-register.
          const result = await elevationModule.runScheduledTaskNow();
          writeStartupLog(
            `scheduled-task run result: ok=${result.ok} exitCode=${result.exitCode ?? "?"} stdout=${JSON.stringify(result.stdout ?? "")} stderr=${JSON.stringify(result.stderr ?? "")}`,
          );
          if (result.ok) {
            // Wait briefly, then verify a second DiskHound.exe actually
            // spun up before we quit. If the task failed to elevate
            // (e.g. user account can't elevate, task credential stale)
            // the elevated instance never starts and quitting here
            // leaves the user with no app at all. Revert to normal
            // startup if we can't confirm the relaunch.
            await new Promise((r) => setTimeout(r, 2500));
            const elevatedInstanceRunning = await elevationModule
              .countDiskHoundProcesses()
              .catch(() => 0);
            if (elevatedInstanceRunning > 1) {
              writeStartupLog(
                `elevated sibling detected (${elevatedInstanceRunning} DiskHound.exe processes) — quitting this non-elevated instance`,
              );
              app.quit();
              return;
            }
            writeStartupLog(
              `scheduled task triggered but no elevated sibling appeared after 2.5s (found=${elevatedInstanceRunning}) — continuing non-elevated`,
            );
          } else {
            writeStartupLog(
              `scheduled task run failed: ${result.message ?? "unknown error"} (exit=${result.exitCode ?? "?"}) — continuing non-elevated`,
            );
          }
        }
      } catch (err) {
        writeStartupLog(
          `scheduled-task auto-relaunch probe failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Non-fatal — fall through to normal non-elevated startup.
      }
    }
  }

  const scanStore = await createScanSnapshotStore(app.getPath("userData"));
  settingsStore = await createSettingsStore();
  // Window-geometry persistence — restores width/height/x/y plus
  // maximize / fullscreen state across restarts. Must be created
  // before createWindow() so resolveBounds() can feed the
  // BrowserWindow constructor.
  windowStateStore = await createWindowStateStore({
    defaults: { width: 1560, height: 980 },
    minWidth: 960,
    minHeight: 640,
  });
  widgetWindowStateStore = await createWindowStateStore({
    defaults: { width: 390, height: 650 },
    minWidth: 330,
    minHeight: 500,
    fileName: "widget-window-state.json",
  });

  // Broadcast settings changes to every renderer window. Replaces
  // the widget's prior 12 s settings poll — theme flips made in
  // the main app now propagate to the widget within a few ms via
  // `diskhound:settings-updated` IPC. The store's subscribe() fires
  // after every successful set/update, so callers don't need to
  // remember to broadcast (e.g. the affinity-rule engine that
  // updates `lastAppliedAt` from the main process automatically
  // flows through here).
  // Wire the duplicate scanner's verbose logger into crash.log so
  // diagnostic lines land in the same shareable file as everything
  // else. The verboseEnabled flag is then toggled via the settings
  // subscribe wiring below.
  setDuplicateLogger((msg) => writeCrashLog("dup", msg));

  settingsStore.subscribe((settings) => {
    // Push the retention cap into scanHistory so subsequent scans
    // honor the user's preference. The retention is enforced on
    // saveScanToHistory, so this only affects pruning of NEW scans —
    // existing history beyond the new cap isn't auto-pruned (the
    // user clears via the Storage panel's button instead). That's
    // intentional: a settings change shouldn't surprise-delete data.
    setMaxHistoryPerRoot(settings.storage.maxHistoryPerRoot);
    setDuplicateVerbose(settings.storage.verboseDuplicateLog);
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(SETTINGS_UPDATED_CHANNEL, settings);
      } catch {
        // Renderer might be unloading — best effort.
      }
    }
  });
  // Apply the current settings once at startup before any scan runs.
  setMaxHistoryPerRoot(settingsStore.get().storage.maxHistoryPerRoot);
  setDuplicateVerbose(settingsStore.get().storage.verboseDuplicateLog);

  // Startup-state diagnostic. User reported drive picker showing
  // up unexpectedly (didn't run "Clear all" themselves). Log the
  // state of the relevant files so we can spot whether last-scan
  // .json or the scan-history index disappeared between sessions.
  try {
    const userData = app.getPath("userData");
    const lastScanPath = Path.join(userData, "last-scan.json");
    const histIndexPath = Path.join(userData, "scan-history", "scan-history-index.json");
    const indexesDir = Path.join(userData, "scan-indexes");
    let lastScanInfo = "missing";
    try {
      const st = await FS.stat(lastScanPath);
      const raw = await FS.readFile(lastScanPath, "utf-8");
      const parsed = JSON.parse(raw) as { status?: string; rootPath?: string | null; finishedAt?: number };
      lastScanInfo = `size=${st.size}B status=${parsed.status ?? "?"} root=${parsed.rootPath ?? "null"} finishedAt=${parsed.finishedAt ?? "?"}`;
    } catch { /* missing or unreadable */ }
    let histCount = 0;
    try {
      const raw = await FS.readFile(histIndexPath, "utf-8");
      const entries = JSON.parse(raw) as unknown[];
      if (Array.isArray(entries)) histCount = entries.length;
    } catch { /* missing */ }
    let indexFileCount = 0;
    try {
      const entries = await FS.readdir(indexesDir);
      indexFileCount = entries.filter((n) => n.endsWith(".ndjson.gz")).length;
    } catch { /* missing */ }
    writeCrashLog(
      "startup-state",
      `lastScan: ${lastScanInfo} | historyEntries=${histCount} | indexFilesOnDisk=${indexFileCount}`,
    );
  } catch { /* non-fatal */ }

  // Sweep orphan pending-* index files left behind by crashed scans.
  // Done in the background so app startup isn't delayed; if it's
  // long-running (rare — there are usually <10 such files), the
  // user just sees their disk usage drop a moment later.
  void (async () => {
    try {
      const indexesDir = Path.join(app.getPath("userData"), "scan-indexes");
      const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour old
      const entries = await FS.readdir(indexesDir, { withFileTypes: true });
      let removed = 0;
      let bytesFreed = 0;
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith("pending-")) continue;
        const full = Path.join(indexesDir, entry.name);
        try {
          const stat = await FS.stat(full);
          if (stat.mtimeMs >= cutoff) continue;
          await FS.unlink(full);
          removed++;
          bytesFreed += stat.size;
        } catch { /* skip */ }
      }
      if (removed > 0) {
        writeCrashLog("storage-cleanup", `startup sweep: pruned ${removed} orphan pending-* files, freed ${bytesFreed} bytes`);
      }
    } catch { /* directory missing, fine */ }
  })();

  // Initialize disk monitor with persistent baseline storage
  await initDiskMonitor(app.getPath("userData"));
  // Prime the cached monitoring snapshot so the UI can show current drive state
  // without mutating baselines on first render.
  try {
    await checkDiskDeltas();
  } catch {
    // Best effort - monitoring remains optional
  }

  // Initialize easy-move store
  initEasyMoveStore(app.getPath("userData"));
  // Wire crash-log hook so EasyMove can trace its decision path.
  // Without this the "EasyMove failed with EPERM" diagnostic is a
  // black box — we can't tell which tier (rename / copy / robocopy)
  // actually failed or whether isElevated returned as expected.
  setEasyMoveLogger((tag, msg) => writeCrashLog(tag, msg));

  // Wire progress-broadcast hook. Stream-copy fires this every
  // ~500 ms during long cross-drive moves; the renderer subscribes
  // via onEasyMoveProgress and shows a live progress toast.
  setEasyMoveProgress((progress) => {
    mainWindow?.webContents.send("diskhound:easy-move-progress", progress);
  });

  // Initialize scan history + full-file indexes
  initScanHistory(app.getPath("userData"));
  initScanIndex(app.getPath("userData"));
  initFullDiffCacheStore(app.getPath("userData"));
  await initUsnCursorStore(app.getPath("userData"));

  const treemapCache = createTreemapCache({ maxEntries: 6 });

  // ── Scan helpers ──────────────────────────────────────────

  // Latest running snapshot per root. scanStore only holds the most
  // recent broadcast, which is ambiguous with parallel scans; MCP agents
  // polling progress need each root's own numbers.
  const liveSnapshotByKey = new Map<string, ScanSnapshot>();

  const broadcastSnapshot = async (nextSnapshot: ScanSnapshot, options?: SnapshotWriteOptions) => {
    if (nextSnapshot.rootPath) {
      if (nextSnapshot.status === "running") liveSnapshotByKey.set(scanKey(nextSnapshot.rootPath), nextSnapshot);
      else liveSnapshotByKey.delete(scanKey(nextSnapshot.rootPath));
    }
    await scanStore.set(nextSnapshot, options);
    mainWindow?.webContents.send(SCAN_SNAPSHOT_CHANNEL, nextSnapshot);
  };

  /** In-memory side of a scan whose index now sits under `historyId`. */
  const afterScanCommitted = (rootPath: string, historyId: string) => {
    treemapCache.rememberLatest(rootPath, historyId);
    // Evict the prior folder tree for this same root BEFORE
    // kicking off the new build — keeping both in memory
    // doubles peak heap during every rescan cycle.
    invalidateFolderTreesForRoot(rootPath, historyId);
    // Pre-warm the Folders-tab tree, but DEFER it by a few
    // seconds. Scan-complete leaves the main process with a
    // large residue of transient allocations (snapshot history
    // writes, progress-message arrays); kicking off another
    // 500-800 MB allocation for the new tree immediately can
    // push heapTotal past V8's ceiling before GC catches up —
    // observed as a silent hard-abort on a 7.27 M-file C:\
    // scan. A 3-second gap gives V8 time for a major GC cycle
    // before we rebuild the tree.
    setTimeout(() => {
      prewarmFolderTree(historyId, rootPath, "folder-tree-prewarm");
    }, 3000);
  };

  /** In-memory side of a scan that fell out of history retention. */
  const forgetPrunedScan = (prunedId: string) => {
    treemapCache.invalidateScan(prunedId);
    invalidateFolderTree(prunedId);
  };

  const buildRunningSnapshot = (
    rootPath: string,
    scanOptions: ScanOptions,
    engine: ScanEngine,
  ): ScanSnapshot => ({
    ...createIdleScanSnapshot(),
    status: "running",
    engine,
    rootPath,
    scanOptions,
    startedAt: Date.now(),
    finishedAt: null,
    lastUpdatedAt: Date.now(),
  });

  const buildErrorSnapshot = async (
    startingSnapshot: ScanSnapshot,
    errorMessage: string,
  ): Promise<ScanSnapshot> => ({
    ...(await scanStore.get()),
    status: "error",
    engine: startingSnapshot.engine,
    rootPath: startingSnapshot.rootPath,
    scanOptions: startingSnapshot.scanOptions,
    finishedAt: Date.now(),
    elapsedMs:
      startingSnapshot.startedAt === null ? 0 : Date.now() - startingSnapshot.startedAt,
    errorMessage,
    lastUpdatedAt: Date.now(),
  });

  const handleRuntimeMessage = async (
    session: ActiveScanSession,
    message: WorkerToMainMessage,
  ) => {
    if (!session.active) return;

    if (message.type === "progress" || message.type === "done") {
      const engine = message.snapshot.engine;
      message.snapshot.sizeSemantics =
        engine === "js-worker" && process.platform === "win32"
          ? "logical"
          : ALLOCATED_SIZE_SEMANTICS;
      if (process.platform !== "win32") {
        message.snapshot.hardlinkAccounting = UNIX_HARDLINK_ACCOUNTING;
      }
      if (process.platform === "darwin") {
        message.snapshot.volumeAccounting = MAC_VOLUME_ACCOUNTING;
      }
      if (message.type === "done") {
        // History, then the pending index and sidecars renamed to its ID.
        const rootPath = message.snapshot.rootPath;
        const committed = await commitCompletedScan(
          message.snapshot,
          {
            indexPath: session.tempIndexPath,
            folderTreePath: session.tempFolderTreePath,
            devArtifactsPath: session.tempDevArtifactsPath,
          },
          { log: writeCrashLog, onPruned: forgetPrunedScan },
        );
        if (committed.historyId && committed.indexCommitted && rootPath) {
          afterScanCommitted(rootPath, committed.historyId);
        }
      }

      await broadcastSnapshot(message.snapshot);
      if (message.type === "done") {
        session.active = false;
        // Only clear our slot if we're still the active session for this
        // root — a fast restart may have replaced us already.
        const key = scanKey(session.rootPath);
        if (activeScans.get(key) === session) {
          activeScans.delete(key);
        }
        retuneMemoryDiagCadence();
        markFullScan();
        // Snapshot memory right after a scan settles so users can
        // correlate "I scanned C:\ and now DiskHound is using 800 MB"
        // with an actual line in crash.log.
        writeCrashLog(
          "memory",
          `post-scan ${message.snapshot.rootPath ?? "?"} files=${message.snapshot.filesVisited}: ${describeCacheMemory()}`,
        );
        if (message.snapshot.rootPath) {
          warmLatestFullDiff(message.snapshot.rootPath);
        }

        // Phase-2b: capture the volume's current USN cursor so the next
        // monitoring tick can do a cheap incremental scan. Best-effort —
        // non-NTFS volumes, missing native binary, etc., will silently
        // skip capture and leave the next tick to fall back to full scan.
        if (message.snapshot.rootPath && message.snapshot.status === "done") {
          const binaryPath = resolveNativeScannerBinary(projectRoot);
          if (binaryPath) {
            void captureCursorAfterScan(binaryPath, message.snapshot.rootPath)
              .catch(() => { /* non-fatal */ });
          }
        }

        const settings = settingsStore?.get();

        // Record in recent scans, and auto-seed defaultRootPath so monitoring
        // has a target to rescan without the user having to set one manually.
        if (settings && message.snapshot.rootPath) {
          void settingsStore!.set(settingsWithRecentScan(settings, message.snapshot, session.trigger));
        }

        if (settings?.notifications.scanComplete) {
          // Include the actual root so users running parallel scans on
          // multiple drives can tell which one just finished — the old
          // copy said "Found N files" with no drive attribution, which
          // was ambiguous when three toast arrived in quick succession.
          const rootLabel = message.snapshot.rootPath ?? "scan root";
          sendToast(
            "success",
            `Scan complete — ${rootLabel}`,
            `${message.snapshot.filesVisited.toLocaleString()} files · ${formatBytesShort(message.snapshot.bytesSeen)} total.`,
          );

          if (Notification.isSupported()) {
            new Notification({
              title: `DiskHound — Scan complete: ${rootLabel}`,
              body: `${message.snapshot.filesVisited.toLocaleString()} files · ${formatBytesShort(message.snapshot.bytesSeen)}.`,
            }).show();
          }
        }

        if (session.trigger === "scheduled" && settings?.notifications.deltaAlerts && message.snapshot.rootPath) {
          const latestPair = getLatestPair(message.snapshot.rootPath);
          if (
            latestPair
            && sizeSemanticsCompatible(latestPair.baseline, latestPair.current)
            && hardlinkAccountingCompatible(latestPair.baseline, latestPair.current)
            && volumeAccountingCompatible(latestPair.baseline, latestPair.current)
          ) {
            const [baseline, current] = await Promise.all([
              loadHistoricalSnapshot(latestPair.baseline.id),
              loadHistoricalSnapshot(latestPair.current.id),
            ]);

            if (baseline && current) {
              const diff = computeDiff(baseline, current, latestPair.baseline.id, latestPair.current.id);
              if (diff.totalBytesDelta !== 0) {
                const grew = diff.totalBytesDelta > 0;
                const absBytes = formatBytesShort(Math.abs(diff.totalBytesDelta));
                sendToast(
                  grew ? "warning" : "success",
                  "Scheduled rescan found changes",
                  `${message.snapshot.rootPath} ${grew ? "grew" : "freed"} ${absBytes} since the previous full scan.`,
                );

                if (Notification.isSupported() && !mainWindow?.isVisible()) {
                  new Notification({
                    title: "DiskHound - Scheduled Rescan",
                    body: `${message.snapshot.rootPath} ${grew ? "grew" : "freed"} ${absBytes}.`,
                  }).show();
                }
              }
            }
          }
        }
      }
    }
  };

  const handleRuntimeFailure = async (
    session: ActiveScanSession,
    startingSnapshot: ScanSnapshot,
    error: unknown,
  ) => {
    if (!session.active) return;
    session.active = false;
    const key = scanKey(session.rootPath);
    if (activeScans.get(key) === session) {
      activeScans.delete(key);
    }
    retuneMemoryDiagCadence();
    // Clean up orphaned temp index file
    if (session.tempIndexPath) {
      try { await FS.unlink(session.tempIndexPath); } catch { /* already gone */ }
    }
    if (session.tempFolderTreePath) {
      try { await FS.unlink(session.tempFolderTreePath); } catch { /* already gone */ }
    }
    if (session.tempDevArtifactsPath) {
      try { await FS.unlink(session.tempDevArtifactsPath); } catch { /* already gone */ }
    }

    // If the native scanner failed to launch (ENOENT, EACCES), silently
    // fall back to the JS worker so the user still gets a scan.
    const errCode = (error as NodeJS.ErrnoException | undefined)?.code;
    if (
      session.kind === "native" &&
      startingSnapshot.rootPath &&
      (errCode === "ENOENT" || errCode === "EACCES")
    ) {
      console.warn(`[scan] native scanner unavailable (${errCode}) — falling back to JS worker`);
      const { session: fallbackSession, startingSnapshot: fallbackStart } = createWorkerSession(
        startingSnapshot.rootPath,
        startingSnapshot.scanOptions,
        session.trigger,
      );
      activeScans.set(scanKey(startingSnapshot.rootPath), fallbackSession);
      await broadcastSnapshot(fallbackStart);
      return;
    }

    await broadcastSnapshot(
      await buildErrorSnapshot(
        startingSnapshot,
        error instanceof Error ? error.message : String(error),
      ),
    );
  };

  /**
   * Locate the most recent completed scan's index file for the given root —
   * used as the Phase-1 baseline so the next scan can skip unchanged subtrees.
   * Returns undefined if no prior scan exists or if the index file is missing.
   */
  const resolveBaselineIndexFor = (rootPath: string): string | undefined => {
    const history = getScanHistory(rootPath);
    for (const entry of history) {
      if (!indexUsesAllocatedSize(entry)) continue;
      // A Unix index that counted every hardlink would let the JS worker
      // inherit the double count.
      if (!hardlinkAccountingCompatible(entry, { hardlinkAccounting: UNIX_HARDLINK_ACCOUNTING })) continue;
      // A macOS index that walked the Data volume twice would let the JS
      // worker inherit the second copy.
      if (!volumeAccountingCompatible(entry, { volumeAccounting: MAC_VOLUME_ACCOUNTING })) continue;
      const candidate = indexFilePath(entry.id);
      try {
        if (FS_SYNC.existsSync(candidate)) return candidate;
      } catch { /* ignore */ }
    }
    return undefined;
  };

  const createWorkerSession = (
    rootPath: string,
    scanOptions: ScanOptions,
    trigger: "manual" | "scheduled",
  ): { session: WorkerScanSession; startingSnapshot: ScanSnapshot } => {
    const worker = new Worker(scanWorkerEntry);
    const startingSnapshot = buildRunningSnapshot(rootPath, scanOptions, "js-worker");
    const pendingId = `pending-${randomUUID()}`;
    const tempIndexPath = indexFilePath(pendingId);
    const tempDevArtifactsPath = devArtifactsSidecarPath(pendingId);
    // Windows JS-worker occupancy is logical `stat.size`. An allocated MFT
    // baseline would mix size semantics and drop `h:1` on inherit.
    const baselineIndex = process.platform === "win32"
      ? undefined
      : resolveBaselineIndexFor(rootPath);

    const session: WorkerScanSession = {
      kind: "worker",
      active: true,
      trigger,
      tempIndexPath,
      tempDevArtifactsPath,
      rootPath,
      stop: async () => {
        // Ask the worker to stop gracefully first
        worker.postMessage({ type: "cancel" });
        // Give it 500ms to emit a final snapshot, then force-terminate
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(async () => {
            await worker.terminate();
            resolve();
          }, 500);
          worker.once("exit", () => { clearTimeout(timeout); resolve(); });
        });
      },
    };

    worker.on("message", (message: WorkerToMainMessage) => {
      void handleRuntimeMessage(session, message);
    });

    worker.on("error", (error) => {
      void handleRuntimeFailure(session, startingSnapshot, error);
    });

    // Scanner uses generous internal defaults — no user knobs here.
    worker.postMessage({
      type: "start",
      input: {
        rootPath,
        options: scanOptions,
        indexOutput: tempIndexPath,
        baselineIndex,
        devArtifactsOutput: tempDevArtifactsPath,
      },
    });

    return { session, startingSnapshot };
  };

  const createPreferredScanSession = (
    rootPath: string,
    scanOptions: ScanOptions,
    trigger: "manual" | "scheduled",
  ): { session: ActiveScanSession; startingSnapshot: ScanSnapshot } => {
    const nativeStartingSnapshot = buildRunningSnapshot(rootPath, scanOptions, "native-sidecar");
    const pendingScanId = `pending-${randomUUID()}`;
    const tempIndexPath = indexFilePath(pendingScanId);
    // Sidecar's temp path shares the pending UUID so we can rename
    // both atomically on scan-complete to match the final history ID.
    const tempFolderTreePath = folderTreeSidecarPath(pendingScanId);
    const tempDevArtifactsPath = devArtifactsSidecarPath(pendingScanId);
    // Only the Windows scanner inherits unchanged subtrees from the last
    // index. The macOS/Linux walker never does, and parsing the index cost
    // it a full decompress just to learn the previous file count, which
    // history already has.
    const baselineIndex = process.platform === "win32" ? resolveBaselineIndexFor(rootPath) : undefined;
    const expectedTotalFiles = process.platform === "win32"
      ? undefined
      : getScanHistory(rootPath).find((entry) => entry.filesVisited > 0)?.filesVisited;

    // Buffer for messages that arrive before the session is fully wired
    const earlyMessages: WorkerToMainMessage[] = [];
    let earlyErrors: Error[] = [];
    let sessionRef: ActiveScanSession | null = null;

    const nativeResult = createNativeScannerSession(
      projectRoot,
      {
        rootPath,
        options: scanOptions,
        indexOutput: tempIndexPath,
        baselineIndex,
        expectedTotalFiles,
        folderTreeOutput: tempFolderTreePath,
        devArtifactsOutput: tempDevArtifactsPath,
      },
      {
        onMessage: (message) => {
          if (!sessionRef) {
            // Session not yet wired — buffer
            earlyMessages.push(message);
            return;
          }
          void handleRuntimeMessage(sessionRef, message);
        },
        onError: (error) => {
          if (!sessionRef) {
            earlyErrors.push(error);
            return;
          }
          void handleRuntimeFailure(sessionRef, nativeStartingSnapshot, error);
        },
        // Forward native scanner diagnostic lines (phase timings,
        // inheritance stats, etc.) to crash.log so users can share them
        // when asking "why is my scan slow?" without needing to attach
        // a debugger or run from a terminal.
        onStderrLine: (line) => {
          if (line.includes("[diskhound-native-scanner]")) {
            writeCrashLog("scanner", line);
          }
          // Self-healing baseline rejection — surface a toast so the
          // user understands why an incremental scan just decided to
          // do a full walk. Without this the scan "feels slow again"
          // with no explanation; the toast makes it clear this is a
          // one-time recovery event and next scan will be fast again.
          if (line.includes("baseline REJECTED as truncated")) {
            sendToast(
              "info",
              "Rebuilding scan index",
              "Previous index was incomplete — running a full walk once to rebuild it. Future rescans will be fast again.",
            );
          }
        },
      },
    );

    if (nativeResult) {
      // Wire up the session with active=true BEFORE flushing buffered messages
      sessionRef = Object.assign(nativeResult, {
        active: true,
        trigger,
        tempIndexPath,
        tempFolderTreePath,
        tempDevArtifactsPath,
        rootPath,
      }) as ActiveScanSession;

      // Flush any messages that arrived during construction
      for (const msg of earlyMessages) {
        void handleRuntimeMessage(sessionRef, msg);
      }
      for (const err of earlyErrors) {
        void handleRuntimeFailure(sessionRef, nativeStartingSnapshot, err);
      }

      return { session: sessionRef, startingSnapshot: nativeStartingSnapshot };
    }

    return createWorkerSession(rootPath, scanOptions, trigger);
  };

  /**
   * Cancel the active scan for a specific root, or (when rootPath is
   * omitted) cancel ALL active scans. Used both by the IPC cancel
   * handler and by startScan() to retire a prior session on the same
   * root before starting fresh.
   */
  const cancelActiveScan = async (rootPathInput?: string) => {
    if (rootPathInput) {
      const rootPath = Path.resolve(rootPathInput);
      const key = scanKey(rootPath);
      const session = activeScans.get(key);
      if (!session) return null;
      activeScans.delete(key);
      await stopSession(session);
      return sendCancelledSnapshot(rootPath);
    }

    // Cancel all
    const sessions = Array.from(activeScans.values());
    activeScans.clear();
    for (const session of sessions) {
      await stopSession(session);
      await sendCancelledSnapshot(session.rootPath);
    }
    return null;
  };

  const stopSession = async (session: ActiveScanSession) => {
    session.active = false;
    try { await session.stop(); } catch { /* already dead */ }
    if (session.tempIndexPath) {
      try { await FS.unlink(session.tempIndexPath); } catch { /* already gone */ }
    }
    if (session.tempFolderTreePath) {
      try { await FS.unlink(session.tempFolderTreePath); } catch { /* already gone */ }
    }
    if (session.tempDevArtifactsPath) {
      try { await FS.unlink(session.tempDevArtifactsPath); } catch { /* already gone */ }
    }
  };

  const sendCancelledSnapshot = async (rootPath: string) => {
    const prior = await scanStore.get();
    if (normPath(prior.rootPath ?? "") !== normPath(rootPath)) {
      // The renderer's current-view snapshot is for a different root —
      // skip touching scanStore so we don't wipe that drive's state.
      return prior;
    }
    const cancelledSnapshot = await scanStore.update((current) => ({
      ...current,
      status: current.status === "running" ? "cancelled" : current.status,
      finishedAt: Date.now(),
      elapsedMs:
        current.startedAt === null ? current.elapsedMs : Date.now() - current.startedAt,
      lastUpdatedAt: Date.now(),
    }));
    mainWindow?.webContents.send(SCAN_SNAPSHOT_CHANNEL, cancelledSnapshot);
    return cancelledSnapshot;
  };

  const startScan = async (
    rootPathInput: string,
    scanOptions: ScanOptions,
    trigger: "manual" | "scheduled" = "manual",
  ) => {
    const resolvedScanOptions = { ...defaultScanOptions(), ...scanOptions };
    const rootPath = Path.resolve(rootPathInput);
    // Cancel ONLY the session for this root (if any) — leave other
    // drives' scans running. This is what enables parallel multi-drive
    // scans: starting C: while D: is scanning no longer kills D:.
    await cancelActiveScan(rootPath);

    // USN-journal fast-path: if a cursor was captured after a prior
    // scan of this volume AND the journal records no changes since
    // then, reuse the last snapshot entirely. Typical latency ~100 ms
    // on NTFS (vs ~60 s for a full MFT scan). Falls through to the
    // regular scan if:
    //   - no cursor persisted (first scan of this volume)
    //   - journal was recreated (journalId mismatch)
    //   - scanner binary spawn fails (non-NTFS, missing elevation,
    //     or the rare case where the volume's journal is disabled)
    //   - any record has been written to the journal since the cursor
    const scannerBinary = resolveNativeScannerBinary(projectRoot);
    if (scannerBinary && trigger !== "scheduled") {
      try {
        const probe = await checkUsnForAnyChanges(scannerBinary, rootPath);
        if (probe && !probe.changed) {
          const latest = await nativeApi_getLatestSnapshotForRoot_impl(rootPath);
          if (latest) {
            writeCrashLog(
              "usn-fast-path",
              `${rootPath}: no journal changes since last scan — reusing snapshot (files=${latest.filesVisited}, bytes=${latest.bytesSeen})`,
            );
            // Update the cursor to the probe's new cursor so the NEXT
            // rescan's fast-path-vs-full decision compares against the
            // moment of THIS rescan, not the original scan.
            if (
              typeof probe.newCursor === "number"
              && typeof probe.newJournalId === "number"
            ) {
              const volume = volumeForPath(rootPath);
              if (volume) {
                await setCursor({
                  volume,
                  cursor: probe.newCursor,
                  journalId: probe.newJournalId,
                  capturedAt: Date.now(),
                  rootPath,
                });
              }
            }
            // Synthesize a Done snapshot reusing last scan's data,
            // stamped with fresh timestamps so the UI's "last scanned
            // X ago" counter resets. Don't create a new history entry
            // — nothing changed, so the existing one still represents
            // the drive's current state.
            const now = Date.now();
            const fastPathSnapshot: ScanSnapshot = {
              ...latest,
              status: "done",
              startedAt: now,
              finishedAt: now,
              elapsedMs: 1,
              lastUpdatedAt: now,
              scanPhase: "complete",
            };
            await broadcastSnapshot(fastPathSnapshot);
            return fastPathSnapshot;
          }
        }
      } catch (err) {
        // Any fast-path failure is non-fatal; fall through to full
        // scan. The log line helps us distinguish cursor-invalid
        // cases from plain "no prior scan" ones when diagnosing.
        writeCrashLog(
          "usn-fast-path-error",
          err instanceof Error ? (err.stack ?? err.message) : String(err),
        );
      }
    }

    const { session, startingSnapshot } = createPreferredScanSession(
      rootPath,
      resolvedScanOptions,
      trigger,
    );
    activeScans.set(scanKey(rootPath), session);
    retuneMemoryDiagCadence();
    await broadcastSnapshot(startingSnapshot);
    return startingSnapshot;
  };

  // Inline helper that mirrors the "get latest snapshot for root" IPC
  // handler below — used by the fast-path branch above to load the
  // last scan's data when we decide nothing has changed.
  const nativeApi_getLatestSnapshotForRoot_impl = async (
    rootPath: string,
  ): Promise<ScanSnapshot | null> => {
    const history = getScanHistory(rootPath);
    const latest = history[0];
    if (!latest) return null;
    return await loadHistoricalSnapshot(latest.id);
  };

  const pathAction = async (message: string, task: () => Promise<void>): Promise<PathActionResult> => {
    try {
      await task();
      return { ok: true, message };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };

  const protectedPathBlock = (targetPath: string, actionLabel: string): PathActionResult | null => {
    const excludedFolders = settingsStore?.get().scanning.excludedFolderPaths ?? [];
    const block = findExcludedFolderActionBlocker(targetPath, excludedFolders, process.platform);
    if (!block) return null;
    const detail = block.reason === "inside"
      ? `this path is inside excluded folder "${block.folder}"`
      : `this path contains excluded folder "${block.folder}"`;
    return {
      ok: false,
      message:
        `${actionLabel} blocked: ${detail}. ` +
        `Remove or narrow that exclusion in Settings > Protected Folders to allow this action.`,
    };
  };

  // ── IPC: Build identity ───────────────────────────────────

  // Development builds name the checkout they run from in the header.
  // Read once: the code running is what was built at launch, even if
  // the checkout moves to another branch afterwards.
  let devBranch: Promise<DevBranch | null> | null = null;
  ipcMain.handle("diskhound:get-dev-branch", () =>
    (devBranch ??= app.isPackaged ? Promise.resolve(null) : readDevBranch(projectRoot)));

  // ── IPC: Scan ─────────────────────────────────────────────

  ipcMain.handle("diskhound:pick-root", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Choose a folder to scan",
      buttonLabel: "Scan folder",
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle("diskhound:pick-protected-folder", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Choose a folder to protect",
      buttonLabel: "Protect folder",
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  // Elevation + fast-scan admin UX. Renderer reads `isElevated` on
  // boot to decide whether to show the "Run as admin for faster
  // scans" banner; Settings → Performance calls `relaunchAsAdmin`
  // directly. `hasScheduledTask` tells the UI whether the
  // "always elevated" opt-in was already taken so it can suppress
  // the banner after the user has committed.
  ipcMain.handle("diskhound:get-elevation-status", async () => {
    const [elevated, taskRegistered] = await Promise.all([
      elevationModule.isElevated(),
      elevationModule.hasScheduledTask(),
    ]);
    return { elevated, scheduledTaskRegistered: taskRegistered };
  });
  ipcMain.handle("diskhound:relaunch-as-admin", async () => {
    try {
      const launched = await elevationModule.relaunchAsAdmin(app.getPath("exe"));
      if (launched) {
        // Only quit if UAC was accepted + the new elevated instance
        // actually started. On UAC cancel, keep the current window
        // alive so the user isn't left with a closed app. Give the
        // new instance a brief moment to reserve its window focus
        // before we exit the old one.
        setTimeout(() => app.quit(), 500);
        return { ok: true };
      }
      return {
        ok: false,
        message: "UAC was cancelled or no elevated process was started. Still running non-elevated.",
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("diskhound:register-scheduled-task", async () => {
    const ok = await elevationModule.registerScheduledTask(app.getPath("exe"));
    return { ok };
  });
  ipcMain.handle("diskhound:unregister-scheduled-task", async () => {
    const ok = await elevationModule.unregisterScheduledTask();
    return { ok };
  });
  ipcMain.handle("diskhound:run-scheduled-task", async () => {
    const result = await elevationModule.runScheduledTaskNow();
    if (result.ok) {
      // Give the elevated task a moment to come up before we quit,
      // so the user sees the new (elevated) window in the same visual
      // gesture as closing this non-elevated one.
      setTimeout(() => app.quit(), 500);
    } else {
      writeCrashLog(
        "run-scheduled-task",
        `schtasks /run failed: exit=${result.exitCode ?? "?"} stderr=${result.stderr ?? ""} stdout=${result.stdout ?? ""}`,
      );
    }
    return { ok: result.ok, message: result.message };
  });

  ipcMain.handle("diskhound:get-current-snapshot", () => scanStore.get());
  ipcMain.handle("diskhound:start-scan", (_event, rootPath: string, scanOptions: ScanOptions) =>
    startScan(rootPath, scanOptions),
  );
  ipcMain.handle("diskhound:cancel-scan", (_event, rootPath?: string) => cancelActiveScan(rootPath));
  // New: tell the renderer which scans are currently running. Lets the
  // UI show per-drive progress indicators + avoid re-triggering a scan
  // that's already in flight.
  ipcMain.handle("diskhound:get-active-scan-roots", (): string[] => {
    return Array.from(activeScans.values()).map((s) => s.rootPath);
  });

  ipcMain.handle("diskhound:get-latest-snapshot-for-root", async (_event, rootPath: string) => {
    const history = getScanHistory(rootPath);
    const latest = history[0];
    if (!latest) return null;
    return await loadHistoricalSnapshot(latest.id);
  });

  // File icon cache keyed by extension (case-insensitive). Most files share
  // an extension, so we only hit the OS once per type.
  const iconCache = new Map<string, string | null>();

  ipcMain.handle("diskhound:get-file-icon", async (_event, filePath: string, size: "small" | "normal" | "large" = "small") => {
    const ext = Path.extname(filePath).toLowerCase() || "(no-ext)";
    const key = `${ext}:${size}`;
    if (iconCache.has(key)) return iconCache.get(key) ?? null;

    try {
      const image = await app.getFileIcon(filePath, { size });
      if (image.isEmpty()) {
        iconCache.set(key, null);
        return null;
      }
      const dataUrl = image.toDataURL();
      iconCache.set(key, dataUrl);
      return dataUrl;
    } catch {
      iconCache.set(key, null);
      return null;
    }
  });

  // ── IPC: Process / Memory viewer ──────────────────────────

  // Module-scope cache so subsequent calls (tab switches, renderer remounts)
  // can return instantly. A single in-flight promise dedupes concurrent
  // refresh requests so we don't stack PowerShell invocations.
  let memoryCache: SystemMemorySnapshot | null = null;
  let memorySamplePromise: Promise<SystemMemorySnapshot> | null = null;
  // Same pattern for GPU sampling. Get-Counter is the slow one — we
  // dedupe concurrent refreshes and cache between them so the UI tab
  // switch is instant.
  let gpuCache: import("./shared/contracts").GpuSnapshot | null = null;
  let gpuSamplePromise: Promise<import("./shared/contracts").GpuSnapshot> | null = null;
  let diskIoCache: DiskIoSnapshot | null = null;
  let diskIoSamplePromise: Promise<DiskIoSnapshot> | null = null;
  // Affinity rules are enforced against each fresh process sample,
  // at most one pass per 4 s. The enforcer keeps its counters in
  // memory and saves them every 15 min and at quit.
  const affinityEnforcer = createAffinityEnforcer({
    settings: settingsStore,
    enforce: async (rules, processes) =>
      (await import("./affinityRuleEngine")).enforceAffinityRules(rules, processes),
    log: writeCrashLog,
    isSupported: () => process.platform === "win32",
  });

  const refreshMemorySample = (): Promise<SystemMemorySnapshot> => {
    if (memorySamplePromise) return memorySamplePromise;
    memorySamplePromise = sampleSystemMemory()
      .then((snap) => {
        memoryCache = snap;
        memorySamplePromise = null;
        // Fire-and-forget: enforce affinity rules against the fresh
        // process sample. Throttled internally — spawning the
        // enforcement pass here is cheap because it returns
        // immediately when not due.
        void affinityEnforcer.maybeEnforce(snap.processes).catch(() => { /* non-fatal */ });
        return snap;
      })
      .catch((err) => {
        memorySamplePromise = null;
        throw err;
      });
    return memorySamplePromise;
  };

  ipcMain.handle("diskhound:get-memory-snapshot", () => refreshMemorySample());

  // Instant cached read — returns null if nothing sampled yet. The renderer
  // uses this on mount to paint the list immediately, then kicks off a
  // real refresh in the background.
  ipcMain.handle("diskhound:get-cached-memory-snapshot", () => {
    if (!memoryCache) return null;
    return { ...memoryCache, isStale: true };
  });

  // GPU sample — separate cadence from memory so the GPU tab can be
  // opened/closed without forcing a memory resample, and vice versa.
  // The sampler's PowerShell invocation is expensive (~500-1500 ms on
  // cold start), so deduping concurrent requests matters.
  const refreshDiskIoSample = async () => {
    if (diskIoSamplePromise) return diskIoSamplePromise;
    const { sampleDiskIo } = await import("./shared/diskIoSampler");
    diskIoSamplePromise = sampleDiskIo()
      .then((snap) => {
        diskIoCache = snap;
        return snap;
      })
      .finally(() => {
        diskIoSamplePromise = null;
      });
    return diskIoSamplePromise;
  };
  ipcMain.handle("diskhound:get-disk-io-snapshot", () => refreshDiskIoSample());
  ipcMain.handle("diskhound:get-cached-disk-io-snapshot", () => {
    if (!diskIoCache) return null;
    return { ...diskIoCache, isStale: true };
  });

  const refreshGpuSample = async () => {
    if (gpuSamplePromise) return gpuSamplePromise;
    const { sampleGpu } = await import("./shared/gpuSampler");
    gpuSamplePromise = sampleGpu()
      .then((snap) => {
        gpuCache = snap;
        return snap;
      })
      .finally(() => {
        gpuSamplePromise = null;
      });
    return gpuSamplePromise;
  };
  ipcMain.handle("diskhound:get-gpu-snapshot", () => refreshGpuSample());
  ipcMain.handle("diskhound:get-cached-gpu-snapshot", () => {
    if (!gpuCache) return null;
    return gpuCache;
  });

  // Per-path icon cache for executables — unlike get-file-icon (which keys
  // by extension), each .exe typically has its OWN icon, so we must cache
  // by full path.
  const exeIconCache = new Map<string, string | null>();
  ipcMain.handle("diskhound:get-executable-icon", async (_event, filePath: string, size: "small" | "normal" | "large" = "small") => {
    if (!filePath) return null;
    const key = `${filePath}:${size}`;
    if (exeIconCache.has(key)) return exeIconCache.get(key) ?? null;
    try {
      const image = await app.getFileIcon(filePath, { size });
      if (image.isEmpty()) {
        exeIconCache.set(key, null);
        return null;
      }
      const dataUrl = image.toDataURL();
      exeIconCache.set(key, dataUrl);
      return dataUrl;
    } catch {
      exeIconCache.set(key, null);
      return null;
    }
  });

  ipcMain.handle("diskhound:kill-process", async (_event, pid: number, signal: "soft" | "hard"): Promise<PathActionResult> => {
    try {
      await killProcessImpl(pid, signal);
      return { ok: true, message: `Killed process ${pid}` };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // ── CPU affinity ───────────────────────────────────────────
  //
  // Get and set the CPU affinity mask for a process. Uses Windows'
  // Win32 API via PowerShell: `Get-Process -Id $pid | Select
  // -ExpandProperty ProcessorAffinity` for read, and assignment to
  // the same property for write. We report the system's logical
  // processor count alongside so the UI can render the correct
  // number of checkboxes.
  //
  // Requires admin if the target process was started by a different
  // user (or is a protected process). For user's own processes on
  // their own account, no elevation needed.
  ipcMain.handle("diskhound:get-cpu-affinity", async (_event, pid: number): Promise<{
    ok: boolean;
    affinityMask?: number;
    cpuCount: number;
    message?: string;
  }> => {
    const cpuCount = require("node:os").cpus().length;
    if (process.platform !== "win32") {
      return { ok: false, cpuCount, message: "CPU affinity is Windows-only" };
    }
    try {
      const { spawn } = require("node:child_process");
      const result = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).ProcessorAffinity.ToInt64()`,
          ],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        );
        let stdoutBuf = "";
        let stderrBuf = "";
        child.stdout?.on("data", (c: Buffer) => { stdoutBuf += String(c); });
        child.stderr?.on("data", (c: Buffer) => { stderrBuf += String(c); });
        child.on("exit", (code: number | null) => {
          if (code === 0) resolve(stdoutBuf.trim());
          else reject(new Error(stderrBuf.trim() || `exit ${code}`));
        });
      });
      const mask = Number(result);
      if (!Number.isFinite(mask)) {
        return { ok: false, cpuCount, message: `Couldn't parse affinity mask: ${result}` };
      }
      return { ok: true, affinityMask: mask, cpuCount };
    } catch (err) {
      return {
        ok: false,
        cpuCount,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // ── Persistent affinity rules ───────────────────────────────
  //
  // Rules live in AppSettings so they persist across restarts.
  // Read/write goes through settingsStore — the same normalization
  // pass that validates `general.theme` / `monitoring.*` also strips
  // malformed rule entries, so we never crash on a tampered file.
  //
  // appliedCount / lastAppliedAt are the enforcer's: reads include
  // the counts it hasn't saved yet, and saves keep its values.
  ipcMain.handle("diskhound:get-affinity-rules", () => affinityEnforcer.rules());
  ipcMain.handle("diskhound:upsert-affinity-rule", async (_event, rule: AffinityRule) => {
    const settings = settingsStore?.get();
    if (!settings) return { ok: false, message: "Settings unavailable" };
    const next = upsertAffinityRule(settings.affinityRules, rule);
    await settingsStore?.set({ ...settings, affinityRules: next });
    return { ok: true };
  });
  ipcMain.handle("diskhound:delete-affinity-rule", async (_event, id: string) => {
    const settings = settingsStore?.get();
    if (!settings) return { ok: false, message: "Settings unavailable" };
    const next = settings.affinityRules.filter((r) => r.id !== id);
    await settingsStore?.set({ ...settings, affinityRules: next });
    return { ok: true };
  });

  ipcMain.handle("diskhound:set-cpu-affinity", async (_event, pid: number, mask: number): Promise<PathActionResult> => {
    if (process.platform !== "win32") {
      return { ok: false, message: "CPU affinity is Windows-only" };
    }
    if (!Number.isInteger(mask) || mask <= 0) {
      return { ok: false, message: "Affinity mask must be a positive integer" };
    }
    try {
      const { spawn } = require("node:child_process");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            // Assigning IntPtr-typed ProcessorAffinity from an int
            // requires explicit cast. `[IntPtr]${mask}` is how
            // PowerShell constructs a pointer-sized int for the
            // setter call.
            `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.ProcessorAffinity = [IntPtr]${mask}`,
          ],
          { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
        );
        let stderrBuf = "";
        child.stderr?.on("data", (c: Buffer) => { stderrBuf += String(c); });
        child.on("exit", (code: number | null) => {
          if (code === 0) resolve();
          else reject(new Error(stderrBuf.trim() || `exit ${code}`));
        });
      });
      return { ok: true, message: `Affinity set on PID ${pid}` };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle("diskhound:run-scheduled-scan-now", async () => {
    const settings = settingsStore?.get();
    if (!settings) return { ok: false, message: "Settings unavailable" };
    const path = settings.scanning.defaultRootPath;
    if (!path) {
      return { ok: false, message: "Set a default scan path first, or run a manual scan to auto-populate it." };
    }
    // Scan for the scheduled root — per-drive locking means we only
    // block if THIS root is already being scanned.
    const existingKey = scanKey(Path.resolve(path));
    if (activeScans.has(existingKey)) {
      return { ok: false, message: `A scan is already running for ${path}.` };
    }
    await startScan(path, defaultScanOptions(), "scheduled");
    return { ok: true, message: `Scheduled rescan started for ${path}` };
  });

  // ── IPC: Path Actions ─────────────────────────────────────

  ipcMain.handle("diskhound:reveal-path", (_event, targetPath: string) =>
    pathAction("Revealed in file manager.", async () => {
      shell.showItemInFolder(targetPath);
    }),
  );
  ipcMain.handle("diskhound:open-path", (_event, targetPath: string) =>
    pathAction("Opened target path.", async () => {
      const result = await shell.openPath(targetPath);
      if (result) throw new Error(result);
    }),
  );
  const trashPathImpl = async (targetPath: string): Promise<PathActionResult> => {
    const blocked = protectedPathBlock(targetPath, "Trash");
    if (blocked) {
      writeCrashLog("trash", `blocked path=${targetPath} ${blocked.message}`);
      return blocked;
    }
    const resolved = Path.resolve(targetPath);
    try {
      await FS.lstat(resolved);
    } catch {
      writeCrashLog("trash", `missing path=${resolved}`);
      return { ok: false, message: "Nothing at this path to move to the Recycle Bin." };
    }
    try {
      await shell.trashItem(resolved);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeCrashLog("trash", `failed path=${resolved} ${message}`);
      return { ok: false, message };
    }
    try {
      await FS.lstat(resolved);
      writeCrashLog("trash", `noop path=${resolved} still on disk after Recycle Bin`);
      return {
        ok: false,
        message: "The Recycle Bin did not take this folder — it is still on disk.",
      };
    } catch {
      writeCrashLog("trash", `ok path=${resolved}`);
      return { ok: true, message: "Moved to trash." };
    }
  };
  ipcMain.handle("diskhound:trash-path", (_event, targetPath: string) => trashPathImpl(targetPath));
  ipcMain.handle("diskhound:permanent-delete-path", async (_event, targetPath: string) => {
    const blocked = protectedPathBlock(targetPath, "Delete");
    if (blocked) {
      writeCrashLog("delete", `blocked path=${targetPath} ${blocked.message}`);
      return blocked;
    }
    const elevated = await elevationModule.isElevated();
    const resolved = Path.resolve(targetPath);
    const onProgress = (progress: PermanentDeleteProgress) => {
      mainWindow?.webContents.send(PERMANENT_DELETE_PROGRESS_CHANNEL, progress);
    };
    let result: PathActionResult;
    try {
      const stat = await FS.lstat(resolved);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await runPermanentDeleteWorker(resolved, {
          workerPath: permanentDeleteWorkerEntry,
          onProgress,
        });
        result = { ok: true, message: "Permanently deleted." };
      } else {
        result = await tryPermanentDelete(resolved, elevated, onProgress);
      }
    } catch (error) {
      if (isEnoentFsError(error)) {
        result = { ok: true, message: "Permanently deleted." };
      } else {
        result = classifyPermanentDeleteError(error, elevated, resolved);
      }
    }
    writeCrashLog(
      "delete",
      `${result.ok ? "ok" : result.requiresElevation ? "needs-admin" : "fail"} path=${resolved} ${result.message}`,
    );
    return result;
  });
  ipcMain.handle("diskhound:permanent-delete-path-elevated", async (_event, targetPath: string) => {
    const blocked = protectedPathBlock(targetPath, "Delete");
    if (blocked) {
      writeCrashLog("delete", `blocked-elevated path=${targetPath} ${blocked.message}`);
      return blocked;
    }
    const resolved = Path.resolve(targetPath);
    const res = await elevationModule.runElevatedPermanentDelete(resolved);
    if (!res.ok) {
      writeCrashLog("delete", `elevated-fail path=${resolved} ${res.message ?? ""}`);
      return {
        ok: false,
        message: res.cancelled
          ? "Cancelled — nothing was deleted."
          : `Elevated delete failed: ${res.message ?? "unknown error"}`,
      };
    }
    try {
      await FS.lstat(resolved);
      writeCrashLog("delete", `elevated-noop path=${Path.resolve(targetPath)} still on disk`);
      return {
        ok: false,
        message: "The folder is still on disk after the elevated delete.",
      };
    } catch {
      writeCrashLog("delete", `elevated-ok path=${Path.resolve(targetPath)}`);
      return { ok: true, message: "Permanently deleted." };
    }
  });

  // ── IPC: Crash logs ───────────────────────────────────────
  //
  // Read-only helpers for the Settings "View crash logs" UI. The log
  // itself is written by the writeCrashLog() helper declared up top.

  ipcMain.handle("diskhound:get-crash-log", async () => {
    // The viewer should show the lines still buffered in memory too.
    crashLog.flushAll();
    const path = crashLogPath();
    try {
      const stat = await FS.stat(path);
      const text = await FS.readFile(path, "utf-8");
      // Ship the TAIL — users don't need to scroll through 1 MB of
      // boot diagnostics when triaging a recent crash. 64 KB tail
      // covers weeks of typical logging and is easy to paste.
      const TAIL_BYTES = 64 * 1024;
      const trimmed = text.length > TAIL_BYTES
        ? "[…earlier entries truncated…]\n" + text.slice(text.length - TAIL_BYTES)
        : text;
      return { path, sizeBytes: stat.size, text: trimmed };
    } catch {
      return { path, sizeBytes: 0, text: "" };
    }
  });

  // Fire-and-forget — preload uses `ipcRenderer.send` because there's
  // nothing to await here. `showItemInFolder` opens the user's OS
  // file browser, highlighting crash.log alongside its rotated
  // crash.log.old sibling.
  ipcMain.on("diskhound:reveal-crash-log", () => {
    crashLog.flushAll();
    shell.showItemInFolder(crashLogPath());
  });

  // Renderer errors get forwarded here via window.onerror / onunhandled-
  // rejection and from failed polls, so rendering bugs also land in the
  // same file. crashLog counts identical repeats instead of writing
  // each one, so a poll that fails every tick costs a few lines a day.
  ipcMain.on("diskhound:report-renderer-error", (_event, payload: {
    message: string;
    stack?: string;
    source?: string;
  }) => {
    writeCrashLog("renderer", formatRendererError(payload));
  });

  let handleUpdateSettingsChanged:
    | ((previous: AppSettings, next: AppSettings) => void)
    | null = null;

  // ── IPC: Settings ─────────────────────────────────────────

  ipcMain.handle("diskhound:get-settings", () => settingsStore!.get());
  ipcMain.handle("diskhound:update-settings", async (_event, settings: AppSettings) => {
    const previousSettings = settingsStore!.get();
    // `agents` is owned by the AI Agents toggle (its own IPC, which also
    // starts/stops the listener). A Settings save carrying a stale copy
    // must not flip it back.
    const normalizedSettings = normalizeAppSettings({ ...settings, agents: previousSettings.agents });

    await settingsStore!.set(normalizedSettings);

    // Wire launchOnStartup to OS login items
    if (normalizedSettings.general.launchOnStartup !== previousSettings.general.launchOnStartup) {
      applyLoginItemSettings(normalizedSettings.general.launchOnStartup);
    }

    // Recreate tray or destroy it based on minimizeToTray toggle
    if (normalizedSettings.general.minimizeToTray && !tray) {
      createTray();
    } else if (!normalizedSettings.general.minimizeToTray && tray) {
      tray.destroy();
      tray = null;
    }

    restartMonitoring(normalizedSettings);
    handleUpdateSettingsChanged?.(previousSettings, normalizedSettings);
  });

  ipcMain.handle("diskhound:get-recent-scans", () => settingsStore!.get().recentScans ?? []);

  // ── IPC: Easy Move ───────────────────────────────────────

  ipcMain.handle("diskhound:easy-move", async (_event, sourcePath: string, destinationDir: string) => {
    const blocked = protectedPathBlock(sourcePath, "Easy Move");
    if (blocked) return blocked;
    return easyMove(sourcePath, destinationDir);
  });

  /**
   * Elevated EasyMove: for files the user can't stat/move as a normal
   * user (Windows-protected paths). The renderer shows a confirm
   * dialog then calls this; we spawn a single UAC-elevated PowerShell
   * that does the move + link creation, then record the move in the
   * store. One UAC prompt per invocation.
   */
  ipcMain.handle(
    "diskhound:easy-move-elevated",
    async (_event, sourcePath: string, destinationDir: string) => {
      const blocked = protectedPathBlock(sourcePath, "Easy Move");
      if (blocked) return blocked;
      const baseName = Path.basename(sourcePath);
      const destinationPath = Path.join(destinationDir, baseName);

      // Probe the source to decide file vs dir — lstat works even on
      // Windows-protected paths for directory detection via the mode
      // bits. Fall back to a filename heuristic if lstat itself fails.
      let isDirectory = false;
      try {
        const stat = await FS.lstat(sourcePath);
        isDirectory = stat.isDirectory();
      } catch {
        // Heuristic: treat as file if it has an extension, dir otherwise.
        isDirectory = !/\.[^\\/]+$/.test(baseName);
      }

      // Destination already present? Abort — overwriting via an
      // elevated move is a footgun. Surface a clear message.
      if (FS_SYNC.existsSync(destinationPath)) {
        return {
          ok: false,
          message: `Destination already exists: ${destinationPath}`,
        };
      }

      // Ensure destination directory exists (non-elevated mkdir is fine
      // as long as the destination is user-writeable, which it must be
      // for the user to have chosen it).
      try {
        await FS.mkdir(destinationDir, { recursive: true });
      } catch {
        /* best effort — elevated PS will fail cleanly if dir is bad */
      }

      const res = await elevationModule.runElevatedEasyMove(
        sourcePath,
        destinationPath,
        isDirectory,
      );
      if (!res.ok) {
        return {
          ok: false,
          message: res.cancelled
            ? "Cancelled — move not performed."
            : `Elevated move failed: ${res.message ?? "unknown error"}`,
        };
      }

      // Stat the destination to record the size. We stat the DESTINATION
      // because the source is now a symlink/junction; stat'ing it would
      // de-reference and return the dest's stats anyway, but being
      // explicit avoids a circular surprise on non-deref'ing platforms.
      let size = 0;
      try {
        const stat = await FS.stat(destinationPath);
        size = stat.size;
      } catch {
        /* size=0 is harmless; UI uses size for the Easy Move list metric only */
      }

      const { recordElevatedEasyMove } = await import("./shared/easyMoveStore");
      return recordElevatedEasyMove({
        sourcePath,
        destinationPath,
        size,
        isDirectory,
      });
    },
  );

  ipcMain.handle("diskhound:easy-move-back", async (_event, recordId: string) => {
    return easyMoveBack(recordId);
  });

  ipcMain.handle("diskhound:get-easy-moves", () => getEasyMoves());
  ipcMain.handle("diskhound:verify-easy-moves", () => verifyEasyMoves());

  ipcMain.handle("diskhound:pick-move-destination", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Choose destination folder",
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  // ── IPC: Scan History & Diff ──────────────────────────────

  ipcMain.handle("diskhound:get-scan-history", (_event, rootPath: string) => {
    return getScanHistory(rootPath);
  });

  // Tiny LRU cache so flicking between recent baselines in the Changes-tab
  // sidebar doesn't re-read + re-parse the same multi-megabyte JSON each
  // time. We keep up to 8 parsed snapshots in memory (~8-16 MB worst case)
  // — older entries get evicted on insert.
  const snapshotCache = new Map<string, ScanSnapshot>();
  const SNAPSHOT_CACHE_LIMIT = 8;
  const loadHistoricalSnapshotCached = async (id: string): Promise<ScanSnapshot | null> => {
    const cached = snapshotCache.get(id);
    if (cached) {
      // LRU: re-insert moves to end of insertion order
      snapshotCache.delete(id);
      snapshotCache.set(id, cached);
      return cached;
    }
    const snap = await loadHistoricalSnapshot(id);
    if (snap) {
      if (snapshotCache.size >= SNAPSHOT_CACHE_LIMIT) {
        const firstKey = snapshotCache.keys().next().value;
        if (firstKey) snapshotCache.delete(firstKey);
      }
      snapshotCache.set(id, snap);
    }
    return snap;
  };
  const getIndexBytes = async (id: string): Promise<number | null> => {
    try {
      const stat = await FS.stat(indexFilePath(id));
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  };
  const fullDiffLoader = createFullDiffLoader({
    loadSnapshot: loadHistoricalSnapshotCached,
    runWorker: (input) => runFullDiffWorker(input, { workerPath: fullDiffWorkerEntry }),
    computeInline: computeFullDiffFromIndexFiles,
    log: writeCrashLog,
  });
  const warmLatestFullDiff = (rootPath: string) => {
    void fullDiffLoader.warmLatest(rootPath);
  };

  const computeScanDiffImpl = async (baselineId: string, currentId: string) => {
    const [baseline, current] = await Promise.all([
      loadHistoricalSnapshotCached(baselineId),
      loadHistoricalSnapshotCached(currentId),
    ]);
    if (!baseline || !current) return null;
    return computeDiff(baseline, current, baselineId, currentId);
  };
  ipcMain.handle("diskhound:compute-scan-diff", (_event, baselineId: string, currentId: string) =>
    computeScanDiffImpl(baselineId, currentId),
  );

  ipcMain.handle("diskhound:get-full-diff-status", async (
    _event,
    baselineId: string,
    currentId: string,
    limit?: number,
  ): Promise<FullDiffStatus> => {
    const normalizedLimit = normalizeDiffLimit(limit);
    const [cached, baselineIndexBytes, currentIndexBytes] = await Promise.all([
      hasFullDiffCache(baselineId, currentId, normalizedLimit),
      getIndexBytes(baselineId),
      getIndexBytes(currentId),
    ]);
    return {
      baselineId,
      currentId,
      limit: normalizedLimit,
      cached,
      baselineIndexBytes,
      currentIndexBytes,
    };
  });

  ipcMain.handle("diskhound:compute-full-scan-diff", async (
    _event,
    baselineId: string,
    currentId: string,
    limit?: number,
    options?: { retryFailed?: boolean },
  ) => {
    return await fullDiffLoader.load(baselineId, currentId, limit, options);
  });

  // Load a dense file list for the treemap from the persisted full-file index.
  // Returns the top N files by size across the whole scan (not just the
  // top-N tracked in memory). Used for WinDirStat-style dense visualization.
  ipcMain.handle("diskhound:get-treemap-files", async (_event, rootPath: string, limit: number = 10_000) => {
    const pair = getLatestPair(rootPath);
    const history = getScanHistory(rootPath);
    const currentId = pair?.current.id ?? history[0]?.id;
    if (!currentId) return [];

    treemapCache.rememberLatest(rootPath, currentId);

    const latestSnapshot = await loadHistoricalSnapshotCached(currentId);
    if (latestSnapshot && latestSnapshot.largestFiles.length >= limit) {
      return latestSnapshot.largestFiles.slice(0, limit);
    }

    try {
      return await treemapCache.getOrLoad({
        scanId: currentId,
        rootPath,
        indexPath: indexFilePath(currentId),
        limit,
      });
    } catch {
      treemapCache.invalidateScan(currentId);
      return [];
    }
  });

  /**
   * Direct-children-by-folder lookup for the Folders tab. The first call
   * per scan ID streams the persisted NDJSON once and builds a full
   * parent-path → {dirs, files} map in main-process memory. Every
   * subsequent call is an O(1) lookup into that map — which is what
   * turns the Folders tab drill-in from "multi-second wait per click"
   * into instant navigation.
   *
   * Cache is keyed by scanId and evicted when a newer scan for the
   * same root completes (see afterScanDone below). Memory is bounded
   * by the folder count in the tree, not file count: even a 7M-file
   * drive with 100k folders costs only a few MB.
   */
  /**
   * Compact on-heap representation of a file inside the folder-tree
   * cache. We store just the FILENAME (~15 bytes on average) — the
   * parent path is already the Map key, so storing the file's full
   * path was pure duplication. On a 7.27 M-file drive that cut each
   * file entry from ~280 bytes to ~110 bytes — around 850 MB off the
   * cache footprint at the observed 5M file-records total.
   *
   * Expanded to the full ScanFileRecord shape at the IPC boundary
   * via makeFolderFileRecord() below.
   */
  type CompactFolderFile = {
    name: string;
    size: number;
    modifiedAt: number;
  };
  type FolderNode = {
    dirs: { path: string; size: number; fileCount: number }[];
    files: CompactFolderFile[];
  };
  type FolderTree = Map<string, FolderNode>;

  /**
   * Reconstruct a full ScanFileRecord from the compact cached form.
   * Takes the parent path explicitly because the cache omits it — it's
   * the Map key the caller already has.
   */
  const makeFolderFileRecord = (parentPath: string, f: CompactFolderFile): ScanFileRecord => {
    const dotIdx = f.name.lastIndexOf(".");
    const extension = dotIdx > 0 ? f.name.slice(dotIdx).toLowerCase() : "(no ext)";
    return {
      path: `${parentPath}${Path.sep}${f.name}`,
      name: f.name,
      parentPath,
      extension,
      size: f.size,
      modifiedAt: f.modifiedAt,
    };
  };
  /**
   * In-memory cache of built folder trees, keyed by scan ID.
   *
   * Eviction policy: bounded both by scan count (at most N trees) AND
   * by total parent-path entries across ALL trees. The entry cap is
   * what actually protects the heap — a C:\ drive can produce a tree
   * with 1M+ parent paths, and keeping two or three of those in
   * memory runs the main process to a gigabyte+.
   *
   * LRU within the Map's insertion-order semantics (delete + set moves
   * the entry to the tail on access).
   */
  const FOLDER_TREE_MAX_SCANS = 3;
  const FOLDER_TREE_MAX_TOTAL_ENTRIES = 600_000;
  const folderTreeCache: Map<string, FolderTree> = new Map();
  const folderTreeInflight: Map<string, Promise<FolderTree>> = new Map();
  // Track which root each cached/inflight tree belongs to so we can
  // evict the PRIOR tree for root R the moment R gets a new scan.
  // Without this, a fresh C:\ scan would build a new 1M-entry tree
  // while the previous C:\ tree was still in the cache — peak memory
  // doubled during every same-root rescan cycle.
  const folderTreeRootByScanId: Map<string, string> = new Map();
  let folderTreeTotalEntries = 0;

  const evictOldestFolderTree = (): boolean => {
    const oldest = folderTreeCache.keys().next().value;
    if (oldest === undefined) return false;
    const tree = folderTreeCache.get(oldest);
    folderTreeCache.delete(oldest);
    folderTreeTotalEntries -= tree?.size ?? 0;
    if (folderTreeTotalEntries < 0) folderTreeTotalEntries = 0;
    return true;
  };

  const insertFolderTree = (id: string, tree: FolderTree) => {
    // Honour BOTH caps — scan count first, then total-entry pressure.
    folderTreeCache.set(id, tree);
    folderTreeTotalEntries += tree.size;
    while (folderTreeCache.size > FOLDER_TREE_MAX_SCANS) {
      if (!evictOldestFolderTree()) break;
    }
    while (folderTreeTotalEntries > FOLDER_TREE_MAX_TOTAL_ENTRIES && folderTreeCache.size > 1) {
      if (!evictOldestFolderTree()) break;
    }
  };

  const touchFolderTree = (id: string) => {
    const tree = folderTreeCache.get(id);
    if (!tree) return;
    // Re-insert to bump it to the LRU tail.
    folderTreeCache.delete(id);
    folderTreeCache.set(id, tree);
  };

  // ── Folder tree persistence (sidecar on disk) ──────────────────────
  //
  // We write the built tree to `<scanId>.folder-tree.ndjson.gz` next
  // to the scan index. On subsequent app launches (or Folders-tab
  // clicks after eviction), ensureFolderTree reads the sidecar
  // directly — skipping the multi-second stream-and-parse of the full
  // gzipped file index. Format is one NDJSON line per parent entry:
  //
  //   {"k":"c:\\users","d":[["c:\\users\\foo",12345,6]],"f":[["file.txt",1024,1700000000000]]}
  //
  // k: parent path (Map key)
  // d: direct child dirs as [fullChildPath, recursiveSize, recursiveFileCount]
  // f: direct files as [filename, size, modifiedAt]  (compact form)
  //
  // Invalidation: the sidecar is deleted whenever the scan it
  // references is pruned from history (see consumeLastPrunedIds path).
  // Because the sidecar filename is keyed by the scan's UUID, a fresh
  // scan writes its own sidecar and the old one gets garbage-collected
  // when the corresponding history entry rolls off.
  // folderTreeSidecarPath is imported from ./shared/scanIndex so the
  // Rust scanner (which we pass the path to via --folder-tree-output)
  // and the Node reader here agree on exactly one location per scan.

  async function writeFolderTreeSidecar(scanId: string, tree: FolderTree): Promise<void> {
    if (tree.size === 0) return; // nothing to persist
    const filePath = folderTreeSidecarPath(scanId);
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      const { createWriteStream } = await import("node:fs");
      const { pipeline } = await import("node:stream/promises");
      const { Readable } = await import("node:stream");

      // Build an async iterable that yields one NDJSON line per entry.
      // Using a generator keeps us from concat'ing the whole payload
      // into one giant string — the caller can have 1M+ entries.
      async function* emitLines(): AsyncGenerator<string> {
        for (const [parent, node] of tree) {
          const line = JSON.stringify({
            k: parent,
            d: node.dirs.map((d) => [d.path, d.size, d.fileCount]),
            f: node.files.map((f) => [f.name, f.size, f.modifiedAt]),
          });
          yield line + "\n";
        }
      }

      const gz = createGzip({ level: 4 });
      const out = createWriteStream(tempPath);
      await pipeline(Readable.from(emitLines()), gz, out);
      await FS.rename(tempPath, filePath);
    } catch (err) {
      try { await FS.unlink(tempPath); } catch { /* best effort */ }
      writeCrashLog(
        "folder-tree-sidecar-write",
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
    }
  }

  /**
   * Stream the sidecar into a FolderTree. Returns null when it's missing
   * or unreadable (the caller rebuilds from the index), or "heap-ceiling"
   * when loading it pushed the V8 heap past MAX_HEAP_FRACTION_DURING_LOAD
   * of the limit. That's the backstop for a folderTreeLoadPlan estimate
   * that came in low: the partial tree is dropped and the scan is paged.
   */
  async function readFolderTreeSidecar(scanId: string): Promise<FolderTree | null | "heap-ceiling"> {
    const filePath = folderTreeSidecarPath(scanId);
    if (!FS_SYNC.existsSync(filePath)) {
      writeCrashLog(
        "folder-tree-sidecar-read",
        `scanId=${scanId} file missing at ${filePath} — will rebuild from index`,
      );
      return null;
    }

    const heapCeilingBytes = getHeapStatistics().heap_size_limit * MAX_HEAP_FRACTION_DURING_LOAD;
    const result = await loadFolderTreeSidecar(filePath, { heapCeilingBytes });
    if (result.status === "heap-ceiling") {
      writeCrashLog(
        "folder-tree-sidecar-read",
        `scanId=${scanId} stopped at line ${result.lines}: heap ${Math.round(result.heapUsedBytes / 1024 / 1024)} MB passed the ${Math.round(heapCeilingBytes / 1024 / 1024)} MB load ceiling — paging this scan instead`,
      );
      return "heap-ceiling";
    }
    if (result.status === "error") {
      writeCrashLog(
        "folder-tree-sidecar-read",
        `scanId=${scanId} linesRead=${result.lines} error=${result.error instanceof Error ? (result.error.stack ?? result.error.message) : String(result.error)}`,
      );
      return null;
    }
    // Log success/failure ratio so we can tell if a sidecar was
    // present-but-corrupt (rare, but hard to diagnose without
    // explicit instrumentation). Before this, a sidecar that
    // parsed to 0 entries would silently fall through to the
    // worker-based rebuild, which OOM'd on big drives and made
    // the Folders tab unusable after app restart.
    writeCrashLog(
      "folder-tree-sidecar-read",
      `scanId=${scanId} lines=${result.lines} parseFailures=${result.parseFailures} treeSize=${result.tree.size}`,
    );
    return result.tree;
  }

  async function deleteFolderTreeSidecar(scanId: string): Promise<void> {
    try { await FS.unlink(folderTreeSidecarPath(scanId)); } catch { /* already gone */ }
  }

  /**
   * Build-or-get: returns the cached tree when we have one, otherwise
   * builds it exactly once even if called multiple times concurrently.
   * Used both by the IPC handler AND the post-scan pre-warm path, so
   * the user's first drill-in on a fresh scan hits a warm cache.
   *
   * Optional `rootPath` is remembered in folderTreeRootByScanId so a
   * later same-root scan can evict stale siblings.
   *
   * Optional `abortIfMemoryOverMb` lets the PRE-WARM path skip the
   * build when the main process is already sitting on a lot of heap
   * (e.g. right after a huge scan completes). Returns an empty tree
   * in that case instead of crashing the process with OOM — the user
   * will pay the cold-build cost on their next Folders click, but
   * the app survives to do it.
   *
   * Build path:
   *   1. Check in-memory cache → instant
   *   2. Check in-flight promise → coalesce concurrent requests
   *   3. Check on-disk sidecar → ~2-4 s on a drive-scale tree
   *   4. Stream scan index from scratch → ~5-15 s on a drive-scale
   *      tree (original cost); writes sidecar on success
   */
  const PREWARM_RSS_CEILING_MB = 5500;
  /** Loading this scan's tree hit the heap ceiling; callers page it instead. */
  class FolderTreeTooLargeError extends Error {
    constructor(scanId: string) {
      super(`Folder tree for scan ${scanId} is too large to hold in memory`);
      this.name = "FolderTreeTooLargeError";
    }
  }
  /** Scans whose in-memory load hit the heap ceiling. Paged from then on. */
  const folderTreePagedScanIds = new Set<string>();
  const ensureFolderTree = async (
    id: string,
    rootPath?: string,
    opts?: { skipIfMemoryPressureMb?: number },
  ): Promise<FolderTree> => {
    if (rootPath) folderTreeRootByScanId.set(id, normPath(rootPath));
    const existing = folderTreeCache.get(id);
    if (existing) {
      touchFolderTree(id);
      return existing;
    }
    const inflight = folderTreeInflight.get(id);
    if (inflight) return inflight;
    if (opts?.skipIfMemoryPressureMb) {
      const rssMb = process.memoryUsage().rss / 1024 / 1024;
      if (rssMb > opts.skipIfMemoryPressureMb) {
        writeCrashLog(
          "folder-tree-prewarm-skipped",
          `RSS ${rssMb.toFixed(0)} MB > ${opts.skipIfMemoryPressureMb} MB — skipping pre-warm to avoid OOM. User's first Folders click will build cold.`,
        );
        return new Map();
      }
    }

    const pending = (async () => {
      // Try the persisted sidecar first. Writing the sidecar is
      // best-effort (see writeFolderTreeSidecar), so a missing or
      // corrupt file just falls through to the full rebuild path.
      const started = Date.now();
      const sidecarFilePresent = FS_SYNC.existsSync(folderTreeSidecarPath(id));
      const fromDisk = await readFolderTreeSidecar(id);
      if (fromDisk === "heap-ceiling") {
        folderTreePagedScanIds.add(id);
        throw new FolderTreeTooLargeError(id);
      }
      if (fromDisk && fromDisk.size > 0) {
        writeCrashLog(
          "folder-tree-sidecar-hit",
          `scanId=${id} entries=${fromDisk.size} load=${Date.now() - started}ms`,
        );
        insertFolderTree(id, fromDisk);
        return fromDisk;
      }
      // Sidecar exists but parsed to an empty Map — don't rebuild via
      // the worker. The worker reads the SAME scan's NDJSON index;
      // on drives big enough to need the sidecar fast-path, that
      // rebuild OOMs the worker (observed in crash.log:
      // "[folder-tree-prewarm-boot] Error: Folder tree worker out of
      // memory, 8 GB heap"). Returning an empty tree keeps the
      // Folders tab responsive (shows an empty state) and a
      // subsequent scan will produce a fresh, readable sidecar.
      if (sidecarFilePresent) {
        writeCrashLog(
          "folder-tree-sidecar-empty-skip-rebuild",
          `scanId=${id} sidecar parsed to 0 entries — skipping worker rebuild to avoid OOM. Run a fresh scan to regenerate.`,
        );
        const empty: FolderTree = new Map();
        insertFolderTree(id, empty);
        return empty;
      }
      const tree = await buildFolderTree(indexFilePath(id));
      insertFolderTree(id, tree);
      // Fire-and-forget sidecar write so the NEXT ensure call for this
      // scanId hits the fast disk path. Errors logged, don't block.
      void writeFolderTreeSidecar(id, tree);
      return tree;
    })().finally(() => {
      folderTreeInflight.delete(id);
    });
    folderTreeInflight.set(id, pending);
    return pending;
  };

  const invalidateFolderTree = (id: string) => {
    const tree = folderTreeCache.get(id);
    if (tree) {
      folderTreeCache.delete(id);
      folderTreeTotalEntries -= tree.size;
      if (folderTreeTotalEntries < 0) folderTreeTotalEntries = 0;
    }
    folderTreeInflight.delete(id);
    folderTreeRootByScanId.delete(id);
    folderTreePages.invalidateScan(id);
    folderTreePagedScanIds.delete(id);
  };

  /**
   * Drop every cached folder tree that belongs to the given root
   * EXCEPT the excluded scan ID. Called on scan-complete so the new
   * scan's tree supersedes the prior one for that same drive instead
   * of sharing heap space with it.
   */
  const invalidateFolderTreesForRoot = (rootPath: string, exceptScanId: string | null) => {
    const rootKey = normPath(rootPath);
    for (const [scanId, tracked] of folderTreeRootByScanId) {
      if (tracked === rootKey && scanId !== exceptScanId) {
        invalidateFolderTree(scanId);
      }
    }
  };

  // ── Folder tree load planning and paging ─────────────────────────
  //
  // A scan's whole tree can be far bigger than the V8 heap. A 42M-file
  // `/` scan wrote a 995 MB sidecar that needs ~8.9 GB as a FolderTree,
  // and Electron caps the main process (and its workers, which share
  // the same pointer-compression cage) at 4 GB. Loading it at boot
  // aborted the app every launch. folderTreeLoadPlan decides per scan:
  // hold the whole tree ("memory"), read one folder at a time from the
  // sidecar ("paged"), or refuse with a message ("unavailable").

  /** DISKHOUND_FOLDER_TREE_MAX_HEAP_MB caps the in-memory tree. 0 forces paging. */
  const folderTreeMaxHeapOverride = (() => {
    const raw = process.env.DISKHOUND_FOLDER_TREE_MAX_HEAP_MB;
    if (raw === undefined || raw.trim() === "") return undefined;
    const mb = Number(raw);
    return Number.isFinite(mb) && mb >= 0 ? mb * 1024 * 1024 : undefined;
  })();

  const fileSizeOrNull = (filePath: string): number | null => {
    try {
      return FS_SYNC.statSync(filePath).size;
    } catch {
      return null;
    }
  };

  const planFolderTreeFor = (id: string, rootPath?: string): FolderTreeLoadPlan => {
    const entry = (rootPath ? getScanHistory(rootPath) : getAllEntries()).find((e) => e.id === id);
    const sidecarBytes = fileSizeOrNull(folderTreeSidecarPath(id));
    const heap = getHeapStatistics();
    const plan = planFolderTreeLoad({
      sidecarBytes,
      hasIndex: FS_SYNC.existsSync(indexFilePath(id)),
      filesVisited: entry?.filesVisited,
      directoriesVisited: entry?.directoriesVisited,
      heapLimitBytes: heap.heap_size_limit,
      heapUsedBytes: heap.used_heap_size,
      maxTreeHeapBytes: folderTreeMaxHeapOverride,
    });
    if (plan.mode === "memory" && sidecarBytes !== null && folderTreePagedScanIds.has(id)) {
      return { ...plan, mode: "paged", reason: `${plan.reason}, but loading it hit the heap ceiling earlier` };
    }
    return plan;
  };

  // One crash.log line per scan and mode, not one per folder click.
  const loggedFolderTreePlans = new Set<string>();
  const logFolderTreePlan = (id: string, plan: FolderTreeLoadPlan) => {
    const key = `${id}:${plan.mode}`;
    if (loggedFolderTreePlans.has(key)) return;
    loggedFolderTreePlans.add(key);
    writeCrashLog("folder-tree-plan", `scanId=${id} mode=${plan.mode}: ${plan.reason}`);
  };

  /**
   * Pre-warm only trees the plan says fit in memory. Paged and
   * unavailable scans load on the user's first Folders click instead.
   */
  const prewarmFolderTree = (id: string, rootPath: string | undefined, tag: string) => {
    const plan = planFolderTreeFor(id, rootPath);
    if (plan.mode !== "memory") {
      writeCrashLog("folder-tree-prewarm-skipped", `scanId=${id} mode=${plan.mode}: ${plan.reason}`);
      return;
    }
    void ensureFolderTree(id, rootPath, {
      skipIfMemoryPressureMb: PREWARM_RSS_CEILING_MB,
    }).catch((err) => {
      // The sidecar reader already logged why; the scan is paged now.
      if (err instanceof FolderTreeTooLargeError) return;
      writeCrashLog(tag, err instanceof Error ? (err.stack ?? err.message) : String(err));
    });
  };

  // Paged mode: each uncached folder is one streaming pass over the
  // sidecar in a worker (~5 s for a 1 GB sidecar). The pass also keeps
  // the folder's siblings and up to three levels below them (4 below
  // the parent), so going back up or across and the next few drill-ins
  // are instant. Main holds at most ~96 MB of parsed pages.
  const FOLDER_TREE_PAGE_CACHE_HEAP_BYTES = 96 * 1024 * 1024;
  const FOLDER_TREE_QUERY_MAX_DEPTH = 4;
  const FOLDER_TREE_QUERY_MAX_LINE_BYTES = 8 * 1024 * 1024;
  const folderTreeKeySeparator: "/" | "\\" = process.platform === "win32" ? "\\" : "/";
  const folderTreePages = new FolderTreePageCache(FOLDER_TREE_PAGE_CACHE_HEAP_BYTES, folderTreeKeySeparator);
  const folderTreePageInflight = new Map<string, Promise<FolderTreeSidecarQueryResult>>();

  const getPagedFolderNode = async (id: string, key: string): Promise<FolderNode> => {
    const cached = folderTreePages.lookup(id, key);
    if (cached) return cached;
    const inflightKey = `${id}\u0000${key}`;
    let pending = folderTreePageInflight.get(inflightKey);
    if (!pending) {
      const parentEnd = key.lastIndexOf(folderTreeKeySeparator);
      pending = runFolderTreeQueryWorker(
        {
          sidecarPath: folderTreeSidecarPath(id),
          targetKey: key,
          anchorKey: parentEnd >= 0 ? key.slice(0, parentEnd) : key,
          separator: folderTreeKeySeparator,
          maxDepth: FOLDER_TREE_QUERY_MAX_DEPTH,
          maxBytes: FOLDER_TREE_QUERY_MAX_LINE_BYTES,
        },
        { workerPath: folderTreeWorkerEntry },
      )
        .then((result) => {
          folderTreePages.add(id, result);
          return result;
        })
        .finally(() => {
          folderTreePageInflight.delete(inflightKey);
        });
      folderTreePageInflight.set(inflightKey, pending);
    }
    const result = await pending;
    // Another query can evict this page before we read it back.
    return folderTreePages.lookup(id, key)
      ?? result.entries.find(([entryKey]) => entryKey === key)?.[1]
      ?? EMPTY_FOLDER_NODE;
  };

  type FolderNodeLookup =
    | { node: FolderNode | null; loadMode: "memory" | "paged" }
    | { unavailableMessage: string };

  const lookupFolderNode = async (id: string, rootPath: string, key: string): Promise<FolderNodeLookup> => {
    folderTreeRootByScanId.set(id, normPath(rootPath));
    try {
      if (folderTreeCache.has(id) || folderTreeInflight.has(id)) {
        const tree = await ensureFolderTree(id, rootPath);
        return { node: tree.get(key) ?? null, loadMode: "memory" };
      }
      const plan = planFolderTreeFor(id, rootPath);
      logFolderTreePlan(id, plan);
      if (plan.mode === "unavailable") {
        return {
          unavailableMessage: FS_SYNC.existsSync(indexFilePath(id))
            ? "This scan is too big to open in Folders without its saved folder summary, and that file is missing. Rescan this drive to rebuild it."
            : "This scan's folder index is no longer on disk. Rescan this drive to browse its folders.",
        };
      }
      if (plan.mode === "memory") {
        const tree = await ensureFolderTree(id, rootPath);
        return { node: tree.get(key) ?? null, loadMode: "memory" };
      }
    } catch (err) {
      if (!(err instanceof FolderTreeTooLargeError)) throw err;
    }
    return { node: await getPagedFolderNode(id, key), loadMode: "paged" };
  };

  /**
   * Memory diagnostic summary including the caches we know can grow
   * (folder-tree parent count, treemap cache entries, full-diff memory
   * cache size). Useful for "why is DiskHound holding 800 MB?" triage.
   */
  const sampleCacheMemory = (): MemorySample => {
    const treemapStats = treemapCache.getStats();
    const pages = folderTreePages.stats();
    const mem = process.memoryUsage();
    const fullDiffEntries = fullDiffLoader.memoryEntries();
    return {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      caches: [folderTreeCache.size, folderTreeTotalEntries, pages.pages, treemapStats.entries, fullDiffEntries].join("/"),
      text: [
        describeMemoryUsage(mem),
        `folderTree: ${folderTreeCache.size} trees, ${folderTreeTotalEntries.toLocaleString()} entries`,
        `folderTreePages: ${pages.pages} pages, ${pages.nodes.toLocaleString()} nodes, ~${Math.round(pages.heapBytes / 1024 / 1024)} MB`,
        `treemapCache: ${treemapStats.entries} entries, ${treemapStats.inflight} inflight`,
        `fullDiffMem: ${fullDiffEntries} entries`,
      ].join(" | "),
    };
  };
  const describeCacheMemory = (): string => sampleCacheMemory().text;

  // Sample memory every minute while a scan is live (catches the peak
  // mid-walk) and every 5 minutes when idle, logging a sample only when
  // it moved since the last logged one, plus an hourly heartbeat. See
  // shared/memoryDiagnostics.ts.
  const memoryDiagnostics = createMemoryDiagnostics({
    sample: sampleCacheMemory,
    isScanning: () => activeScans.size > 0,
    write: writeCrashLog,
  });
  /**
   * Bump the cadence to 1 min while a scan is active and drop back to
   * 5 min when everything settles. Called from the running/done scan
   * broadcast paths so we cover both manual and scheduled scans.
   */
  const retuneMemoryDiagCadence = () => memoryDiagnostics.retune();
  // Logs one snapshot at boot for the "after restart" baseline.
  memoryDiagnostics.start();

  // Pre-warm the folder tree for the last rehydrated scan so the
  // Folders tab is instant on app launch. Fire-and-forget — the user
  // won't notice the seconds-long index read because it happens in
  // the background before they've had a chance to click the tab.
  // Only when the plan says the tree fits: loading a 995 MB sidecar
  // here aborted the app ~20 s into every launch.
  void (async () => {
    try {
      const rehydrated = await scanStore.get();
      if (!rehydrated || rehydrated.status !== "done" || !rehydrated.rootPath) return;
      const hist = getScanHistory(rehydrated.rootPath);
      const latestId = hist[0]?.id;
      if (!latestId) return;
      prewarmFolderTree(latestId, rehydrated.rootPath, "folder-tree-prewarm-boot");
    } catch (err) {
      writeCrashLog(
        "folder-tree-prewarm-boot",
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
    }
  })();

  /**
   * Build a full parent → children map by streaming the index once.
   *
   * The actual streaming + aggregation happens inside a dedicated Node
   * worker thread (src/scan/folderTreeWorker.ts) so the ~5-minute build
   * on a drive-scale scan (7M+ files) no longer blocks the main
   * thread's event loop. Before this was worker-offloaded, the per-line
   * JSON.parse + Map churn saturated the event loop hard enough that
   * setInterval heartbeats ([memory] logs) stopped firing and IPC
   * handlers stalled behind the microtask flood — the user saw the app
   * freeze for several minutes right after scan-complete with no log
   * output.
   *
   * The worker returns a serialized [key, node] array over postMessage;
   * we wrap it back into a FolderTree Map on receipt. Tree shape is
   * unchanged so every downstream consumer (IPC handlers, sidecar
   * writer, cache eviction) keeps working without edits.
   */
  async function buildFolderTree(indexPathStr: string): Promise<FolderTree> {
    // This is the FALLBACK path — ensureFolderTree above calls
    // readFolderTreeSidecar first, so we only get here when the
    // scanner didn't emit a sidecar OR the sidecar was deleted. The
    // worker streams the NDJSON index from scratch; ~5-15 s on a
    // drive-scale scan.
    const serialized = await runFolderTreeWorker(
      { indexPath: indexPathStr },
      { workerPath: folderTreeWorkerEntry },
    );
    const tree: FolderTree = new Map();
    for (const [key, node] of serialized) {
      tree.set(key, node);
    }
    return tree;
  }

  const getFolderChildrenImpl = async (rootPath: string, parentPath: string) => {
      const history = getScanHistory(rootPath);
      const currentId = history[0]?.id;
      const empty = {
        dirs: [],
        files: [],
        totalSize: 0,
        totalItemCount: 0,
        hiddenExcludedCount: 0,
        hiddenExcludedBytes: 0,
      };
      if (!currentId) return empty;

      try {
        const normalizedParent = normPath(parentPath).replace(/[\\/]+$/, "");
        const lookup = await lookupFolderNode(currentId, rootPath, normalizedParent);
        if ("unavailableMessage" in lookup) {
          return { ...empty, unavailableMessage: lookup.unavailableMessage };
        }
        const { node, loadMode } = lookup;
        if (!node) return { ...empty, loadMode };
        // Expand the compact in-cache file shape into the full
        // ScanFileRecord the renderer expects. Done on the way out
        // because the cache holds 1M+ parent entries and duplicating
        // name/parentPath/extension per file would burn hundreds of
        // MB of heap for no runtime benefit. The cache stores filenames
        // only — we pass `normalizedParent` so the full path can be
        // reconstructed for the renderer.
        const files = node.files.map((f) => makeFolderFileRecord(normalizedParent, f));
        const totalSize =
          node.dirs.reduce((sum, dir) => sum + dir.size, 0) +
          files.reduce((sum, file) => sum + file.size, 0);
        const settings = settingsStore?.get();
        const hideExcluded = Boolean(settings?.scanning.hideExcludedFoldersFromFolderResults);
        const excludedFolders = settings?.scanning.excludedFolderPaths ?? [];
        const visibleDirs = hideExcluded
          ? node.dirs.filter((dir) => !isHiddenExcludedPath(dir.path, excludedFolders, process.platform))
          : node.dirs;
        const visibleFiles = hideExcluded
          ? files.filter((file) => !isHiddenExcludedPath(file.path, excludedFolders, process.platform))
          : files;
        const visibleSize =
          visibleDirs.reduce((sum, dir) => sum + dir.size, 0) +
          visibleFiles.reduce((sum, file) => sum + file.size, 0);
        // The native sidecar doesn't cap child dirs per folder, and one
        // folder can have tens of thousands. The renderer draws 200, so
        // send the largest FOLDER_CHILDREN_MAX_DIRS and the count.
        const sentDirs = visibleDirs.length > FOLDER_CHILDREN_MAX_DIRS
          ? [...visibleDirs].sort((a, b) => b.size - a.size).slice(0, FOLDER_CHILDREN_MAX_DIRS)
          : visibleDirs;
        return {
          dirs: sentDirs,
          visibleDirCount: visibleDirs.length,
          loadMode,
          files: visibleFiles,
          totalSize,
          totalItemCount: node.dirs.length + files.length,
          hiddenExcludedCount: (node.dirs.length - visibleDirs.length) + (files.length - visibleFiles.length),
          hiddenExcludedBytes: Math.max(0, totalSize - visibleSize),
        };
      } catch (err) {
        writeCrashLog(
          "folder-tree",
          err instanceof Error ? (err.stack ?? err.message) : String(err),
        );
        return empty;
      }
  };
  ipcMain.handle(
    "diskhound:get-folder-children",
    (_event, rootPath: string, parentPath: string) => getFolderChildrenImpl(rootPath, parentPath),
  );

  ipcMain.handle("diskhound:get-latest-diff", async (_event, rootPath: string) => {
    const pair = getLatestPair(rootPath);
    if (!pair) return null;
    const [baseline, current] = await Promise.all([
      loadHistoricalSnapshotCached(pair.baseline.id),
      loadHistoricalSnapshotCached(pair.current.id),
    ]);
    if (!baseline || !current) return null;
    return computeDiff(baseline, current, pair.baseline.id, pair.current.id);
  });

  // ── IPC: Monitoring ───────────────────────────────────────

  ipcMain.handle("diskhound:get-monitoring-snapshot", () => getMonitoringSnapshot());
  ipcMain.handle("diskhound:get-disk-delta-history", () => getDiskDeltaHistory());
  ipcMain.handle("diskhound:get-scan-schedule-info", () => {
    const settings = settingsStore?.get();
    const lastScan = getLastFullScanAt();
    const intervalMin = settings?.monitoring.fullScanIntervalMinutes ?? 0;
    const enabled = Boolean(settings?.monitoring.enabled);
    const nextScanAt =
      enabled && intervalMin > 0 && lastScan !== null
        ? lastScan + intervalMin * 60_000
        : null;
    return {
      enabled,
      intervalMinutes: intervalMin,
      lastScanAt: lastScan,
      nextScanAt,
      defaultRootPath: settings?.scanning.defaultRootPath ?? "",
    };
  });
  ipcMain.handle("diskhound:get-disk-space", () => getDiskSpace());

  // ── IPC: Cleanup Analysis ─────────────────────────────────

  const analyzeCleanupImpl = async (rootPath: string) => {
    const history = getScanHistory(rootPath);
    const current = history[0];
    const settings = settingsStore!.get();
    if (!current) {
      return {
        suggestions: [],
        totalReclaimableBytes: 0,
        analyzedAt: Date.now(),
        scanRootPath: rootPath,
      };
    }
    return analyzeCleanupFromIndex(
      rootPath,
      indexFilePath(current.id),
      settings.cleanup,
      settings.scanning.excludedFolderPaths,
    );
  };
  ipcMain.handle("diskhound:analyze-cleanup", (_event, rootPath: string) => analyzeCleanupImpl(rootPath));
  const searchIndexImpl = async (rootPath: string, query: IndexSearchQuery) => {
    const history = getScanHistory(rootPath);
    const current = history[0];
    if (!current) return { hits: [], truncated: false, filesScanned: 0 };
    return searchIndexFile(indexFilePath(current.id), query);
  };
  ipcMain.handle("diskhound:search-index", (_event, rootPath: string, query: IndexSearchQuery) =>
    searchIndexImpl(rootPath, query),
  );
  const devArtifactCache = new Map<string, DevArtifactReport>();
  const devArtifactInflight = new Map<string, Promise<DevArtifactReport | null>>();
  const devRescanAbort = new Map<string, AbortController>();

  const loadDevReport = (scanId: string, scanRoot: string, previousId?: string) =>
    loadDevArtifactReport(
      devArtifactsSidecarPath(scanId),
      scanRoot,
      listPendingDevArtifactSidecars(),
      previousId ? devArtifactsSidecarPath(previousId) : null,
    );

  const getDevArtifactsImpl = async (
    rootPath: string,
    options?: { sidecarOnly?: boolean },
  ): Promise<DevArtifactReport | null> => {
    const history = getScanHistory(rootPath);
    const current = history[0];
    if (!current) return null;
    const cached = devArtifactCache.get(current.id);
    if (cached) return cached;

    const loadKey = `${current.id}:load`;
    let loadPromise = devArtifactInflight.get(loadKey);
    if (!loadPromise) {
      loadPromise = loadDevReport(current.id, rootPath, history[1]?.id)
        .then((report) => {
          if (report && report.artifacts.length > 0) devArtifactCache.set(current.id, report);
          return report;
        })
        .catch((err) => {
          writeCrashLog(
            "dev-artifacts",
            err instanceof Error ? (err.stack ?? err.message) : String(err),
          );
          if (FS_SYNC.existsSync(devArtifactsSidecarPath(current.id))) throw err;
          return null;
        })
        .finally(() => {
          devArtifactInflight.delete(loadKey);
        });
      devArtifactInflight.set(loadKey, loadPromise);
    }
    if (options?.sidecarOnly) return loadPromise;

    const inflight = devArtifactInflight.get(current.id);
    if (inflight) return inflight;

    const pending = (async () => {
      const report = await loadPromise;
      if (report) return report;

      const sidecarPath = devArtifactsSidecarPath(current.id);
      if (FS_SYNC.existsSync(sidecarPath)) {
        writeCrashLog(
          "dev-artifacts",
          `scanId=${current.id} sidecar present but load returned empty; not classifying the folder tree`,
        );
        throw new Error(`Dev Artifacts sidecar exists but could not be read: ${Path.basename(sidecarPath)}`);
      }

      // Old scans have no Dev sidecar. Classify from the folder-tree
      // sidecar in a worker — never stream the 7M-file index, and
      // never walk 1M+ folder-tree entries on the main thread.
      const treePath = folderTreeSidecarPath(current.id);
      if (!FS_SYNC.existsSync(treePath)) return null;

      writeCrashLog("dev-artifacts-classify", `scanId=${current.id} via folder-tree worker`);
      const classified = await runDevArtifactsClassifyWorker(
        {
          rootPath,
          folderTreePath: treePath,
          destSidecarPath: devArtifactsSidecarPath(current.id),
          previousSidecarPath: history[1] ? devArtifactsSidecarPath(history[1].id) : null,
        },
        { workerPath: devArtifactsWorkerEntry },
      );
      if (classified.artifacts.length > 0) devArtifactCache.set(current.id, classified);
      return classified;
    })().catch((err) => {
      writeCrashLog(
        "dev-artifacts",
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
      return null;
    }).finally(() => {
      devArtifactInflight.delete(current.id);
    });
    devArtifactInflight.set(current.id, pending);
    return pending;
  };
  ipcMain.handle("diskhound:get-dev-artifacts", (_event, rootPath: string, options?: { sidecarOnly?: boolean }) =>
    getDevArtifactsImpl(rootPath, options),
  );

  ipcMain.handle("diskhound:cancel-dev-artifacts-rescan", (_event, rootPath: string) => {
    const key = scanKey(rootPath);
    const ac = devRescanAbort.get(key);
    if (ac) ac.abort();
  });

  ipcMain.handle("diskhound:forget-dev-artifact-paths", async (_event, rootPath: string, paths: unknown) => {
    const list = Array.isArray(paths)
      ? paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0)
      : [];
    const history = getScanHistory(rootPath);
    const current = history[0];
    if (!current) return null;

    const sidecarPath = devArtifactsSidecarPath(current.id);
    const cached = devArtifactCache.get(current.id);
    const sidecar = (await readDevArtifactSidecar(sidecarPath))
      ?? (cached ? sidecarFromReport(cached) : null);
    if (!sidecar) {
      writeCrashLog("dev-artifacts", `forget: no sidecar scanId=${current.id} paths=${list.length}`);
      if (!cached || list.length === 0) return cached ?? null;
      const next = dropArtifactsFromReport(cached, list);
      if (next.artifacts.length > 0) devArtifactCache.set(current.id, next);
      else devArtifactCache.delete(current.id);
      return next;
    }

    const nextSidecar = list.length > 0 ? dropSidecarRoots(sidecar, list) : sidecar;
    try {
      await writeDevArtifactSidecar(sidecarPath, nextSidecar);
    } catch (err) {
      writeCrashLog(
        "dev-artifacts",
        `forget write failed scanId=${current.id} ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const previous = history[1] ? await readDevArtifactSidecar(devArtifactsSidecarPath(history[1].id)) : null;
    const report = reportFromSidecar(nextSidecar, previous);
    if (report.artifacts.length > 0) devArtifactCache.set(current.id, report);
    else devArtifactCache.delete(current.id);
    writeCrashLog("dev-artifacts", `forgot ${list.length} tree(s) scanId=${current.id}`);
    return report;
  });

  ipcMain.handle("diskhound:rescan-dev-artifacts", async (_event, rootPath: string) => {
    const history = getScanHistory(rootPath);
    const current = history[0];
    if (!current) return null;
    const key = scanKey(rootPath);
    devRescanAbort.get(key)?.abort();
    const ac = new AbortController();
    devRescanAbort.set(key, ac);
    try {
      const report = await runDevArtifactsRescanWorker(
        {
          rootPath,
          sidecarPath: devArtifactsSidecarPath(current.id),
          indexPath: indexFilePath(current.id),
        },
        {
          workerPath: devArtifactsWorkerEntry,
          signal: ac.signal,
          onProgress: (progress) => {
            mainWindow?.webContents.send(DEV_ARTIFACTS_PROGRESS_CHANNEL, {
              ...progress,
              rootPath,
            });
          },
        },
      );
      const latest = getScanHistory(rootPath)[0];
      if (latest && latest.id !== current.id) {
        const adopted = await loadDevReport(latest.id, rootPath, getScanHistory(rootPath)[1]?.id);
        if (adopted && adopted.artifacts.length > 0) {
          devArtifactCache.set(latest.id, adopted);
          return adopted;
        }
      }
      if (report.artifacts.length > 0) devArtifactCache.set(current.id, report);
      else devArtifactCache.delete(current.id);
      return report;
    } catch (err) {
      if (ac.signal.aborted) return null;
      writeCrashLog(
        "dev-artifacts-rescan",
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
      return null;
    } finally {
      if (devRescanAbort.get(key) === ac) devRescanAbort.delete(key);
    }
  });

  // ── IPC: Duplicate Detection ────────────────────────────

  // Latest duplicate progress / result per root, kept so MCP agents can
  // read them — the renderer keeps its own copies from the broadcasts.
  const duplicateProgressByKey = new Map<string, DuplicateScanProgress>();
  const duplicateResultByKey = new Map<string, DuplicateAnalysis>();
  const startDuplicateScanImpl = (rootPath: string, options?: { minSizeBytes?: number }) => {
    // Whole-handler try/catch — main-process IPC handlers that throw
    // synchronously surface as the "DiskHound — Unexpected error"
    // dialog via the uncaughtException hook. Belt-and-suspenders.
    try {
    const resolvedRoot = Path.resolve(rootPath);
    const key = scanKey(resolvedRoot);

    // Only cancel an existing scan for THIS root. Scans on other drives
    // keep running — parallel duplicate detection was one of the major
    // asks in v0.3.1.
    const existing = activeDuplicateScans.get(key);
    if (existing) {
      // v0.5.35: log this. A user's v0.5.34 log showed 23k silent nulls
      // — one hypothesis is that the renderer double-fires the start IPC
      // (e.g. effect re-runs on snapshot.status changes that race with
      // the click handler), and the second invocation cancels the first
      // mid-Pass-A. The cancelled first scan's worker pool then
      // short-circuits to null without logging, while the second scan
      // runs normally. This log line lets us see if that's happening.
      writeCrashLog(
        "dup-scan-existing-cancelled",
        `root=${resolvedRoot} — a new start-duplicate-scan IPC arrived while a previous scan was still running; cancelling the previous one`,
      );
      try { existing.cancel(); } catch { /* runDuplicateScan's cancel already self-wraps; defense in depth */ }
      activeDuplicateScans.delete(key);
    }
    writeCrashLog(
      "dup-scan-start",
      `root=${resolvedRoot}`,
    );

    // Try to find an existing scan index whose root is an ancestor of the
    // duplicates scope — streaming that index is much faster and lower
    // memory than re-walking the filesystem. Fall back to walk if no
    // suitable index exists or if the path isn't under any known scan.
    const indexPath = findIndexCoveringPath(resolvedRoot);
    duplicateResultByKey.delete(key);
    duplicateProgressByKey.delete(key);

    const handle = runDuplicateScan(
      resolvedRoot,
      {
        onProgress: (progress) => {
          // Tag every progress emission with the rootPath so the
          // renderer can route it to the right per-drive state slot.
          const tagged = { ...progress, rootPath: resolvedRoot };
          duplicateProgressByKey.set(key, { ...tagged, newGroups: undefined });
          mainWindow?.webContents.send(DUPLICATE_PROGRESS_CHANNEL, tagged);
        },
        onResult: (result) => {
          duplicateResultByKey.set(key, result);
          mainWindow?.webContents.send(DUPLICATE_RESULT_CHANNEL, result);
          activeDuplicateScans.delete(key);
          sendToast("success", "Duplicate scan complete",
            `Found ${result.totalGroups} group${result.totalGroups === 1 ? "" : "s"} in ${resolvedRoot}, ${formatBytesShort(result.totalWastedBytes)} reclaimable.`);
        },
        onError: (error) => {
          // ALSO log to crash.log so the failure is visible in the
          // Settings → Crash log viewer. Without this, a duplicate
          // scan that rejected from run() showed up only as a
          // status: "error" progress event in the renderer — which
          // the UI doesn't display anywhere — leaving the user with
          // a silent reset to the pre-scan empty state and no way
          // to see the actual error.
          writeCrashLog(
            "dup-scan-error",
            `root=${resolvedRoot} error=${error.stack ?? error.message ?? String(error)}`,
          );
          const errorProgress: DuplicateScanProgress = {
            rootPath: resolvedRoot,
            status: "error",
            filesWalked: 0,
            candidateGroups: 0,
            filesHashed: 0,
            groupsConfirmed: 0,
            elapsedMs: 0,
            errorMessage: error.message,
          };
          duplicateProgressByKey.set(key, errorProgress);
          mainWindow?.webContents.send(DUPLICATE_PROGRESS_CHANNEL, errorProgress);
          activeDuplicateScans.delete(key);
        },
      },
      {
        indexPath,
        minSizeBytes: options?.minSizeBytes,
        // Enable the persistent hash cache so repeat duplicate scans
        // on the same drive skip re-hashing unchanged files. The
        // first scan on a drive pays the full 30-60 minute hashing
        // cost; subsequent scans reuse cached hashes by
        // (path, size, mtime) and finish in seconds for unchanged
        // files.
        cacheDir: app.getPath("userData"),
        // v0.5.38: pipe through the user-configured Hash Depth setting.
        // 100 = scan every candidate bucket (default, unchanged
        // behavior). <100 = top-N% only, sorted by potential waste —
        // dramatically faster on big drives at the cost of recall in
        // the long tail of small duplicate groups.
        hashDepthPercent: settingsStore?.get().storage.duplicateHashDepthPercent ?? 100,
      },
    );
    activeDuplicateScans.set(key, handle);
    } catch (err) {
      // Surface to the renderer as an error progress event instead of
      // an uncaught exception dialog. The user sees a meaningful UI
      // state rather than a generic crash.
      const msg = err instanceof Error ? err.message : String(err);
      writeCrashLog("start-duplicate-scan", msg);
      try {
        mainWindow?.webContents.send(DUPLICATE_PROGRESS_CHANNEL, {
          rootPath,
          status: "error",
          filesWalked: 0,
          candidateGroups: 0,
          filesHashed: 0,
          groupsConfirmed: 0,
          elapsedMs: 0,
          errorMessage: `Failed to start duplicate scan: ${msg}`,
        });
      } catch { /* ignore */ }
    }
  };
  ipcMain.handle("diskhound:start-duplicate-scan", (_event, rootPath: string, options?: { minSizeBytes?: number }) =>
    startDuplicateScanImpl(rootPath, options),
  );

  /**
   * Search the scan-history index for the most recent scan whose root
   * is either equal to or an ancestor of `path`. Returns the absolute
   * path to that scan's gzipped NDJSON, or null if no match.
   *
   * We prefer shorter (more ancestral) roots when multiple cover the
   * target, because those indexes contain the fullest dataset. For the
   * common case where a user scans `C:\` then runs duplicates on
   * `C:\Users\foo`, this finds the `C:\` index correctly.
   */
  function findIndexCoveringPath(path: string): string | null {
    // Platform-aware: normPath lowercases only on Windows. On Linux /
    // macOS case-sensitive volumes, "/home/Alice" and "/home/alice" are
    // genuinely distinct roots; unconditional lowercase used to falsely
    // match them, causing the duplicates scan to stream the wrong
    // index.
    const normalizedTarget = normPath(Path.resolve(path));
    // Walk ALL known history entries (not just settings.recentScans —
    // a user reported the duplicates view briefly flashing "no index"
    // even though they had history. Root cause: settings.recentScans
    // was empty but scan-history had entries. recentScans is populated
    // when the user picks a drive; it can drift out of sync with the
    // scan-history index if settings got reset or the user added scans
    // via the IPC without picker round-trip). Iterate the actual scan
    // history's entries and pick the best (shortest root that still
    // covers the target, most recently scanned among those).
    let best: { id: string; rootLen: number; scannedAt: number } | null = null;
    for (const entry of getAllEntries()) {
      const normalizedRoot = normPath(Path.resolve(entry.rootPath));
      const isUnder = normalizedTarget === normalizedRoot ||
        normalizedTarget.startsWith(normalizedRoot + Path.sep) ||
        normalizedTarget.startsWith(normalizedRoot + "/");
      if (!isUnder) continue;
      const candidate = indexFilePath(entry.id);
      if (!FS_SYNC.existsSync(candidate)) continue;
      // Prefer shorter root. Among equal lengths, most recent wins.
      if (
        !best ||
        normalizedRoot.length < best.rootLen ||
        (normalizedRoot.length === best.rootLen && entry.scannedAt > best.scannedAt)
      ) {
        best = { id: entry.id, rootLen: normalizedRoot.length, scannedAt: entry.scannedAt };
      }
    }
    return best ? indexFilePath(best.id) : null;
  }

  ipcMain.handle("diskhound:cancel-duplicate-scan", (_event, rootPath?: string) => {
    try {
      if (rootPath) {
        const key = scanKey(Path.resolve(rootPath));
        const handle = activeDuplicateScans.get(key);
        // v0.5.35: log every cancel so we can correlate with the
        // null-path counters in pass-a-null-paths. A cancel arriving
        // during Pass A explains workerCancelAtTop / cancelAtTop /
        // silentCancel* spiking.
        writeCrashLog(
          "dup-scan-cancel-request",
          `root=${rootPath} resolved=${Path.resolve(rootPath)} hasActiveHandle=${!!handle}`,
        );
        if (handle) {
          try { handle.cancel(); } catch { /* defensive */ }
          activeDuplicateScans.delete(key);
        }
        return;
      }
      // No rootPath → cancel all (e.g. app quit, or renderer asking for a full stop).
      writeCrashLog(
        "dup-scan-cancel-all",
        `active=${activeDuplicateScans.size}`,
      );
      for (const handle of activeDuplicateScans.values()) {
        try { handle.cancel(); } catch { /* defensive */ }
      }
      activeDuplicateScans.clear();
    } catch (err) {
      writeCrashLog("cancel-duplicate-scan", err instanceof Error ? err.stack ?? err.message : String(err));
    }
  });

  ipcMain.handle("diskhound:get-active-duplicate-scan-roots", () => {
    // Return the rootPaths (original casing) the renderer originally
    // passed in. Since we key by normPath(), we can't recover original
    // casing reliably — return the normalized keys, which matches how
    // the renderer normalizes them internally.
    return Array.from(activeDuplicateScans.keys());
  });

  /**
   * Does a scan-index file exist for the given path? Used by the
   * DuplicatesView to warn the user UPFRONT (before they click Scan)
   * that without an index, the duplicate scan will walk the live
   * filesystem (slow on big drives — 10-60 min for 1 M+ files vs.
   * 5 sec for the index path).
   */
  ipcMain.handle("diskhound:has-scan-index-for-path", (_event, rootPath: string) => {
    try {
      const resolved = Path.resolve(rootPath);
      return findIndexCoveringPath(resolved) !== null;
    } catch {
      return false;
    }
  });

  // ── IPC: Storage management ───────────────────────────────
  //
  // Surfaces disk-usage stats for the Settings → Storage panel and
  // provides the "Clear all scan history" action. Scan indexes are
  // the biggest single chunk of DiskHound's own footprint — a 7M-file
  // drive produces ~330 MB per scan + ~50 MB per folder-tree sidecar,
  // so 20 scans of history was silently using 7 GB+ of disk before
  // v0.5.24 reduced the default to 7.

  ipcMain.handle("diskhound:get-storage-stats", async () => {
    const userData = app.getPath("userData");
    const indexesDir = Path.join(userData, "scan-indexes");
    const historyDir = Path.join(userData, "scan-history");
    const diffCacheDir = Path.join(userData, "full-diff-cache");

    const sumDir = async (dir: string): Promise<{ bytes: number; count: number; orphanPending: { bytes: number; count: number } }> => {
      let bytes = 0;
      let count = 0;
      let orphanBytes = 0;
      let orphanCount = 0;
      let entries: FS_SYNC.Dirent[] = [];
      try {
        entries = await FS.readdir(dir, { withFileTypes: true });
      } catch { return { bytes, count, orphanPending: { bytes: orphanBytes, count: orphanCount } }; }
      const orphanCutoff = Date.now() - 60 * 60 * 1000; // 1 hour
      // USN rescans hard-link their predecessor's sidecars, so one set
      // of bytes can have several names here. Count it once.
      const seenLinks = new Set<string>();
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = Path.join(dir, entry.name);
        try {
          const stat = await FS.stat(full);
          count++;
          if (stat.nlink > 1) {
            const inode = `${stat.dev}:${stat.ino}`;
            if (seenLinks.has(inode)) continue;
            seenLinks.add(inode);
          }
          bytes += stat.size;
          if (entry.name.startsWith("pending-") && stat.mtimeMs < orphanCutoff) {
            orphanBytes += stat.size;
            orphanCount++;
          }
        } catch { /* skipped */ }
      }
      return { bytes, count, orphanPending: { bytes: orphanBytes, count: orphanCount } };
    };

    const [indexes, history, diffCache] = await Promise.all([
      sumDir(indexesDir),
      sumDir(historyDir),
      sumDir(diffCacheDir),
    ]);
    return {
      totalIndexBytes: indexes.bytes,
      totalHistoryBytes: history.bytes,
      totalDiffCacheBytes: diffCache.bytes,
      fileCount: indexes.count + history.count + diffCache.count,
      orphanPendingCount: indexes.orphanPending.count,
      orphanPendingBytes: indexes.orphanPending.bytes,
    };
  });

  /**
   * Wipe every scan-history snapshot, every scan-indexes file
   * (including orphan pending-* files), and the full-diff-cache.
   * Resets the Changes tab to "no previous scan to compare" until
   * the next scan completes. Returns counts of what was removed so
   * the UI can show a confirmation toast.
   */
  ipcMain.handle("diskhound:clear-scan-history", async () => {
    const userData = app.getPath("userData");

    // Step 1: collect IDs before clearing. clearAllHistory() deletes
    // the per-snapshot JSON files but doesn't know about the
    // index/sidecar/diff-cache companions. We delete those by ID
    // afterwards.
    const allEntries = getAllEntries();
    const knownIds = allEntries.map((e) => e.id);

    // Step 2: clear history (removes snapshot-*.json files and the
    // in-memory index).
    clearAllHistory();

    // Step 3: drop each scan's index + sidecar + full-diff-cache
    // entries via the existing per-scan cleanup helpers.
    for (const id of knownIds) {
      try { treemapCache.invalidateScan(id); } catch { /* ok */ }
      try { invalidateFolderTree(id); } catch { /* ok */ }
      try { await deleteFolderTreeSidecar(id); } catch { /* ok */ }
      try { await deleteIndex(id); } catch { /* ok */ }
      try { deleteFullDiffCachesForScan(id); } catch { /* ok */ }
    }

    // Step 4: nuke EVERY file in scan-indexes/ as a belt-and-suspenders
    // pass. This catches orphan pending-* files and any sidecar that
    // got out of sync with the history index. The directories
    // themselves stay so the next scan doesn't have to recreate them.
    const sweepDir = async (dir: string): Promise<number> => {
      let removed = 0;
      try {
        const entries = await FS.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          // Preserve the scan-history index file — clearAllHistory()
          // already truncated it but the file should exist.
          if (entry.name === "scan-history-index.json") continue;
          try {
            await FS.unlink(Path.join(dir, entry.name));
            removed++;
          } catch { /* skip */ }
        }
      } catch { /* directory missing */ }
      return removed;
    };

    const sweepCounts = await Promise.all([
      sweepDir(Path.join(userData, "scan-indexes")),
      sweepDir(Path.join(userData, "scan-history")),
      sweepDir(Path.join(userData, "full-diff-cache")),
    ]);

    return {
      removedHistoryIds: knownIds.length,
      removedFiles: sweepCounts.reduce((a, b) => a + b, 0),
    };
  });

  /**
   * Just the orphan pending-* sweep — runs at startup (via the
   * Settings panel can also trigger manually if we surface it).
   * Pending files older than 1 hour are leftovers from crashed
   * scans that should never be referenced again.
   */
  ipcMain.handle("diskhound:cleanup-orphan-pending", async () => {
    const indexesDir = Path.join(app.getPath("userData"), "scan-indexes");
    let removed = 0;
    let bytesFreed = 0;
    const orphanCutoff = Date.now() - 60 * 60 * 1000; // 1 hour
    try {
      const entries = await FS.readdir(indexesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.startsWith("pending-")) continue;
        const full = Path.join(indexesDir, entry.name);
        try {
          const stat = await FS.stat(full);
          if (stat.mtimeMs >= orphanCutoff) continue;
          await FS.unlink(full);
          removed++;
          bytesFreed += stat.size;
        } catch { /* skip */ }
      }
    } catch { /* directory missing */ }
    if (removed > 0) {
      writeCrashLog("storage-cleanup", `pruned ${removed} orphan pending-* files, freed ${bytesFreed} bytes`);
    }
    return { removed, bytesFreed };
  });

  // ── IPC: Tray ─────────────────────────────────────────────

  ipcMain.on("diskhound:apply-theme", (_event, theme: "dark" | "light") => {
    if (!mainWindow) return;
    const isDark = theme === "dark";
    mainWindow.setBackgroundColor(isDark ? "#0a0a0f" : "#f8fafc");
    // Windows and Linux draw caption buttons via titleBarOverlay.
    // macOS uses traffic lights; BrowserWindow.setTitleBarOverlay is
    // not a function there, and calling it throws the startup dialog.
    if (process.platform !== "darwin" && typeof mainWindow.setTitleBarOverlay === "function") {
      mainWindow.setTitleBarOverlay({
        color: isDark ? "#0a0a0f" : "#f8fafc",
        symbolColor: isDark ? "#94a3b8" : "#475569",
      });
    }
  });

  ipcMain.on("diskhound:minimize-to-tray", () => {
    mainWindow?.hide();
  });

  ipcMain.on("diskhound:quit-app", () => {
    quitDiskHound();
  });

  // ── Login Item Settings ───────────────────────────────────

  function applyLoginItemSettings(enabled: boolean) {
    try {
      // `--autostart` signals "the OS auto-launched us at login" — only
      // then does startMinimized take effect. Manual launches, post-
      // install launches (NSIS "Finish"), and post-update restarts all
      // come without this flag and therefore always show the window.
      //
      // Old flag name `--start-minimized` is still accepted at parse
      // time so existing login-item entries from <= v0.2.15 keep
      // working until applyLoginItemSettings() runs again and rewrites
      // them.
      app.setLoginItemSettings({
        openAtLogin: enabled,
        args: enabled ? ["--autostart"] : [],
      });
    } catch {
      // Not supported on all platforms
    }
  }

  // ── Monitoring Loop ───────────────────────────────────────

  const restartMonitoring = (settings: AppSettings) => {
    if (monitoringInterval) {
      clearInterval(monitoringInterval);
      monitoringInterval = null;
    }

    const onChecked = async (snapshot: MonitoringSnapshot) => {
      const excludedSet = new Set(
        (settings.monitoring.excludedDrives ?? []).map((d) => d.toUpperCase()),
      );
      for (const delta of snapshot.deltas) {
        // Respect per-drive opt-out — users can exclude specific drives
        // (backup disks, network shares, etc.) from alerts while keeping
        // monitoring globally enabled. We still emit the raw delta to
        // the renderer so the free-space gauge at the top stays accurate;
        // we just suppress the toast/system notification.
        const isExcluded = excludedSet.has(delta.drive.toUpperCase());
        if (!isExcluded) {
          mainWindow?.webContents.send(DISK_DELTA_CHANNEL, delta);
        }

        // Only alert on free-space DECREASES (negative deltaBytes)
        if (delta.deltaBytes >= 0) continue; // Space increased — not actionable
        if (isExcluded) continue;

        const decrease = Math.abs(delta.deltaBytes);
        const decreasePct = Math.abs(delta.deltaPercent);
        const shouldAlert =
          decrease >= settings.monitoring.alertThresholdBytes ||
          decreasePct >= settings.monitoring.alertThresholdPercent;

        if (shouldAlert && settings.notifications.deltaAlerts) {
          sendToast("warning", "Free space decreased",
            `${delta.drive}: lost ${formatBytesShort(decrease)} since last check.`);

          if (Notification.isSupported() && !mainWindow?.isVisible()) {
            new Notification({
              title: "DiskHound - Free Space Decreased",
              body: `${delta.drive}: lost ${formatBytesShort(decrease)}.`,
            }).show();
          }
        }
      }

      // Scheduled rescan if interval has elapsed. Phase 2b adds an
      // incremental-first path: if we have a valid USN cursor for the
      // root's volume, try reading the journal before spinning up a full
      // scan. If incremental fails for any reason, fall through to full.
      if (settings.monitoring.fullScanIntervalMinutes > 0) {
        const lastScan = getLastFullScanAt();
        const intervalMs = settings.monitoring.fullScanIntervalMinutes * 60_000;
        const now = Date.now();

        if (lastScan === null || now - lastScan >= intervalMs) {
          const defaultPath = settings.scanning.defaultRootPath;
          const alreadyScanning = defaultPath
            ? activeScans.has(scanKey(Path.resolve(defaultPath)))
            : false;
          if (defaultPath && !alreadyScanning) {
            const incrementalWorked = await tryIncrementalScan(defaultPath);
            if (!incrementalWorked) {
              void startScan(defaultPath, defaultScanOptions(), "scheduled");
              const intervalLabel = formatScanIntervalLabel(settings.monitoring.fullScanIntervalMinutes);
              sendToast("info", "Scheduled rescan started",
                `Rescanning ${defaultPath} after ${intervalLabel} interval.`);
            }
          }
        }
      }
    };

    monitoringInterval = startDiskMonitoring(settings.monitoring, {
      systemIdleSeconds: () => powerMonitor.getSystemIdleTime(),
      onChecked,
    });
  };

  /**
   * Attempt an incremental (USN-journal) rescan. Returns true if it
   * succeeded and a new snapshot was broadcast — caller skips the full
   * rescan. Returns false if we couldn't run incremental (no cursor, no
   * binary, parse error, wrap, etc), in which case caller does full.
   */
  const tryIncrementalScan = async (rootPath: string): Promise<boolean> => {
    const outcome = await runIncrementalRescan(rootPath, {
      scannerPath: resolveNativeScannerBinary(projectRoot),
      publishSnapshot: broadcastSnapshot,
      markFullScan,
      loadSnapshot: loadHistoricalSnapshotCached,
      warmFullDiff: warmLatestFullDiff,
      onCommitted: afterScanCommitted,
      onPruned: forgetPrunedScan,
      log: writeCrashLog,
    });
    if (!outcome) return false;
    const result = outcome;

    // Always surface the delta scan result — "no changes" is itself a
    // signal users want to see ("my monitoring is working"). Without
    // this toast a silent zero-change delta is indistinguishable from
    // monitoring being broken.
    if (settings.notifications.scanComplete) {
      const { additions, modifications, deletions, elapsedMs } = result.stats;
      const totalChanges = additions + modifications + deletions;
      if (totalChanges > 0) {
        sendToast("info", "Delta scan · changes detected",
          `${totalChanges} change(s) in ${elapsedMs}ms: +${additions} / ~${modifications} / -${deletions}`);
      } else {
        sendToast("info", "Delta scan · no changes",
          `Checked ${rootPath} in ${elapsedMs}ms via the NTFS journal.`);
      }
    }
    // Stderr log as a fallback observability hook — the user can tail
    // the Electron console to confirm deltas are firing, even when
    // toasts are disabled or off-screen.
    console.error(
      `[monitoring] delta scan for ${rootPath}: ` +
      `+${result.stats.additions}/~${result.stats.modifications}/-${result.stats.deletions} ` +
      `(${result.stats.elapsedMs}ms, ${result.stats.recordsRead} journal records)`,
    );

    return true;
  };

  // ── Application menu ──────────────────────────────────────
  // Hidden title bar on Windows/Linux hides File/Edit chrome, but the
  // menu still owns accelerators. Ctrl/Cmd+Q must quit — not hide to
  // tray via window close.

  const installApplicationMenu = () => {
    const quitItem: MenuItemConstructorOptions = {
      label: "Quit DiskHound",
      accelerator: "CommandOrControl+Q",
      click: () => {
        quitDiskHound();
      },
    };
    const template: MenuItemConstructorOptions[] = process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              quitItem,
            ],
          },
          { role: "fileMenu" },
          { role: "editMenu" },
        ]
      : [
          { label: "File", submenu: [quitItem] },
          { role: "editMenu" },
        ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };

  // ── System Tray ───────────────────────────────────────────

  const createTray = () => {
    const icon = createTrayIconImage();
    tray = new Tray(icon);
    tray.setToolTip("DiskHound");

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Show DiskHound",
        click: () => {
          focusOrShowMainWindow();
        },
      },
      { type: "separator" },
      {
        label: "Quick Scan",
        click: () => {
          const settings = settingsStore?.get();
          if (settings?.scanning.defaultRootPath) {
            void startScan(settings.scanning.defaultRootPath, defaultScanOptions());
          }
          focusOrShowMainWindow();
        },
      },
      {
        label: "Open System Widget",
        click: () => {
          void createSystemWidgetWindow();
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        accelerator: "CommandOrControl+Q",
        click: () => {
          quitDiskHound();
        },
      },
    ]);

    tray.setContextMenu(contextMenu);
    tray.on("double-click", () => {
      focusOrShowMainWindow();
    });
  };

  // ── Window ────────────────────────────────────────────────

  const loadRenderer = async (window: BrowserWindow, mode: "app" | "widget" | "consent") => {
    if (rendererEntryUrl) {
      const url = mode === "app"
        ? rendererEntryUrl
        : `${rendererEntryUrl}${rendererEntryUrl.includes("?") ? "&" : "?"}${mode}=1`;
      await window.loadURL(url);
    } else if (mode !== "app") {
      await window.loadFile(rendererEntryFile, { query: { [mode]: "1" } });
    } else {
      await window.loadFile(rendererEntryFile);
    }
  };

  const createSystemWidgetWindow = async () => {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      if (!widgetWindow.isVisible()) widgetWindow.show();
      widgetWindow.focus();
      return;
    }

    const appIconPath = resolveAppIconPath();
    const appIconImage = createAppIconImage();
    const linuxIcon: Electron.BrowserWindowConstructorOptions["icon"] | undefined =
      process.platform === "linux"
        ? (appIconImage ?? appIconPath ?? undefined)
        : undefined;
    const width = 390;
    const height = 650;
    const savedBounds = widgetWindowStateStore?.resolveBounds();
    const parentBounds = mainWindow?.getBounds();
    const initialBounds = savedBounds
      ?? (parentBounds
      ? {
          x: Math.max(0, parentBounds.x + parentBounds.width - width - 28),
          y: Math.max(0, parentBounds.y + 64),
          width,
          height,
        }
      : { width, height });

    widgetWindow = new BrowserWindow({
      ...initialBounds,
      minWidth: 330,
      minHeight: 500,
      // No maxWidth/maxHeight — they used to clamp at 560×900,
      // which prevented the user from dragging the widget to a
      // larger size (especially useful when "wide mode" is on
      // and the widget lives on a separate monitor). Removing
      // the clamps also fixes the previous "resize-doesn't-
      // persist" feel: the saved size was being honored, but
      // anything above 560 was getting clamped on restore.
      // Match the user-visible title rendered by SystemWidget.tsx
      // ("DiskHound Monitor"). Was previously "DiskHound Widget" —
      // showed up in the Alt-Tab list / WM tooltip and didn't match
      // the in-window text.
      title: "DiskHound Monitor",
      backgroundColor: "#0a0a0f",
      frame: false,
      resizable: true,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: true,
      ...(linuxIcon ? { icon: linuxIcon } : {}),
      webPreferences: {
        preload: Path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    widgetWindow.setAlwaysOnTop(true, process.platform === "darwin" ? "floating" : "normal");
    if (process.platform === "darwin") {
      widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    if (process.platform === "linux" && appIconImage) {
      try { widgetWindow.setIcon(appIconImage); } catch { /* best effort */ }
    }

    widgetWindowStateStore?.track(widgetWindow);

    await loadRenderer(widgetWindow, "widget");

    widgetWindow.on("closed", () => {
      widgetWindow = null;
    });
  };

  ipcMain.handle("diskhound:open-system-widget", async () => {
    await createSystemWidgetWindow();
  });
  ipcMain.handle("diskhound:close-system-widget", async () => {
    widgetWindow?.close();
  });
  ipcMain.handle("diskhound:focus-main-window", async () => {
    if (!mainWindow) return;
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  ipcMain.handle("diskhound:focus-main-with-view", async (_event, payload: NavigateViewPayload) => {
    // Bring the main window forward AND tell its renderer to
    // switch tabs (and optionally set the active scan root).
    // Powers the widget's click-through tiles. No-op if the main
    // window has been destroyed (rare — the tray "Quit" path
    // would do that, but in that case the user wouldn't have a
    // widget open either).
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    // Send only to mainWindow — the widget renderer doesn't need
    // to receive its own navigation request, and other future
    // renderers (preview windows, etc.) are out of scope.
    try {
      mainWindow.webContents.send(NAVIGATE_VIEW_CHANNEL, payload);
    } catch {
      // Renderer may be unloading — best effort.
    }
  });
  ipcMain.handle("diskhound:set-system-widget-pinned", (_event, pinned: boolean) => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return false;
    widgetWindow.setAlwaysOnTop(Boolean(pinned), process.platform === "darwin" ? "floating" : "normal");
    if (process.platform === "darwin") {
      widgetWindow.setVisibleOnAllWorkspaces(Boolean(pinned), { visibleOnFullScreen: Boolean(pinned) });
    }
    return widgetWindow.isAlwaysOnTop();
  });
  ipcMain.handle("diskhound:set-system-widget-mode", (_event, mode: "compact" | "wide") => {
    // Wide mode is for users who park the widget on a secondary
    // monitor — bigger footprint, denser layout. Compact is the
    // default sliver size. We only resize if the user is going
    // FROM compact TO wide (or vice versa) with the current
    // dimensions still matching the previous mode's defaults —
    // otherwise we'd stomp on a custom size the user has set.
    // Persistence of the mode itself lives in the renderer's
    // localStorage; this handler just performs the resize.
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    const COMPACT = { width: 390, height: 650 };
    const WIDE = { width: 880, height: 720 };
    const current = widgetWindow.getBounds();
    const target = mode === "wide" ? WIDE : COMPACT;
    // Heuristic for "user hasn't customized": within 60 px of
    // the OTHER mode's defaults. Anything outside that gap is
    // assumed bespoke and left alone (we still flip the layout
    // class via the renderer, just don't resize the window).
    const other = mode === "wide" ? COMPACT : WIDE;
    const nearOther =
      Math.abs(current.width - other.width) < 60 &&
      Math.abs(current.height - other.height) < 60;
    if (nearOther) {
      widgetWindow.setSize(target.width, target.height, true /* animate */);
    }
  });

  const createWindow = async () => {
    const appIconPath = resolveAppIconPath();
    const appIconImage = createAppIconImage();
    // Linux: prefer the multi-rep NativeImage so the WM picks the
    // right pixels for each chrome slot (16 px title-bar, 48 px dock,
    // 128 px switcher, …). Fall back to the 512 PNG path if the
    // icons/ directory wasn't shipped for some reason.
    // Windows + macOS: packaging already embeds the correct icon
    // (ICO / ICNS) in the binary, so the `icon` option is mostly
    // redundant there — we only set it on Linux.
    const linuxIcon: Electron.BrowserWindowConstructorOptions["icon"] | undefined =
      process.platform === "linux"
        ? (appIconImage ?? appIconPath ?? undefined)
        : undefined;

    // Restored geometry from the previous session, or defaults on
    // first launch / when the saved position is on a now-disconnected
    // monitor (windowStateStore.resolveBounds drops x/y in that case
    // so the WM centers the window instead of stranding it).
    const savedBounds = windowStateStore?.resolveBounds() ?? {
      width: 1560,
      height: 980,
    };

    mainWindow = new BrowserWindow({
      ...savedBounds,
      minWidth: 960,
      minHeight: 640,
      backgroundColor: "#0a0a0f",
      title: isDevelopment ? "DiskHound (Dev)" : "DiskHound",
      ...(linuxIcon ? { icon: linuxIcon } : {}),
      titleBarStyle: "hidden",
      // Overlay caption buttons are Windows and Linux. On macOS the
      // option is ignored and setTitleBarOverlay is missing.
      ...(process.platform === "darwin"
        ? {
            // AppKit's default spot centres the traffic lights on a 28pt
            // title bar, ~3.5pt above the brand in our 40px header. The
            // band is 39pt (1px border-bottom), the buttons are 14pt:
            // (39 - 14) / 2 = 12.5, rounded high. x keeps the default
            // inset, which the header's 78px macOS padding-left is sized
            // around. Re-derive if --header-h changes.
            trafficLightPosition: { x: 9, y: 12 },
          }
        : {
            titleBarOverlay: {
              color: "#0a0a0f",
              symbolColor: "#94a3b8",
              height: 40,
            },
          }),
      webPreferences: {
        preload: Path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    // Some Linux window managers (notably GNOME Shell with the default
    // dash-to-dock) ignore the constructor `icon` option and only read
    // the icon after the window is realized. Explicit setIcon() after
    // construction covers that case. No-op on macOS / Windows (the
    // bundled ICNS / ICO is authoritative there).
    if (process.platform === "linux" && appIconImage) {
      try {
        mainWindow.setIcon(appIconImage);
      } catch {
        /* non-fatal — WM just uses the default Electron icon */
      }
    }

    // Re-apply maximize / fullscreen from the saved state. We can't
    // pass these as BrowserWindow constructor options, so it has to
    // happen post-construction. setFullScreen wins over maximize:
    // they're mutually exclusive in practice, but if both flags
    // somehow ended up true (ought-to-be-impossible on a single
    // window, but we read them out of a JSON file users could edit),
    // fullscreen is the more recent state to honor. Fullscreen on
    // macOS opens a new Space and animates ~500 ms; users see the
    // app come up at last-session geometry then transition.
    if (windowStateStore?.shouldRestoreFullScreen()) {
      mainWindow.setFullScreen(true);
    } else if (windowStateStore?.shouldRestoreMaximized()) {
      mainWindow.maximize();
    }

    // Attach the resize/move/maximize listeners that capture future
    // geometry changes. Persistence is debounced inside the store so
    // a slow drag doesn't generate a write per frame.
    windowStateStore?.track(mainWindow);

    await loadRenderer(mainWindow, "app");

    if (process.platform !== "darwin") {
      mainWindow.setMenuBarVisibility(false);
      mainWindow.setAutoHideMenuBar(true);
    }

    if (isDevelopment) {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }

    // Only hide-to-tray if tray is actually present and visible.
    // Use isQuitting flag to allow real quit via tray menu or app.quit().
    mainWindow.on("close", (event) => {
      if (isQuitting) return; // Let the window close normally

      const settings = settingsStore?.get();
      if (settings?.general.minimizeToTray && tray) {
        event.preventDefault();
        hideMainWindow();
        showCloseToTrayHint();
      }
    });

    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  };
  createMainWindowFn = createWindow;

  let settings = settingsStore.get();
  const normalizedSettings = normalizeAppSettings(settings);
  if (JSON.stringify(normalizedSettings) !== JSON.stringify(settings)) {
    await settingsStore.set(normalizedSettings);
    settings = normalizedSettings;
  }

  installApplicationMenu();

  // Only create tray if minimizeToTray is explicitly enabled
  if (settings.general.minimizeToTray) {
    createTray();
  }

  // Wire launchOnStartup from persisted settings
  applyLoginItemSettings(settings.general.launchOnStartup);

  // ── Local AI agents (MCP) ─────────────────────────────────
  // Loopback MCP server + OAuth + native approval window. Idle unless
  // Settings → AI Agents is on. See src/mcp/ and docs/mcp.md. The IPC
  // handlers register before the window loads; the server starts after.
  let agentHost: AgentHost | null = null;
  try {
    agentHost = createAgentHost({
      projectRoot,
      preloadPath: Path.join(__dirname, "preload.cjs"),
      getMainWindow: () => mainWindow,
      ensureMainWindow,
      loadRenderer,
      getSettings: () => settingsStore!.get(),
      setAgentsEnabled: async (enabled) => {
        await settingsStore!.update((current) => ({ ...current, agents: { ...current.agents, enabled } }));
      },
      toast: sendToast,
      log: writeCrashLog,
      listDrives: () => getDiskSpace(),
      activeScans: () =>
        Array.from(activeScans.values()).map((session) =>
          liveSnapshotByKey.get(scanKey(session.rootPath)) ?? {
            ...createIdleScanSnapshot(),
            status: "running",
            rootPath: session.rootPath,
          },
        ),
      currentSnapshotRoot: async () => (await scanStore.get()).rootPath,
      allHistory: () => [...getAllEntries()],
      scanHistory: (rootPath) => getScanHistory(rootPath),
      loadSnapshot: (id) => loadHistoricalSnapshotCached(id),
      startScan: (rootPath) => startScan(rootPath, defaultScanOptions()),
      cancelScan: async (rootPath) => {
        await cancelActiveScan(rootPath);
      },
      folderChildren: (rootPath, parentPath) => getFolderChildrenImpl(rootPath, parentPath),
      searchIndex: (rootPath, query) => searchIndexImpl(rootPath, query),
      cleanupSuggestions: (rootPath) => analyzeCleanupImpl(rootPath),
      devArtifacts: (rootPath) => getDevArtifactsImpl(rootPath),
      diff: (baselineId, currentId) => computeScanDiffImpl(baselineId, currentId),
      fullDiff: (baselineId, currentId, limit) => fullDiffLoader.load(baselineId, currentId, limit),
      duplicates: (rootPath) => {
        const key = scanKey(Path.resolve(rootPath));
        return {
          running: activeDuplicateScans.has(key),
          progress: duplicateProgressByKey.get(key) ?? null,
          analysis: duplicateResultByKey.get(key) ?? null,
        };
      },
      startDuplicateScan: (rootPath, minSizeBytes) => startDuplicateScanImpl(rootPath, { minSizeBytes }),
      trashPath: (targetPath) => trashPathImpl(targetPath),
    });
  } catch (err) {
    writeCrashLog("agent-access", `startup failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }

  restartMonitoring(settings);
  await ensureMainWindow();
  writeStartupLog("window created and loaded");
  await agentHost?.start().catch((err: unknown) => {
    writeCrashLog("agent-access", `start failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  });


  // "Start minimized" is an AUTOSTART-ONLY preference — we want a
  // fresh-install launch, a post-update restart, and a user-initiated
  // double-click to all surface the window, even when the user has
  // opted into starting minimized on OS login. The distinguishing
  // signal is the `--autostart` arg that applyLoginItemSettings wires
  // into the registered login item. Legacy flag `--start-minimized`
  // stays recognised so installs that ran on ≤ v0.2.15 don't
  // double-foreground on their next OS-login launch before Settings
  // is opened (which rewrites the arg).
  const wasAutoStarted =
    process.argv.includes("--autostart") ||
    process.argv.includes("--start-minimized");
  const canLaunchToTray = settings.general.minimizeToTray && Boolean(tray);
  const launchMinimized =
    canLaunchToTray && wasAutoStarted && settings.general.startMinimized;
  if (pendingSecondInstanceFocus) {
    pendingSecondInstanceFocus = false;
    showMainWindowIfPresent();
  } else if (launchMinimized) {
    hideMainWindow();
  }

  // Auto-update (production only, gated on user setting)
  let autoUpdater: any = null;
  const UPDATE_STATUS_CHANNEL = "diskhound:update-status";
  const currentVersion = app.getVersion();
  const linuxManualUpdateBuild = process.platform === "linux" && !process.env.APPIMAGE;
  // Stable checks stay conservative; beta checks poll faster so
  // prerelease builds reach opted-in clients promptly.
  const STABLE_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
  const BETA_UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
  let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;
  let lastUpdateStatus: UpdateStatus | null = null;

  const updaterState = createUpdaterStateStore(
    Path.join(app.getPath("userData"), "updater-state.json"),
  );

  const updateChannelForSettings = (value: AppSettings): UpdateChannel =>
    value.general.betaUpdates ? "beta" : "latest";

  const currentUpdateChannel = (): UpdateChannel => updateChannelForSettings(settingsStore!.get());

  const configureAutoUpdaterForSettings = (value = settingsStore!.get()) => {
    if (!autoUpdater) return;
    autoUpdater.allowPrerelease = updateChannelForSettings(value) === "beta";
    // Do not install an older stable release when the user leaves beta.
    autoUpdater.allowDowngrade = false;
  };

  const updateCheckIntervalForSettings = (value = settingsStore!.get()) =>
    updateChannelForSettings(value) === "beta"
      ? BETA_UPDATE_CHECK_INTERVAL_MS
      : STABLE_UPDATE_CHECK_INTERVAL_MS;

  const emitUpdateStatus = (status: UpdateStatus) => {
    const enriched: UpdateStatus = {
      ...status,
      channel: status.channel ?? currentUpdateChannel(),
      lastCheckedAt: updaterState.get().lastCheckedAt,
    };
    lastUpdateStatus = enriched;
    mainWindow?.webContents.send(UPDATE_STATUS_CHANNEL, enriched);
  };

  const recordCheck = () => {
    updaterState.update({ lastCheckedAt: Date.now() });
  };

  const clearPendingInstall = () => {
    updaterState.update({ pendingInstallVersion: null, pendingInstallStartedAt: null });
  };

  const emitCompletedInstallIfNeeded = () => {
    const pendingVersion = updaterState.get().pendingInstallVersion;
    if (!pendingVersion) return;

    const startedAt = updaterState.get().pendingInstallStartedAt ?? Date.now();
    clearPendingInstall();
    if (pendingVersion !== currentVersion) return;

    emitUpdateStatus({
      phase: "installed",
      currentVersion,
      availableVersion: currentVersion,
      installedVersion: currentVersion,
      installStartedAt: startedAt,
    });
  };

  const clearUpdateCheckTimer = () => {
    if (updateCheckTimer) {
      clearTimeout(updateCheckTimer);
      updateCheckTimer = null;
    }
  };

  const scheduleNextUpdateCheck = (immediate = false) => {
    clearUpdateCheckTimer();
    if (!autoUpdater || !settingsStore!.get().general.autoUpdate) return;

    const delay = immediate ? 1_500 : updateCheckIntervalForSettings();
    updateCheckTimer = setTimeout(() => {
      updateCheckTimer = null;
      if (!autoUpdater || !settingsStore!.get().general.autoUpdate) return;
      configureAutoUpdaterForSettings();
      autoUpdater.checkForUpdates().catch(() => {}).finally(() => {
        scheduleNextUpdateCheck(false);
      });
    }, delay);
    updateCheckTimer.unref?.();
  };

  if (!isDevelopment && !linuxManualUpdateBuild) {
    try {
      autoUpdater = require("electron-updater").autoUpdater;
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      // Per-user install location (LocalAppData) doesn't need elevation; setting
      // this false lets the silent updater run without a UAC prompt.
      autoUpdater.allowElevation = false;
      configureAutoUpdaterForSettings(settings);

      autoUpdater.on("checking-for-update", () => {
        emitUpdateStatus({ phase: "checking", currentVersion });
      });
      autoUpdater.on("update-available", (info: any) => {
        recordCheck();
        emitUpdateStatus({ phase: "available", currentVersion, availableVersion: info?.version });
        sendToast("info", "Update available", `DiskHound ${info?.version ?? ""} is available. Downloading...`);
        autoUpdater.downloadUpdate().catch(() => {});
      });
      autoUpdater.on("update-not-available", (info: any) => {
        recordCheck();
        emitUpdateStatus({ phase: "up-to-date", currentVersion, availableVersion: info?.version });
      });
      autoUpdater.on("download-progress", (p: any) => {
        emitUpdateStatus({ phase: "downloading", currentVersion, downloadPercent: Math.round(p?.percent ?? 0) });
      });
      autoUpdater.on("update-downloaded", (info: any) => {
        emitUpdateStatus({ phase: "downloaded", currentVersion, availableVersion: info?.version });
        sendToast("success", "Update ready", "Restart DiskHound to apply the update.");
      });
      autoUpdater.on("error", (err: Error) => {
        // Still record the attempt — users ask "did it try?" and
        // repeated network errors shouldn't look like no activity.
        recordCheck();
        emitUpdateStatus({ phase: "error", currentVersion, errorMessage: err?.message });
      });

      handleUpdateSettingsChanged = (previousSettings, nextSettings) => {
        const autoUpdateChanged = previousSettings.general.autoUpdate !== nextSettings.general.autoUpdate;
        const betaChanged = previousSettings.general.betaUpdates !== nextSettings.general.betaUpdates;
        if (!autoUpdateChanged && !betaChanged) return;

        configureAutoUpdaterForSettings(nextSettings);
        scheduleNextUpdateCheck(nextSettings.general.autoUpdate);
      };

      emitCompletedInstallIfNeeded();

      // Check on boot only if the user has auto-update enabled
      if (settings.general.autoUpdate) {
        scheduleNextUpdateCheck(true);
      }
    } catch {
      // electron-updater not available (dev mode or build issue)
    }
  }

  if (linuxManualUpdateBuild) {
    emitUpdateStatus({
      phase: "manual",
      currentVersion,
      manualMessage: "Automatic updates are only supported for the AppImage build. Use GitHub releases for tar.gz or other manual Linux installs.",
    });
  }

  ipcMain.handle("diskhound:check-for-updates", async () => {
    if (linuxManualUpdateBuild) {
      void shell.openExternal(RELEASES_URL);
      emitUpdateStatus({
        phase: "manual",
        currentVersion,
        manualMessage: "Automatic updates are only supported for the AppImage build. Opened GitHub releases instead.",
      });
      return;
    }
    if (!autoUpdater) return;
    configureAutoUpdaterForSettings();
    try { await autoUpdater.checkForUpdates(); } catch { /* ignore */ }
  });

  // Returns the persisted last-checked timestamp so the Settings UI can
  // show "Last checked 4h ago" immediately after app launch, instead of
  // the stale-looking "Never" that the in-memory UpdateStatus gives us.
  ipcMain.handle("diskhound:get-update-state", () => {
    return {
      lastCheckedAt: updaterState.get().lastCheckedAt,
      currentVersion,
      channel: currentUpdateChannel(),
      lastStatus: lastUpdateStatus,
    };
  });

  ipcMain.on("diskhound:quit-and-install", () => {
    if (!autoUpdater) return;
    const availableVersion = lastUpdateStatus?.availableVersion ?? null;
    const installStartedAt = Date.now();
    updaterState.update({
      pendingInstallVersion: availableVersion,
      pendingInstallStartedAt: installStartedAt,
    });
    emitUpdateStatus({
      phase: "installing",
      currentVersion,
      availableVersion: availableVersion ?? undefined,
      installStartedAt,
    });
    clearUpdateCheckTimer();
    // Silent install + auto-relaunch after update.
    // isSilent=true → skip NSIS UI; isForceRunAfter=true → relaunch DiskHound once install finishes.
    setTimeout(() => {
      isQuitting = true;
      try {
        autoUpdater.quitAndInstall(true, true);
      } catch (err) {
        clearPendingInstall();
        emitUpdateStatus({
          phase: "error",
          currentVersion,
          errorMessage: err instanceof Error ? err.message : "Failed to start installer",
        });
      }
    }, 500);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void ensureMainWindow().catch((err: unknown) => {
        writeStartupLog(
          `ensureMainWindow failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  });

  app.on("before-quit", () => {
    isQuitting = true;
    clearUpdateCheckTimer();
    for (const session of activeScans.values()) {
      void session.stop();
    }
    activeScans.clear();
    for (const handle of activeDuplicateScans.values()) {
      handle.cancel();
    }
    activeDuplicateScans.clear();
    if (monitoringInterval) {
      clearInterval(monitoringInterval);
      monitoringInterval = null;
    }
    if (tray) {
      tray.destroy();
      tray = null;
    }
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.destroy();
      widgetWindow = null;
    }
    treemapCache.clear();
    // Flush pending window-state debounce so the final geometry
    // (e.g. user dragged the window then quit within 400 ms) is
    // written to disk before the process exits. Fire-and-forget —
    // app.before-quit is synchronous from Electron's POV; if the
    // write hasn't finished by app.quit() we lose at most one
    // session's geometry, which is the same outcome as a kernel
    // panic would produce. The window's own close listener also
    // calls persistNow as a belt-and-suspenders.
    void windowStateStore?.flush();
    void widgetWindowStateStore?.flush();
    // Affinity-rule counters since the last 15-minute save.
    void affinityEnforcer.flush();
    // Idle monitoring checks leave the latest drive readings in
    // memory only; write them (synchronously) so the next launch's
    // first delta starts from this session's last check.
    flushDiskMonitor();
    // Likewise a USN tick that found nothing changed: its restamped
    // snapshot and its cursor wait for quit.
    scanStore.flush();
    flushUsnCursorStore();
    void agentHost?.dispose();
  });
})().catch((err: unknown) => {
  const error = err as { stack?: string; message?: string };
  writeStartupLog(`whenReady rejected: ${error?.stack ?? error?.message ?? String(err)}`);
  crashLog.flush();
  try {
    dialog.showErrorBox("DiskHound — Startup failed", String(error?.stack ?? error?.message ?? err));
  } catch { /* noop */ }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    const settings = settingsStore?.get();
    if (!settings?.general.minimizeToTray || !tray) {
      app.quit();
    }
  }
});

function formatBytesShort(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / 1024 ** exp;
  return `${val.toFixed(val >= 100 || exp === 0 ? 0 : 1)} ${units[exp]}`;
}

function formatScanIntervalLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) {
    return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
  }
  const days = hours / 24;
  return Number.isInteger(days) ? `${days}d` : `${days.toFixed(1)}d`;
}
