import * as FS from "node:fs/promises";
import { createRequire } from "node:module";
import * as OS from "node:os";
import * as Path from "node:path";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

import type {
  AppSettings,
  CleanupAnalysis,
  DevArtifactReport,
  DiskSpaceInfo,
  DuplicateAnalysis,
  DuplicateScanProgress,
  FullDiffResult,
  IndexSearchQuery,
  IndexSearchResult,
  NavigateViewPayload,
  PathActionResult,
  ScanDiffResult,
  ScanHistoryEntry,
  ScanSnapshot,
  ToastMessage,
  WindowViewState,
} from "../shared/contracts";
import {
  AGENT_ACCESS_PORT,
  BUILT_IN_MCP_ROLES,
  MCP_SERVER_NAME,
  agentAccessMcpUrl,
  type AddToClaudeResult,
  type AgentAccessSnapshot,
  type AgentAccessStatus,
  type AgentConsentDecision,
} from "../shared/agentAccess";
import { normPath } from "../shared/pathUtils";
import { powerEfficiencyWorkers } from "../shared/powerEfficiency";
import { formatSizeBytes, resolveSizeUnitBase } from "../shared/sizeUnits";
import { McpPolicyStore } from "./accessPolicy";
import type { AgentAccessService } from "./agentAccessService";
import { AgentActivityLog } from "./activityLog";
import type { DiskhoundAgentBackend, FolderChildren, NavigateRequest, TrashOutcome, TrashRequest } from "./backend";
import { writeClaudeExtension } from "./claudeExtension";
import { ConsentBroker, type ConsentWindow } from "./consentBroker";
import { resolveNativeScannerBinary } from "../nativeScanner";
import { isInside } from "./paths";
import { nativeRemovalMeasurer, RemovalMeasurements } from "./removalMeasure";
import { AgentSecurityLog } from "./securityLog";
import type { SkillCatalog } from "./skills";
import { agentTrashRefusal, canonicalPath, configuredTrashGuard, outermostPaths } from "./trashGuard";

const NAVIGATE_VIEW_CHANNEL = "diskhound:navigate-view";
const PATHS_TRASHED_CHANNEL = "diskhound:paths-trashed";
const PATHS_DELETED_CHANNEL = "diskhound:paths-deleted";
const AGENT_ACCESS_CHANGED_CHANNEL = "diskhound:agent-access-changed";
const AGENT_ACTIVITY_CHANNEL = "diskhound:agent-activity";
const AGENT_SECURITY_CHANNEL = "diskhound:agent-security";

/**
 * The closures from main.ts that the agent host needs. main.ts owns
 * the scan pipeline and its caches; this module only adapts them to
 * the MCP backend contract and adds the Electron-specific pieces
 * (approval window, trash confirmation, navigation, Settings IPC).
 */
export interface AgentHostDeps {
  projectRoot: string;
  preloadPath: string;
  getMainWindow(): BrowserWindow | null;
  ensureMainWindow(): Promise<void>;
  loadRenderer(window: BrowserWindow, mode: "consent"): Promise<void>;
  getSettings(): AppSettings;
  setAgentsEnabled(enabled: boolean): Promise<void>;
  toast(level: ToastMessage["level"], title: string, body?: string): void;
  log(tag: string, message: string): void;

  listDrives(): Promise<DiskSpaceInfo[]>;
  activeScans(): ScanSnapshot[];
  currentSnapshotRoot(): Promise<string | null>;
  allHistory(): ScanHistoryEntry[];
  scanHistory(rootPath: string): ScanHistoryEntry[];
  loadSnapshot(id: string): Promise<ScanSnapshot | null>;
  startScan(rootPath: string): Promise<ScanSnapshot>;
  cancelScan(rootPath: string): Promise<void>;
  folderChildren(rootPath: string, parentPath: string): Promise<FolderChildren>;
  searchIndex(rootPath: string, query: IndexSearchQuery): Promise<IndexSearchResult>;
  cleanupSuggestions(rootPath: string): Promise<CleanupAnalysis>;
  devArtifacts(rootPath: string): Promise<DevArtifactReport | null>;
  diff(baselineId: string, currentId: string): Promise<ScanDiffResult | null>;
  fullDiff(baselineId: string, currentId: string, limit: number): Promise<FullDiffResult | null>;
  duplicates(rootPath: string): { running: boolean; progress: DuplicateScanProgress | null; analysis: DuplicateAnalysis | null };
  startDuplicateScan(rootPath: string, minSizeBytes?: number): void;
  trashPath(targetPath: string): Promise<PathActionResult>;
  /** DiskHound's own permanent delete (worker for folders), as the UI uses it. */
  permanentDeletePath(targetPath: string): Promise<PathActionResult>;
}

