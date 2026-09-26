// Shared fixtures for the MCP tests: a fake DiskhoundAgentBackend with
// plausible data for one scanned root, plus helpers for authorizations
// and the bundled skill catalog. Not a test file itself (no `.test.ts`).

import { fileURLToPath } from "node:url";
import { vi } from "vitest";

import type {
  CleanupAnalysis,
  DevArtifactReport,
  DiskSpaceInfo,
  FullDiffResult,
  IndexSearchResult,
  ScanDiffResult,
  ScanFileRecord,
  ScanHistoryEntry,
  ScanSnapshot,
} from "../../shared/contracts";
import { BUILT_IN_MCP_ROLES, type AgentActivityEntry } from "../../shared/agentAccess";
import type { McpAuthorization } from "../accessPolicy";
import type { AgentActivitySink, DiskhoundAgentBackend, DuplicateState, FolderChildren } from "../backend";

export const SKILLS_DIR = fileURLToPath(new URL("../../../skills", import.meta.url));
export const SERVER_SOURCE = fileURLToPath(new URL("../server.ts", import.meta.url));

export const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
export const ROOT = "/Users/test";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MB = 1024 ** 2;
const GB = 1024 ** 3;

function file(path: string, size: number, modifiedAt = NOW - 3 * DAY): ScanFileRecord {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return {
    path,
    name,
    parentPath: path.slice(0, slash) || "/",
    extension: dot > 0 ? name.slice(dot).toLowerCase() : "",
    size,
    modifiedAt,
  };
}

export const HISTORY: ScanHistoryEntry[] = [
  { id: "scan-3", rootPath: ROOT, scannedAt: NOW - HOUR, filesVisited: 120_000, directoriesVisited: 9_000, bytesSeen: 70 * GB, elapsedMs: 40_000, engine: "native-sidecar", sizeSemantics: "allocated" },
  { id: "scan-2", rootPath: ROOT, scannedAt: NOW - 2 * DAY, filesVisited: 118_000, directoriesVisited: 8_900, bytesSeen: 66 * GB, elapsedMs: 42_000, engine: "native-sidecar", sizeSemantics: "allocated" },
  { id: "scan-1", rootPath: ROOT, scannedAt: NOW - 10 * DAY, filesVisited: 110_000, directoriesVisited: 8_500, bytesSeen: 60 * GB, elapsedMs: 45_000, engine: "native-sidecar", sizeSemantics: "allocated" },
];

export const DRIVE: DiskSpaceInfo = {
  drive: "/",
  totalBytes: 500 * GB,
  freeBytes: 120 * GB,
  usedBytes: 380 * GB,
  usedPercent: 76.04,
  timestamp: NOW,
};

const ISO = file(`${ROOT}/Downloads/ubuntu.iso`, 5 * GB);
const MOV = file(`${ROOT}/Movies/trip.mov`, 3 * GB);

export const SNAPSHOT: ScanSnapshot = {
  status: "done",
  engine: "native-sidecar",
  rootPath: ROOT,
  scanOptions: {},
  startedAt: NOW - HOUR - 40_000,
  finishedAt: NOW - HOUR,
  elapsedMs: 40_000,
  filesVisited: 120_000,
  directoriesVisited: 9_000,
  skippedEntries: 3,
  bytesSeen: 70 * GB,
  largestFiles: [ISO, MOV],
  hottestDirectories: [
    { path: `${ROOT}/Developer`, size: 20 * GB, fileCount: 80_000, depth: 1 },
    { path: `${ROOT}/Library`, size: 40 * GB, fileCount: 30_000, depth: 1 },
  ],
  topExtensions: [
    { extension: ".iso", size: 5 * GB, count: 1 },
    { extension: ".mov", size: 3 * GB, count: 1 },
  ],
  errorMessage: null,
  lastUpdatedAt: NOW - HOUR,
  sizeSemantics: "allocated",
};

const EMPTY_CHILDREN: FolderChildren = {
  dirs: [],
  files: [],
  totalSize: 0,
  totalItemCount: 0,
  hiddenExcludedCount: 0,
  hiddenExcludedBytes: 0,
};

