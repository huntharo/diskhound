import type {
  AppView,
  CleanupAnalysis,
  DevArtifactReport,
  DiskSpaceInfo,
  DuplicateAnalysis,
  DuplicateScanProgress,
  FullDiffResult,
  IndexSearchQuery,
  IndexSearchResult,
  PathActionResult,
  ScanDiffResult,
  ScanFileRecord,
  ScanHistoryEntry,
  ScanSnapshot,
  WindowViewState,
} from "../shared/contracts";
import type { AgentActivityEntry } from "../shared/agentAccess";

/**
 * Everything the MCP tool layer needs from DiskHound's main process.
 *
 * main.ts implements this over the same closures its IPC handlers use,
 * so an agent sees exactly what the UI sees and anything the agent
 * starts (a scan, a duplicate search) streams into the window through
 * the existing broadcast channels. The tool layer (server.ts) owns
 * validation, limits, formatting, and authorization; the backend owns
 * no policy.
 */
export interface DiskhoundAgentBackend {
  readonly platform: NodeJS.Platform;
  readonly appVersion: string;

  listDrives(): Promise<DiskSpaceInfo[]>;
  /** Roots with an in-flight scan, plus the live snapshot for each. */
  activeScans(): Promise<ScanSnapshot[]>;
  /** Every root that has at least one completed scan in history. */
  scannedRoots(): ScanHistoryEntry[];
  /** Newest-first history for one root. */
  scanHistory(rootPath: string): ScanHistoryEntry[];
  latestSnapshot(rootPath: string): Promise<ScanSnapshot | null>;
  /** The root the window is showing right now, if any. */
  currentRoot(): Promise<string | null>;
  /** The tab and root the main window reported last (null before it loads). */
  windowView?(): WindowViewState | null;

  folderChildren(rootPath: string, parentPath: string): Promise<FolderChildren>;
  searchIndex(rootPath: string, query: IndexSearchQuery): Promise<IndexSearchResult>;
  cleanupSuggestions(rootPath: string): Promise<CleanupAnalysis>;
  devArtifacts(rootPath: string): Promise<DevArtifactReport | null>;
  diff(baselineId: string, currentId: string): Promise<ScanDiffResult | null>;
  fullDiff(baselineId: string, currentId: string, limit: number): Promise<FullDiffResult | null>;
  duplicates(rootPath: string): DuplicateState;

  startScan(rootPath: string): Promise<ScanSnapshot>;
  cancelScan(rootPath: string): Promise<void>;
  startDuplicateScan(rootPath: string, minSizeBytes?: number): void;

  navigate(request: NavigateRequest): Promise<void>;
  revealPath(targetPath: string): Promise<PathActionResult>;
  /**
   * Show a native confirmation dialog in DiskHound and, only if the
   * user accepts, move each path to the Trash / Recycle Bin through the
   * same protected-folder checks the UI uses. Throws when none of the
   * paths can be offered (missing, or refused for agents).
   */
  confirmAndTrash(request: TrashRequest): Promise<TrashOutcome>;
}

export interface FolderChildren {
  dirs: { path: string; size: number; fileCount: number }[];
  files: ScanFileRecord[];
  totalSize: number;
  totalItemCount: number;
  hiddenExcludedCount: number;
  hiddenExcludedBytes: number;
}

export interface DuplicateState {
  running: boolean;
  progress: DuplicateScanProgress | null;
  analysis: DuplicateAnalysis | null;
}

export interface NavigateRequest {
  view: AppView;
  rootPath?: string;
  folderPath?: string;
  /** Bring the window to the front. Off by default so agents don't steal focus. */
  focus?: boolean;
}

export interface TrashRequest {
  sessionName: string;
  paths: string[];
  reason?: string;
  /**
   * Throws if the session may no longer trash. Requests queue behind
   * each other's dialogs, so the user may revoke the session (or change
   * its role) before this one's dialog would appear.
   */
  recheck?: () => Promise<void>;
  /** Aborted when the agent's request goes away or the MCP server stops. */
  signal?: AbortSignal;
}

export interface TrashOutcome {
  confirmed: boolean;
  results: { path: string; ok: boolean; message: string; sizeBytes: number | null }[];
}

/** Sink for the Settings "Recent agent actions" feed + header pill. */
export interface AgentActivitySink {
  record(entry: Omit<AgentActivityEntry, "id" | "at">): void;
}