export interface AgentHost {
  /** Start the MCP server if Settings has AI Agents on. */
  start(): Promise<void>;
  /** Open Settings → AI Agents in the main window (menus, tray). */
  showSettings(): Promise<void>;
  dispose(): Promise<void>;
}

function skillsDirectory(projectRoot: string): string {
  // Packaged: electron-builder copies skills/ to resources/skills (plain
  // files, not inside app.asar). Dev: the repo checkout.
  return app.isPackaged ? Path.join(process.resourcesPath, "skills") : Path.join(projectRoot, "skills");
}

type AgentRuntime = typeof import("./agentRuntime");

/**
 * Require the separately bundled runtime by path. A static import would
 * make the bundler inline it (and hoist the SDK/Express requires to the
 * top of main.cjs, where they'd load on every launch).
 */
function loadAgentRuntime(): AgentRuntime {
  const runtimePath = Path.join(__dirname, "mcp", "agentRuntime.cjs");
  return createRequire(__filename)(runtimePath) as AgentRuntime;
}

function trashName(): string {
  return process.platform === "win32" ? "Recycle Bin" : "Trash";
}

/**
 * Folders an agent may never move to the Trash, nor anything containing
 * them: the home folder and its standard folders, the folder holding
 * every user's home, DiskHound's data, and the app itself.
 */
async function keepFolders(): Promise<string[]> {
  const names = ["home", "desktop", "documents", "downloads", "music", "pictures", "videos", "appData", "userData"] as const;
  const folders: string[] = [];
  for (const name of names) {
    try {
      folders.push(app.getPath(name));
    } catch {
      /* not defined on this OS */
    }
  }
  const home = app.getPath("home");
  folders.push(Path.dirname(home), Path.dirname(app.getPath("exe")));
  if (process.platform === "darwin") folders.push(Path.join(home, "Library"), "/Applications");
  if (process.platform === "win32") folders.push(Path.join(home, "AppData"));
  return Promise.all(folders.map((folder) => canonicalPath(folder).catch(() => folder)));
}

/**
 * DISKHOUND_AGENT_PORT moves the MCP server off 51735. The E2E suite
 * gives each launch its own port, so it never collides with a DiskHound
 * the developer runs with agents turned on.
 */
function agentAccessPort(): number {
  const raw = process.env.DISKHOUND_AGENT_PORT?.trim();
  if (!raw) return AGENT_ACCESS_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : AGENT_ACCESS_PORT;
}

/**
 * Registers the agent IPC handlers right away (the renderer asks for
 * agent state as soon as it mounts). The MCP server itself starts in
 * `start()`, after the main window is up.
 */