/** A small folder tree under ROOT, keyed by parent path. */
export const TREE: Record<string, FolderChildren> = {
  [ROOT]: {
    dirs: [
      { path: `${ROOT}/Developer`, size: 20 * GB, fileCount: 80_000 },
      { path: `${ROOT}/Library`, size: 40 * GB, fileCount: 30_000 },
      { path: `${ROOT}/Downloads`, size: 5 * GB, fileCount: 12 },
      { path: `${ROOT}/Movies`, size: 3 * GB, fileCount: 4 },
    ],
    files: [file(`${ROOT}/notes.txt`, 4096)],
    totalSize: 68 * GB + 4096,
    totalItemCount: 5,
    hiddenExcludedCount: 0,
    hiddenExcludedBytes: 0,
  },
  [`${ROOT}/Developer`]: {
    dirs: [
      { path: `${ROOT}/Developer/app`, size: 18 * GB, fileCount: 79_000 },
      { path: `${ROOT}/Developer/scratch`, size: 2 * GB, fileCount: 1_000 },
    ],
    files: [],
    totalSize: 20 * GB,
    totalItemCount: 2,
    hiddenExcludedCount: 1,
    hiddenExcludedBytes: 64 * MB,
  },
  [`${ROOT}/Downloads`]: {
    dirs: [],
    files: [ISO, file(`${ROOT}/Downloads/installer.dmg`, 400 * MB), file(`${ROOT}/Downloads/readme.pdf`, 2 * MB)],
    totalSize: 5 * GB,
    totalItemCount: 3,
    hiddenExcludedCount: 0,
    hiddenExcludedBytes: 0,
  },
};

const CLEANUP: CleanupAnalysis = {
  suggestions: [
    {
      id: "old-downloads",
      category: "old-downloads",
      risk: "low",
      title: "Old downloads",
      description: "Installers and disk images in Downloads.",
      paths: [ISO.path, `${ROOT}/Downloads/installer.dmg`],
      totalSize: 5 * GB + 400 * MB,
      fileCount: 2,
      reasoning: "Not opened in months.",
    },
  ],
  totalReclaimableBytes: 5 * GB + 400 * MB,
  analyzedAt: NOW - HOUR,
  scanRootPath: ROOT,
};

const DEV: DevArtifactReport = {
  artifacts: [
    {
      path: `${ROOT}/Developer/app/node_modules`,
      kind: "node-modules",
      projectPath: `${ROOT}/Developer/app`,
      projectName: "app",
      size: 2 * GB,
      fileCount: 50_000,
      previousSize: GB,
      deltaBytes: GB,
    },
    {
      path: `${ROOT}/Developer/app/target`,
      kind: "rust-target",
      projectPath: `${ROOT}/Developer/app`,
      projectName: "app",
      size: 6 * GB,
      fileCount: 9_000,
      previousSize: null,
      deltaBytes: null,
    },
  ],
  totalBytes: 8 * GB,
  totalFiles: 59_000,
  projectCount: 1,
  kindTotals: [
    { kind: "node-modules", size: 2 * GB, count: 1 },
    { kind: "rust-target", size: 6 * GB, count: 1 },
  ],
  generatedAt: NOW - HOUR,
  rootPath: ROOT,
};

function diffFor(baselineId: string, currentId: string): ScanDiffResult | null {
  const baseline = HISTORY.find((entry) => entry.id === baselineId);
  const current = HISTORY.find((entry) => entry.id === currentId);
  if (!baseline || !current) return null;
  return {
    baselineId,
    baselineScannedAt: baseline.scannedAt,
    currentId,
    currentScannedAt: current.scannedAt,
    rootPath: ROOT,
    totalBytesDelta: current.bytesSeen - baseline.bytesSeen,
    totalFilesDelta: current.filesVisited - baseline.filesVisited,
    totalDirsDelta: current.directoriesVisited - baseline.directoriesVisited,
    previousBytesSeen: baseline.bytesSeen,
    currentBytesSeen: current.bytesSeen,
    fileDeltas: [
      { path: ISO.path, name: ISO.name, extension: ".iso", kind: "added", size: ISO.size, previousSize: 0, deltaBytes: ISO.size },
    ],
    directoryDeltas: [
      { path: `${ROOT}/Downloads`, kind: "grew", size: 5 * GB, previousSize: 0, deltaBytes: 5 * GB, fileCount: 12, previousFileCount: 2 },
      { path: `${ROOT}/Library`, kind: "shrank", size: 40 * GB, previousSize: 41 * GB, deltaBytes: -GB, fileCount: 30_000, previousFileCount: 30_100 },
    ],
    extensionDeltas: [
      { extension: ".iso", size: 5 * GB, previousSize: 0, deltaBytes: 5 * GB, count: 1, previousCount: 0 },
    ],
    timeBetweenMs: current.scannedAt - baseline.scannedAt,
    sizeSemanticsChanged: false,
    hardlinkAccountingChanged: false,
    volumeAccountingChanged: false,
  };
}

