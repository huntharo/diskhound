import * as FS from "node:fs/promises";
import { createRequire } from "node:module";
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
  agentAccessMcpUrl,
  type AgentAccessSnapshot,
  type AgentAccessStatus,
  type AgentConsentDecision,
} from "../shared/agentAccess";
import { normPath } from "../shared/pathUtils";
import { McpPolicyStore } from "./accessPolicy";
import type { AgentAccessService } from "./agentAccessService";
import { AgentActivityLog } from "./activityLog";
import type { DiskhoundAgentBackend, FolderChildren, NavigateRequest, TrashOutcome, TrashRequest } from "./backend";
import { ConsentBroker, type ConsentWindow } from "./consentBroker";
import { isInside } from "./paths";
import type { SkillCatalog } from "./skills";
import { agentTrashRefusal, canonicalPath, outermostPaths } from "./trashGuard";

const NAVIGATE_VIEW_CHANNEL = "diskhound:navigate-view";
const PATHS_TRASHED_CHANNEL = "diskhound:paths-trashed";
const AGENT_ACCESS_CHANGED_CHANNEL = "diskhound:agent-access-changed";
const AGENT_ACTIVITY_CHANNEL = "diskhound:agent-activity";

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
}

export interface AgentHost {
  /** Start the MCP server if Settings has AI Agents on. */
  start(): Promise<void>;
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
 * DISKHOUND_AGENT_PORT moves the MCP server off 51733. The E2E suite
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

  const formatSize = (bytes: number | null) => {
    if (bytes === null) return "size unknown";
    if (bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** exp;
    return `${value.toFixed(value >= 100 || exp === 0 ? 0 : 1)} ${units[exp]}`;
  };

  // One confirmation dialog at a time; later requests queue behind it.
  let trashTail: Promise<unknown> = Promise.resolve();
  const confirmAndTrash = (request: TrashRequest): Promise<TrashOutcome> => {
    const hungUp = () =>
      new Error("The agent's request closed before DiskHound asked the user. Nothing was moved.");
    const run = async (): Promise<TrashOutcome> => {
      // This request may have waited behind other dialogs. If the agent
      // hung up, the server stopped, or the user revoked the session or
      // changed its role meanwhile, don't ask on its behalf.
      if (request.signal?.aborted) throw hungUp();
      await request.recheck?.();

      // Resolve each path to its on-disk spelling so the protected-folder
      // check (a string compare in main) sees what would actually move.
      const keep = await keepFolders();
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
        const why = agentTrashRefusal(target, keep);
        if (why) refused.push({ path: target, ok: false, message: `Refused: ${why}.`, sizeBytes: null });
        else offered.push(target);
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
      const bin = trashName();
      const { response } = await dialog.showMessageBox(main, {
        type: "warning",
        title: "DiskHound — agent request",
        message: `“${request.sessionName}” wants to move ${targets.length} item${targets.length === 1 ? "" : "s"}${totalText} to the ${bin}.`,
        detail:
          (request.reason ? `Reason: ${request.reason}\n\n` : "") +
          `${listed.join("\n")}\n\nYou can restore items from the ${bin} until it is emptied. Protected folders are always skipped.`,
        buttons: [`Move to ${bin}`, "Cancel"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        // Closes the dialog (as Cancel) if the agent hangs up or agents are turned off.
        signal: request.signal,
      });
      if (request.signal?.aborted) throw hungUp();
      if (response !== 0) {
        deps.log("agent-trash", `declined session="${request.sessionName}" paths=${targets.length}`);
        return { confirmed: false, results: [] };
      }
      const results: TrashOutcome["results"] = [...refused];
      for (const [index, target] of targets.entries()) {
        const result = await deps.trashPath(target);
        results.push({ path: target, ok: result.ok, message: result.message, sizeBytes: sizes[index] ?? null });
      }
      const moved = results.filter((r) => r.ok);
      deps.log("agent-trash", `session="${request.sessionName}" moved=${moved.length}/${results.length}`);
      if (moved.length > 0) {
        mainWindowSend(PATHS_TRASHED_CHANNEL, moved.map((r) => r.path));
        deps.toast(
          "success",
          `Moved ${moved.length} item${moved.length === 1 ? "" : "s"} to the ${bin}`,
          `Requested by ${request.sessionName}. Empty the ${bin} to free ${formatSize(moved.reduce((s, r) => s + (r.sizeBytes ?? 0), 0))}.`,
        );
      }
      return { confirmed: true, results };
    };
    const operation = trashTail.then(run, run);
    trashTail = operation.catch(() => undefined);
    return operation;
  };

  const backend: DiskhoundAgentBackend = {
    platform: process.platform,
    appVersion: app.getVersion(),
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
    confirmAndTrash,
  };

  // ── Approval window ──────────────────────────────────────

  const createConsentWindow = (): ConsentWindow => {
    const window = new BrowserWindow({
      width: 560,
      height: 680,
      minWidth: 480,
      minHeight: 560,
      show: false,
      title: "DiskHound — Approve agent access",
      backgroundColor: "#0a0a0f",
      alwaysOnTop: true,
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
      // The agent's login flow starts in a terminal or browser; pull
      // DiskHound forward so the user sees the request.
      if (process.platform === "darwin") app.focus({ steal: true });
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
    };
  };

  const broker = new ConsentBroker(createConsentWindow, () =>
    policy.sessions().filter((session) => session.revokedAt === null).map((session) => session.name),
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
        skills,
        policy,
        clientsFile,
        requestConsent: broker.request,
        onChanged: broadcast,
        port,
        saveEnabled: (enabled) => deps.setAgentsEnabled(enabled),
      });
      return service;
    })();
    return servicePromise;
  };
  const status = (): AgentAccessStatus =>
    service?.status() ?? {
      enabled: false,
      listening: false,
      mcpUrl: agentAccessMcpUrl(port),
      port,
    };
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
    policyFile: policy.filePath,
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

  ipcMain.handle("diskhound:agent-access-get", (event) => {
    requireMainWindow(event);
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

  return {
    start: async () => {
      if (!deps.getSettings().agents.enabled) return;
      const started = await (await ensureService()).setEnabled(true, false);
      deps.log("agent-access", started.listening ? `listening on ${started.mcpUrl}` : `failed to start: ${started.error ?? "unknown"}`);
    },
    dispose: async () => {
      broker.close();
      await service?.dispose();
    },
  };
}