export function createAgentHost(deps: AgentHostDeps): AgentHost {
  const userData = app.getPath("userData");
  const policy = new McpPolicyStore(Path.join(userData, "mcp-policy.json"));
  const clientsFile = Path.join(userData, "mcp-oauth-clients.json");
  const port = agentAccessPort();

  const mainWindowSend = (channel: string, payload: unknown) => {
    const main = deps.getMainWindow();
    if (!main || main.isDestroyed()) return;
    try {
      main.webContents.send(channel, payload);
    } catch {
      /* best effort */
    }
  };

  let viewState: WindowViewState | null = null;
  // The main window's renderer is listening once it reports its view
  // (App's mount effect). Navigation sent before that is held until then,
  // e.g. when an agent's call recreated the window from the tray.
  let readyRendererId: number | null = null;
  let pendingNavigation: NavigateViewPayload | null = null;
  ipcMain.on("diskhound:report-view-state", (event, state: WindowViewState) => {
    const main = deps.getMainWindow();
    if (!main || event.sender.id !== main.webContents.id) return;
    viewState = state && typeof state.view === "string" ? state : null;
    readyRendererId = event.sender.id;
    if (pendingNavigation) {
      const payload = pendingNavigation;
      pendingNavigation = null;
      mainWindowSend(NAVIGATE_VIEW_CHANNEL, payload);
    }
  });

  const activity = new AgentActivityLog((entry) => mainWindowSend(AGENT_ACTIVITY_CHANNEL, entry));

  // What agents tried and weren't allowed to do. Read from disk only once
  // agents have been turned on (never while the feature is unused).
  const security = new AgentSecurityLog({
    file: Path.join(userData, "agent-security.log"),
    onEvent: (event, { repeated, logged }) => {
      mainWindowSend(AGENT_SECURITY_CHANNEL, event);
      if (repeated) return;
      if (logged) deps.log("agent-security", `${event.kind} session="${event.sessionName}" tool=${event.tool} ${event.detail}`);
      if (event.tool === "diskhound_move_to_trash" || event.tool === "diskhound_delete_permanently") {
        deps.toast("warning", `Blocked a request from ${event.sessionName}`, event.detail);
      }
    },
  });
  let securityLoaded = false;
  const loadSecurityEvents = async () => {
    if (securityLoaded) return;
    securityLoaded = true;
    await security.list();
  };

  // ── Backend ───────────────────────────────────────────────

  /** Latest scan (newest first) per distinct root. */
  const scannedRoots = (): ScanHistoryEntry[] => {
    const newest = new Map<string, ScanHistoryEntry>();
    for (const entry of deps.allHistory()) {
      const key = normPath(entry.rootPath);
      const current = newest.get(key);
      if (!current || entry.scannedAt > current.scannedAt) newest.set(key, entry);
    }
    return [...newest.values()].sort((a, b) => b.scannedAt - a.scannedAt);
  };

  const navigate = async (request: NavigateRequest) => {
    await deps.ensureMainWindow();
    const main = deps.getMainWindow();
    if (!main || main.isDestroyed()) return;
    if (request.focus) {
      if (!main.isVisible()) main.show();
      if (main.isMinimized()) main.restore();
      main.focus();
    } else if (!main.isVisible()) {
      // Hidden to the tray: show it, but leave focus with the agent's terminal.
      main.showInactive();
    }
    const payload: NavigateViewPayload = {
      view: request.view,
      ...(request.rootPath ? { scanRoot: request.rootPath } : {}),
      ...(request.folderPath ? { folderPath: request.folderPath } : {}),
      ...(request.section ? { section: request.section } : {}),
    };
    if (readyRendererId === main.webContents.id && !main.webContents.isLoading()) {
      mainWindowSend(NAVIGATE_VIEW_CHANNEL, payload);
    } else {
      pendingNavigation = payload;
    }
  };

  /** Size DiskHound recorded for a path, from the folder tree of its scan. */
  const recordedSize = async (target: string): Promise<number | null> => {
    const root = scannedRoots()
      .map((entry) => entry.rootPath)
      .filter((candidate) => isInside(candidate, target))
      .sort((a, b) => b.length - a.length)[0];
    if (root && normPath(root) !== normPath(target)) {
      try {
        const children = await deps.folderChildren(root, Path.dirname(target));
        const key = normPath(target);
        const dir = children.dirs.find((d) => normPath(d.path) === key);
        if (dir) return dir.size;
        const file = children.files.find((f) => normPath(f.path) === key);
        if (file) return file.size;
      } catch {
        /* fall through */
      }
    }
    try {
      const stat = await FS.lstat(target);
      if (!stat.isDirectory()) return process.platform === "win32" ? stat.size : stat.blocks * 512;
    } catch {
      /* missing */
    }
    return null;
  };

  /** The units the window shows, so the dialog's sizes match it. */
  const sizeUnitBase = () => resolveSizeUnitBase(deps.getSettings().general.sizeUnits, process.platform);
  const formatSize = (bytes: number | null) => {
    if (bytes === null) return "size unknown";
    if (bytes <= 0) return "0 B";
    return formatSizeBytes(bytes, sizeUnitBase());
  };

  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

  // One confirmation dialog at a time; later requests queue behind it.
  let removalTail: Promise<unknown> = Promise.resolve();
  const confirmAndRemove = (request: TrashRequest, mode: "trash" | "delete"): Promise<TrashOutcome> => {
    const verb = mode === "trash" ? "moved" : "deleted";
    const hungUp = () =>
      new Error(`The agent's request closed before DiskHound asked the user. Nothing was ${verb}.`);
    const run = async (): Promise<TrashOutcome> => {
      // This request may have waited behind other dialogs. If the agent
      // hung up, the server stopped, or the user revoked the session or
      // changed its role meanwhile, don't ask on its behalf.
      if (request.signal?.aborted) throw hungUp();
      await request.recheck?.();

      // Resolve each path to its on-disk spelling so the protected-folder
      // check (a string compare in main) sees what would actually move.
      const keep = await keepFolders();
      const protectedFolder = await configuredTrashGuard(deps.getSettings().scanning.excludedFolderPaths);
      const refused: TrashOutcome["results"] = [];
      const offered: string[] = [];
      for (const requested of request.paths) {
        let target: string;
        try {
          target = await canonicalPath(requested);
        } catch {
          refused.push({ path: requested, ok: false, message: "Nothing exists at this path.", sizeBytes: null });
          continue;
        }
        const why = protectedFolder(requested, target) ?? agentTrashRefusal(target, keep);
        if (why) {
          refused.push({ path: target, ok: false, message: `Refused: ${why}.`, sizeBytes: null });
          security.record({
            sessionId: request.sessionId,
            sessionName: request.sessionName,
            roleName: request.roleName,
            kind: "protected_path",
            tool: mode === "trash" ? "diskhound_move_to_trash" : "diskhound_delete_permanently",
            detail: `Asked to ${mode === "trash" ? `move ${target} to the ${trashName()}` : `delete ${target} permanently`}; refused: ${why.replace(/\.$/, "")}.`,
          });
        } else {
          offered.push(target);
        }
      }
      const targets = outermostPaths(offered);
      if (targets.length === 0) {
        throw new Error(`Nothing to ask the user about. ${refused.map((r) => `${r.path}: ${r.message}`).join(" ")}`);
      }

      const sizes = await Promise.all(targets.map((p) => recordedSize(p)));
      await deps.ensureMainWindow();
      const main = deps.getMainWindow();
      if (!main || main.isDestroyed()) return { confirmed: false, results: [] };
      if (!main.isVisible()) main.show();
      if (main.isMinimized()) main.restore();
      if (process.platform === "darwin") app.focus({ steal: true });
      main.focus();

      // Paths outside every scan have no recorded folder size.
      const known = sizes.filter((size): size is number => size !== null);
      const total = known.reduce((sum, size) => sum + size, 0);
      const totalText = known.length === 0 ? "" : ` (${known.length < sizes.length ? "at least " : ""}${formatSize(total)})`;
      // Every item, never "…and N more": the server caps a request at 20.
      const listed = targets.map((p, i) => `• ${p}  (${formatSize(sizes[i] ?? null)})`);
      // The user should know what else the agent asked for, and why it isn't here.
      const skipped = refused.length === 0
        ? ""
        : `\n\nNot included:\n${refused.map((r) => `• ${r.path}: ${r.message.replace(/^Refused: /, "")}`).join("\n")}`;
      const bin = trashName();
      const { response } = await dialog.showMessageBox(main, mode === "trash"
        ? {
            type: "warning",
            title: "DiskHound — agent request",
            message: `“${request.sessionName}” wants to move ${plural(targets.length, "item")}${totalText} to the ${bin}.`,
            detail:
              (request.reason ? `Reason: ${request.reason}\n\n` : "") +
              `${listed.join("\n")}${skipped}\n\nYou can restore items from the ${bin} until it is emptied.`,
            buttons: [`Move to ${bin}`, "Cancel"],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
            // Closes the dialog (as Cancel) if the agent hangs up or agents are turned off.
            signal: request.signal,
          }
        : {
            type: "warning",
            title: "DiskHound — agent request",
            message: `“${request.sessionName}” wants to permanently delete ${plural(targets.length, "item")}${totalText}.`,
            detail:
              (request.reason ? `Reason: ${request.reason}\n\n` : "") +
              `${listed.join("\n")}${skipped}\n\nThese won't go to the ${bin}. Deleted items can't be restored.`,
            buttons: ["Delete Permanently", "Cancel"],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
            signal: request.signal,
          });
      if (request.signal?.aborted) throw hungUp();
      if (response !== 0) {
        deps.log(`agent-${mode}`, `declined session="${request.sessionName}" paths=${targets.length}`);
        return { confirmed: false, results: [] };
      }
      const results: TrashOutcome["results"] = [...refused];
      // Settings may have changed while the confirmation was open.
      const currentProtection = await configuredTrashGuard(deps.getSettings().scanning.excludedFolderPaths);
      for (const [index, target] of targets.entries()) {
        const blocked = currentProtection(target, target);
        const result = blocked
          ? { ok: false, message: blocked }
          : mode === "trash"
            ? await deps.trashPath(target)
            : await deps.permanentDeletePath(target);
        results.push({ path: target, ok: result.ok, message: result.message, sizeBytes: sizes[index] ?? null });
      }
      const done = results.filter((r) => r.ok);
      if (done.length > 0) measurements?.invalidate();
      deps.log(`agent-${mode}`, `session="${request.sessionName}" ${verb}=${done.length}/${results.length}`);
      if (done.length > 0) {
        mainWindowSend(mode === "trash" ? PATHS_TRASHED_CHANNEL : PATHS_DELETED_CHANNEL, done.map((r) => r.path));
        const freed = formatSize(done.reduce((s, r) => s + (r.sizeBytes ?? 0), 0));
        deps.toast(
          "success",
          mode === "trash"
            ? `Moved ${plural(done.length, "item")} to the ${bin}`
            : `Deleted ${plural(done.length, "item")} permanently`,
          mode === "trash"
            ? `Requested by ${request.sessionName}. Empty the ${bin} to free ${freed}.`
            : `Requested by ${request.sessionName}. Freed ${freed}.`,
        );
      }
      return { confirmed: true, results };
    };
    const operation = removalTail.then(run, run);
    removalTail = operation.catch(() => undefined);
    return operation;
  };

  // What removing paths frees, measured by the native scanner (APFS
  // clones and hardlinks). Windows scans already count each file once.
  let measurements: RemovalMeasurements | null = null;
  const measureRemoval = async (paths: readonly string[], signal?: AbortSignal) => {
    if (!measurements) {
      const binary = resolveNativeScannerBinary(deps.projectRoot);
      if (!binary) {
        throw new Error("DiskHound's scanner is missing, so it can't measure. Reinstall DiskHound, or in a source checkout build native/diskhound-native-scanner.");
      }
      measurements = new RemovalMeasurements(
        nativeRemovalMeasurer(binary, () => {
          const preset = deps.getSettings().scanning.powerEfficiency;
          return preset ? powerEfficiencyWorkers(preset, OS.availableParallelism()) : undefined;
        }),
      );
    }
    return measurements.measure(paths, signal);
  };

  const backend: DiskhoundAgentBackend = {
    platform: process.platform,
    appVersion: app.getVersion(),
    sizeUnitBase,
    listDrives: () => deps.listDrives(),
    activeScans: async () => deps.activeScans(),
    scannedRoots,
    scanHistory: (rootPath) => deps.scanHistory(rootPath),
    latestSnapshot: async (rootPath) => {
      const latest = deps.scanHistory(rootPath)[0];
      return latest ? deps.loadSnapshot(latest.id) : null;
    },
    currentRoot: async () => viewState?.rootPath ?? (await deps.currentSnapshotRoot()),
    windowView: () => (viewState ? { ...viewState } : null),
    folderChildren: (rootPath, parentPath) => deps.folderChildren(rootPath, parentPath),
    searchIndex: (rootPath, query) => deps.searchIndex(rootPath, query),
    cleanupSuggestions: (rootPath) => deps.cleanupSuggestions(rootPath),
    devArtifacts: (rootPath) => deps.devArtifacts(rootPath),
    diff: (baselineId, currentId) => deps.diff(baselineId, currentId),
    fullDiff: (baselineId, currentId, limit) => deps.fullDiff(baselineId, currentId, limit),
    duplicates: (rootPath) => deps.duplicates(rootPath),
    startScan: (rootPath) => deps.startScan(rootPath),
    cancelScan: (rootPath) => deps.cancelScan(rootPath),
    startDuplicateScan: (rootPath, minSizeBytes) => deps.startDuplicateScan(rootPath, minSizeBytes),
    navigate,
    revealPath: async (targetPath) => {
      try {
        await FS.lstat(targetPath);
      } catch {
        return { ok: false, message: `Nothing exists at ${targetPath}.` };
      }
      shell.showItemInFolder(targetPath);
      return { ok: true, message: "Revealed." };
    },
    ...(process.platform === "win32" ? {} : { measureRemoval }),
    confirmAndTrash: (request) => confirmAndRemove(request, "trash"),
    confirmAndDelete: (request) => confirmAndRemove(request, "delete"),
  };

  // ── Approval sheet ───────────────────────────────────────

  /**
   * The approval UI is a sheet on the main window (a modal child window
   * elsewhere), so it reads as DiskHound asking and blocks the window
   * until the user answers. Its own webContents is what the broker
   * trusts; the main window's renderer can't approve anything.
   */
  const createConsentWindow = async (): Promise<ConsentWindow> => {
    await deps.ensureMainWindow();
    const main = deps.getMainWindow();
    if (!main || main.isDestroyed()) throw new Error("DiskHound's window is not available");
    if (!main.isVisible()) main.show();
    if (main.isMinimized()) main.restore();
    // The agent's login starts in a terminal or browser; pull DiskHound
    // forward so the user sees the request.
    if (process.platform === "darwin") app.focus({ steal: true });
    main.focus();

    const width = 560;
    const height = 640;
    const parentBounds = main.getBounds();
    const window = new BrowserWindow({
      width,
      height,
      // macOS attaches a modal child as a sheet; elsewhere center it on
      // the main window rather than on the screen.
      ...(process.platform === "darwin"
        ? {}
        : {
            x: Math.round(parentBounds.x + (parentBounds.width - width) / 2),
            y: Math.round(parentBounds.y + Math.max(40, (parentBounds.height - height) / 3)),
          }),
      parent: main,
      modal: true,
      show: false,
      resizable: false,
      title: "DiskHound — Approve agent access",
      backgroundColor: "#0a0a0f",
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    if (process.platform !== "darwin") window.setMenuBarVisibility(false);
    // The approval prompt opens nothing and goes nowhere while it's up.
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.once("ready-to-show", () => {
      if (window.isDestroyed()) return;
      window.show();
      window.focus();
    });
    void deps.loadRenderer(window, "consent").catch((err) => {
      deps.log("agent-consent", `load failed: ${err instanceof Error ? err.message : String(err)}`);
      // It would never show; closing it denies the request now instead
      // of leaving the agent's login waiting out the timeout.
      if (!window.isDestroyed()) window.close();
    });
    return {
      webContentsId: window.webContents.id,
      onClosed: (listener) => window.once("closed", listener),
      close: () => window.close(),
      isDestroyed: () => window.isDestroyed(),
      focus: () => {
        if (window.isDestroyed()) return;
        const parent = deps.getMainWindow();
        if (parent && !parent.isDestroyed()) {
          if (!parent.isVisible()) parent.show();
          if (parent.isMinimized()) parent.restore();
        }
        if (process.platform === "darwin") app.focus({ steal: true });
        window.focus();
      },
      send: (channel, payload) => {
        if (!window.isDestroyed()) window.webContents.send(channel, payload);
      },
    };
  };

  const broker = new ConsentBroker(
    createConsentWindow,
    () => policy.sessions().filter((session) => session.revokedAt === null).map((session) => session.name),
    () => broadcast(),
  );

  const senderOf = (event: Electron.IpcMainInvokeEvent) => ({
    webContentsId: event.sender.id,
    isMainFrame: event.senderFrame === event.sender.mainFrame,
  });
  ipcMain.handle("diskhound:agent-consent-read", (event) => broker.read(senderOf(event)));
  ipcMain.handle("diskhound:agent-consent-decide", (event, decision: AgentConsentDecision) =>
    broker.decide(senderOf(event), decision),
  );

  // ── Service + Settings IPC ───────────────────────────────

  // The MCP SDK, Express, and the skill catalog load on first enable.
  // Requiring them costs ~150 ms, and most users never turn this on.
  let service: AgentAccessService | null = null;
  let servicePromise: Promise<AgentAccessService> | null = null;
  /** Why the runtime didn't load; Settings shows it with Try again. */
  let loadError: string | null = null;
  const ensureService = (): Promise<AgentAccessService> => {
    servicePromise ??= (async () => {
      const { AgentAccessService, loadSkillCatalog } = loadAgentRuntime();
      let skills: SkillCatalog = { skills: [] };
      try {
        skills = loadSkillCatalog(skillsDirectory(deps.projectRoot));
        deps.log("agent-access", `loaded ${skills.skills.length} skill(s): ${skills.skills.map((s) => s.name).join(", ")}`);
      } catch (err) {
        deps.log("agent-access", `skills failed to load: ${err instanceof Error ? err.message : String(err)}`);
      }
      service = new AgentAccessService({
        backend,
        activity,
        security,
        skills,
        policy,
        clientsFile,
        requestConsent: broker.request,
        onChanged: broadcast,
        port,
        saveEnabled: (enabled) => deps.setAgentsEnabled(enabled),
      });
      loadError = null;
      return service;
    })().catch((err: unknown) => {
      servicePromise = null;
      loadError = `DiskHound couldn't load agent access: ${err instanceof Error ? err.message : String(err)}`;
      broadcast();
      throw err;
    });
    return servicePromise;
  };
  const status = (): AgentAccessStatus =>
    service?.status() ?? {
      enabled: deps.getSettings().agents.enabled,
      listening: false,
      mcpUrl: agentAccessMcpUrl(port),
      port,
      ...(loadError ? { error: loadError } : {}),
    };
  // DISKHOUND_MCP_PATH swaps in another helper, as DISKHOUND_NATIVE_SCANNER_PATH does for the scanner.
  const stdioPath = () => process.env.DISKHOUND_MCP_PATH?.trim() || Path.join(
    app.isPackaged ? Path.join(process.resourcesPath, "native") : Path.join(deps.projectRoot, "native", "diskhound-mcp", "target", "debug"),
    process.platform === "win32" ? "diskhound-mcp.exe" : "diskhound-mcp",
  );
  const snapshot = (): AgentAccessSnapshot => ({
    status: status(),
    roles: BUILT_IN_MCP_ROLES.map((role) => ({ ...role, permissions: [...role.permissions] })),
    sessions: (() => {
      try {
        return policy.sessions();
      } catch {
        return [];
      }
    })(),
    activity: activity.list(),
    pending: broker.pending(),
    security: security.recent(),
    policyFile: policy.filePath,
    securityLogFile: security.filePath,
    stdioPath: stdioPath(),
    platform: process.platform,
  });
  const broadcast = () => mainWindowSend(AGENT_ACCESS_CHANGED_CHANNEL, snapshot());

  // Only Settings in the main window reads or changes agent access. The
  // widget and approval windows share the preload, so check the sender.
  const requireMainWindow = (event: Electron.IpcMainInvokeEvent) => {
    const main = deps.getMainWindow();
    if (!main || main.isDestroyed() || event.sender.id !== main.webContents.id || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Agent access is managed from the DiskHound main window.");
    }
  };

  ipcMain.handle("diskhound:agent-access-get", async (event) => {
    requireMainWindow(event);
    // The log on disk is only worth reading once agents are in use.
    if (deps.getSettings().agents.enabled || policy.exists()) await loadSecurityEvents();
    return snapshot();
  });
  ipcMain.handle("diskhound:agent-access-set-enabled", async (event, enabled: boolean) => {
    requireMainWindow(event);
    if (!enabled && !service) {
      await deps.setAgentsEnabled(false);
      broadcast();
      return snapshot();
    }
    await (await ensureService()).setEnabled(Boolean(enabled));
    if (enabled) await loadSecurityEvents();
    return snapshot();
  });
  ipcMain.handle("diskhound:agent-access-revoke", (event, sessionId: string) => {
    requireMainWindow(event);
    policy.revokeSession(sessionId);
    broadcast();
    return snapshot();
  });
  ipcMain.handle("diskhound:agent-access-assign-role", (event, sessionId: string, roleId: string) => {
    requireMainWindow(event);
    policy.assignRole(sessionId, roleId);
    broadcast();
    return snapshot();
  });
  ipcMain.handle("diskhound:agent-access-forget-revoked", (event) => {
    requireMainWindow(event);
    policy.forgetRevoked();
    broadcast();
    return snapshot();
  });
  ipcMain.handle("diskhound:agent-access-focus-approval", (event) => {
    requireMainWindow(event);
    return broker.focus();
  });
  ipcMain.handle("diskhound:agent-access-dismiss-approval", (event, requestId: string) => {
    requireMainWindow(event);
    broker.dismiss(String(requestId));
    return snapshot();
  });
  // Claude Desktop's extension, built from this app's helper and opened
  // in Claude, which asks the user to install it. Claude copies it on
  // install, so the file in temp only has to last until then.
  ipcMain.handle("diskhound:agent-access-add-to-claude", async (event): Promise<AddToClaudeResult> => {
    requireMainWindow(event);
    const file = Path.join(app.getPath("temp"), "DiskHound", "DiskHound.mcpb");
    try {
      await writeClaudeExtension(file, {
        helperPath: stdioPath(),
        iconPath: app.isPackaged ? Path.join(process.resourcesPath, "icon.png") : Path.join(deps.projectRoot, "build", "icon.png"),
        // Unpackaged, Electron reports its own version.
        version: app.isPackaged
          ? app.getVersion()
          : JSON.parse(await FS.readFile(Path.join(deps.projectRoot, "package.json"), "utf8")).version,
        port,
        platform: process.platform,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log("agent-access", `couldn't build the Claude extension: ${message}`);
      return {
        ok: false,
        error: (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "DiskHound's helper is missing. Reinstall DiskHound, or in a source checkout run bun run build:mcp:debug."
          : `Couldn't build the extension: ${message}`,
      };
    }
    const failed = await shell.openPath(file);
    if (failed) deps.log("agent-access", `couldn't open the Claude extension: ${failed}`);
    return failed ? { ok: false, error: `Couldn't open it in Claude: ${failed}`, file } : { ok: true, file };
  });

  const showSettings = async () => {
    await navigate({ view: "settings", section: "ai-agents", focus: true });
  };

  return {
    start: async () => {
      if (!deps.getSettings().agents.enabled) return;
      const started = await (await ensureService()).setEnabled(true, false);
      deps.log("agent-access", started.listening ? `listening on ${started.mcpUrl}` : `failed to start: ${started.error ?? "unknown"}`);
    },
    showSettings,
    dispose: async () => {
      broker.close();
      measurements?.dispose();
      await service?.dispose();
      await security.flush();
    },
  };
}