function fullDiffFor(baselineId: string, currentId: string, limit: number): FullDiffResult | null {
  if (!HISTORY.some((entry) => entry.id === baselineId) || !HISTORY.some((entry) => entry.id === currentId)) return null;
  return {
    baselineId,
    currentId,
    totalChanges: 2,
    totalAdded: 1,
    totalRemoved: 1,
    totalGrew: 0,
    totalShrank: 0,
    totalBytesAdded: ISO.size,
    totalBytesRemoved: GB,
    changes: [
      { path: ISO.path, kind: "added" as const, size: ISO.size, previousSize: 0, deltaBytes: ISO.size },
      { path: `${ROOT}/Library/old.cache`, kind: "removed" as const, size: 0, previousSize: GB, deltaBytes: -GB },
    ].slice(0, limit),
    truncated: false,
  };
}

const NO_DUPLICATES: DuplicateState = { running: false, progress: null, analysis: null };

/**
 * Build a fake backend. Every method is a `vi.fn` so tests can assert on
 * calls or override one result with `mockResolvedValueOnce`.
 */
export function createFakeBackend() {
  const backend = {
    platform: "darwin" as NodeJS.Platform,
    appVersion: "9.9.9-test",
    listDrives: vi.fn<DiskhoundAgentBackend["listDrives"]>(async () => [{ ...DRIVE }]),
    activeScans: vi.fn<DiskhoundAgentBackend["activeScans"]>(async () => []),
    scannedRoots: vi.fn<DiskhoundAgentBackend["scannedRoots"]>(() => [HISTORY[0]!]),
    scanHistory: vi.fn<DiskhoundAgentBackend["scanHistory"]>((rootPath) => (rootPath === ROOT ? [...HISTORY] : [])),
    latestSnapshot: vi.fn<DiskhoundAgentBackend["latestSnapshot"]>(async (rootPath) => (rootPath === ROOT ? SNAPSHOT : null)),
    currentRoot: vi.fn<DiskhoundAgentBackend["currentRoot"]>(async () => ROOT),
    folderChildren: vi.fn<DiskhoundAgentBackend["folderChildren"]>(async (_rootPath, parentPath) => TREE[parentPath] ?? EMPTY_CHILDREN),
    searchIndex: vi.fn<DiskhoundAgentBackend["searchIndex"]>(async (): Promise<IndexSearchResult> => ({
      hits: [MOV, ISO],
      truncated: false,
      filesScanned: 120_000,
    })),
    cleanupSuggestions: vi.fn<DiskhoundAgentBackend["cleanupSuggestions"]>(async () => CLEANUP),
    devArtifacts: vi.fn<DiskhoundAgentBackend["devArtifacts"]>(async () => DEV),
    diff: vi.fn<DiskhoundAgentBackend["diff"]>(async (baselineId, currentId) => diffFor(baselineId, currentId)),
    fullDiff: vi.fn<DiskhoundAgentBackend["fullDiff"]>(async (baselineId, currentId, limit) => fullDiffFor(baselineId, currentId, limit)),
    duplicates: vi.fn<DiskhoundAgentBackend["duplicates"]>(() => NO_DUPLICATES),
    startScan: vi.fn<DiskhoundAgentBackend["startScan"]>(async (rootPath) => ({
      ...SNAPSHOT,
      rootPath,
      status: "running",
      finishedAt: null,
      startedAt: NOW,
    })),
    cancelScan: vi.fn<DiskhoundAgentBackend["cancelScan"]>(async () => undefined),
    startDuplicateScan: vi.fn<DiskhoundAgentBackend["startDuplicateScan"]>(() => undefined),
    navigate: vi.fn<DiskhoundAgentBackend["navigate"]>(async () => undefined),
    revealPath: vi.fn<DiskhoundAgentBackend["revealPath"]>(async () => ({ ok: true, message: "Revealed." })),
    confirmAndTrash: vi.fn<DiskhoundAgentBackend["confirmAndTrash"]>(async (request) => ({
      confirmed: true,
      results: request.paths.map((path) => ({ path, ok: true, message: "Moved to Trash.", sizeBytes: 100 * MB })),
    })),
  } satisfies DiskhoundAgentBackend;
  return backend;
}

export type FakeBackend = ReturnType<typeof createFakeBackend>;

/** Authorization for one of the built-in roles, as FixedMcpAuthorizer expects. */
export function roleAuthorization(roleId: string, sessionName = "Test Agent"): McpAuthorization {
  const role = BUILT_IN_MCP_ROLES.find((candidate) => candidate.id === roleId);
  if (!role) throw new Error(`unknown role ${roleId}`);
  return {
    sessionId: `session_${roleId}`,
    sessionName,
    roleId: role.id,
    roleName: role.name,
    capabilities: [...role.permissions],
  };
}

/** Activity sink that keeps every entry in call order. */
export class RecordingActivity implements AgentActivitySink {
  readonly entries: Omit<AgentActivityEntry, "id" | "at">[] = [];
  record(entry: Omit<AgentActivityEntry, "id" | "at">): void {
    this.entries.push(entry);
  }
}
