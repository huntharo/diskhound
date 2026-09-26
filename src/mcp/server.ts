import * as Path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult, GetPromptResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { AppView, ScanHistoryEntry, ScanSnapshot } from "../shared/contracts";
import { MCP_SERVER_NAME, type McpAgentCapability } from "../shared/agentAccess";
import { normPath } from "../shared/pathUtils";
import type { McpAccessError, McpAuthorization, McpAuthorizer } from "./accessPolicy";
import type { AgentActivitySink, DiskhoundAgentBackend } from "./backend";
import { agentPath, isInside } from "./paths";
import { registerSkills, type SkillCatalog } from "./skills";

/**
 * DiskHound's MCP surface: tools that read the same scan data the
 * window shows, a few that start work or steer the window, one that
 * asks the user to move items to the Trash, the SEP-2640 skills, and
 * prompt fallbacks for hosts that don't load MCP skills yet.
 *
 * One server is built per HTTP request (stateless Streamable HTTP, as
 * in PwrSnap), bound to that request's bearer token. Every tool call
 * re-authorizes against the policy file, so a revoke or role change in
 * Settings applies to the next call.
 */

export const FREE_UP_SPACE_SKILL = "skill://diskhound-free-up-space/SKILL.md";
export const INVESTIGATE_GROWTH_SKILL = "skill://diskhound-investigate-growth/SKILL.md";

/** Items per trash request. The dialog lists every one, so keep it readable. */
const MAX_TRASH_PATHS = 20;

const VIEWS = ["overview", "files", "folders", "dev", "duplicates", "easyMove", "changes", "settings"] as const;

const readOnly: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const startsWork: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const steersApp: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const trashes: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

export interface DiskhoundMcpServerOptions {
  backend: DiskhoundAgentBackend;
  authorizer: McpAuthorizer;
  activity: AgentActivitySink;
  skills: SkillCatalog;
  /** Aborted when the HTTP request behind this server closes. */
  signal?: AbortSignal;
  now?: () => number;
}

// ── Formatting helpers ──────────────────────────────────────

export function bytesText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(value >= 100 || exp === 0 ? 0 : 1)} ${units[exp]}`;
}

export function ageText(fromMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - fromMs) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function success(value: Record<string, unknown>, summary: string): CallToolResult {
  // MCP: a tool returning structuredContent SHOULD also serialize it
  // into a text block for clients that ignore structured output.
  return {
    content: [
      { type: "text", text: summary },
      { type: "text", text: JSON.stringify(value) },
    ],
    structuredContent: value,
  };
}

const SINCE_MS: Record<string, number> = {
  "1h": 3_600_000,
  "6h": 6 * 3_600_000,
  "1d": 86_400_000,
  "1w": 7 * 86_400_000,
  "1M": 30 * 86_400_000,
  "3M": 90 * 86_400_000,
};

function platformSpaceNote(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return "Trashed items keep using space until the Trash is emptied. On APFS, cloned files (e.g. pnpm node_modules, Finder duplicates) share blocks, and Time Machine local snapshots pin deleted data until they expire — free space can lag. See skill://diskhound-free-up-space/references/macos.md.";
  }
  if (platform === "win32") {
    return "Recycle Bin items keep using space until the bin is emptied. System Restore / Volume Shadow Copies can pin deleted data. See skill://diskhound-free-up-space/references/windows.md.";
  }
  return "Trashed items keep using space until the Trash is emptied. btrfs/ZFS snapshots and hardlinks (e.g. pnpm stores) can keep space in use after deletion. See skill://diskhound-free-up-space/references/linux.md.";
}

export function serverInstructions(platform: NodeJS.Platform): string {
  const os = platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : "Linux";
  return [
    `DiskHound is a disk-space analyzer running on the user's ${os} computer. Use these tools to find where space went and help the user reclaim it.`,
    "Start with diskhound_status (drives, scanned roots, active scans). If the drive has no recent scan, call diskhound_start_scan and poll diskhound_status until it finishes.",
    "Drill down with diskhound_list_folder from the scan root. Targeted views: diskhound_dev_artifacts (node_modules, build output, caches, worktrees), diskhound_cleanup_suggestions, diskhound_duplicates, diskhound_search_files, and diskhound_changes (what grew between scans).",
    `Before recommending deletions, read the skill ${FREE_UP_SPACE_SKILL} (resources/read works if your host does not load MCP skills). It covers cases where deleting files does not free space: APFS clones, Time Machine local snapshots, hardlinks, shadow copies, and snapshots on btrfs/ZFS. For "why did my disk fill up?", read ${INVESTIGATE_GROWTH_SKILL}.`,
    "The user may be watching DiskHound. Pass showInApp: true, or call diskhound_show, so the window follows along.",
    "Never delete on your own. diskhound_move_to_trash asks the user to confirm in DiskHound, and nothing here deletes permanently. Sizes are bytes on disk (allocated), not logical file length.",
  ].join("\n\n");
}

// ── Server ──────────────────────────────────────────────────

export function createDiskhoundMcpServer(options: DiskhoundMcpServerOptions): McpServer {
  const { backend, authorizer, activity, skills } = options;
  const now = options.now ?? Date.now;

  const mcp = new McpServer(
    { name: MCP_SERVER_NAME, title: "DiskHound", version: backend.appVersion },
    {
      // prompts and resources are added by the SDK when the first one
      // registers. Declaring them up front would advertise list methods
      // with no handler behind them when the skill catalog is empty.
      capabilities: { tools: {} },
      instructions: serverInstructions(backend.platform),
    },
  );

  type ToolOutcome = { value: Record<string, unknown>; summary: string; activity?: string };

  /**
   * Register a tool that authorizes, runs, and records itself in the
   * activity feed. Failures (including authorization) are recorded and
   * then rethrown so the SDK returns them as `isError` tool results.
   */
  const tool = <Shape extends ZodRawShapeCompat>(
    name: string,
    config: { title: string; description: string; inputSchema: Shape; annotations: ToolAnnotations },
    capabilities: (input: ShapeOutput<Shape>) => McpAgentCapability[],
    run: (input: ShapeOutput<Shape>, auth: McpAuthorization) => Promise<ToolOutcome>,
  ) => {
    mcp.registerTool(name, config, (async (input: ShapeOutput<Shape>) => {
      let auth: McpAuthorization | null = null;
      try {
        auth = await authorizer.authorize(capabilities(input));
        const outcome = await run(input, auth);
        activity.record({
          sessionId: auth.sessionId,
          sessionName: auth.sessionName,
          tool: name,
          summary: outcome.activity ?? outcome.summary.split("\n")[0]!.slice(0, 200),
          ok: true,
        });
        return success(outcome.value, outcome.summary);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A role that lacks the capability is worth showing in the feed:
        // it's the moment the user may want to change the Session's role.
        // Match on the code, not instanceof: the policy store lives in
        // main.cjs and this module in the lazily loaded runtime bundle,
        // so each has its own copy of McpAccessError.
        if (!auth && (error as Partial<McpAccessError> | null)?.code === "missing_capability") {
          auth = await authorizer.authorize([]).catch(() => null);
        }
        if (auth) {
          activity.record({
            sessionId: auth.sessionId,
            sessionName: auth.sessionName,
            tool: name,
            summary: message.slice(0, 200),
            ok: false,
          });
        }
        throw error;
      }
    }) as never);
  };

  const withNavigate = (showInApp: boolean | undefined): McpAgentCapability[] =>
    showInApp ? ["disk.read", "app.navigate"] : ["disk.read"];

  /** Map any path (or nothing) to the scan root whose data covers it. */
  const resolveRoot = async (pathInput?: string): Promise<string> => {
    const roots = backend.scannedRoots().map((entry) => entry.rootPath);
    if (pathInput) {
      const target = agentPath(pathInput, backend.platform);
      const covering = roots
        .filter((root) => isInside(root, target))
        .sort((a, b) => b.length - a.length)[0];
      if (covering) return covering;
      const active = (await backend.activeScans()).find((snap) => snap.rootPath && isInside(snap.rootPath, target));
      if (active?.rootPath) return active.rootPath;
      throw new Error(
        `DiskHound has no scan covering ${target}. Call diskhound_start_scan with a drive or folder that contains it.`,
      );
    }
    const current = await backend.currentRoot();
    if (current) return current;
    if (roots[0]) return roots[0];
    throw new Error("DiskHound has not scanned anything yet. Call diskhound_status to see drives, then diskhound_start_scan.");
  };

  const requireSnapshot = async (rootPath: string): Promise<ScanSnapshot> => {
    const snapshot = await backend.latestSnapshot(rootPath);
    if (!snapshot) {
      throw new Error(`No completed scan for ${rootPath}. Call diskhound_start_scan first.`);
    }
    return snapshot;
  };

  const navigateIf = async (showInApp: boolean | undefined, request: Parameters<DiskhoundAgentBackend["navigate"]>[0]) => {
    if (showInApp) await backend.navigate(request);
  };

  // ── Read tools ────────────────────────────────────────────

  tool(
    "diskhound_status",
    {
      title: "DiskHound status",
      description:
        "Start here. Returns every drive's capacity and free space, which roots DiskHound has scanned (and how long ago), scans in progress, what this Session is allowed to do, and the skills to read before recommending cleanup.",
      inputSchema: {},
      annotations: readOnly,
    },
    () => ["disk.read"],
    async (_input, auth) => {
      const [drives, active, current] = await Promise.all([
        backend.listDrives(),
        backend.activeScans(),
        backend.currentRoot(),
      ]);
      const roots = backend.scannedRoots();
      const nowMs = now();
      const value = {
        app: { name: "DiskHound", version: backend.appVersion, platform: backend.platform },
        session: { name: auth.sessionName, role: auth.roleName, capabilities: [...auth.capabilities] },
        drives: drives.map((drive) => ({
          drive: drive.drive,
          totalBytes: drive.totalBytes,
          freeBytes: drive.freeBytes,
          usedBytes: drive.usedBytes,
          usedPercent: Math.round(drive.usedPercent * 10) / 10,
          free: bytesText(drive.freeBytes),
          total: bytesText(drive.totalBytes),
        })),
        activeScans: active.map((snap) => ({
          rootPath: snap.rootPath,
          phase: snap.scanPhase ?? null,
          filesVisited: snap.filesVisited,
          bytesSeen: snap.bytesSeen,
          seen: bytesText(snap.bytesSeen),
          elapsedMs: snap.startedAt ? nowMs - snap.startedAt : snap.elapsedMs,
        })),
        scannedRoots: roots.map((entry) => ({
          rootPath: entry.rootPath,
          lastScannedAt: new Date(entry.scannedAt).toISOString(),
          age: ageText(entry.scannedAt, nowMs),
          bytesSeen: entry.bytesSeen,
          size: bytesText(entry.bytesSeen),
          files: entry.filesVisited,
          scansKept: backend.scanHistory(entry.rootPath).length,
        })),
        currentRoot: current,
        window: backend.windowView?.() ?? null,
        skills: [FREE_UP_SPACE_SKILL, INVESTIGATE_GROWTH_SKILL],
        note: platformSpaceNote(backend.platform),
      };
      const driveLine = drives
        .map((drive) => `${drive.drive} ${bytesText(drive.freeBytes)} free of ${bytesText(drive.totalBytes)}`)
        .join("; ");
      const rootLine = roots.length
        ? roots.map((entry) => `${entry.rootPath} (${ageText(entry.scannedAt, nowMs)})`).join(", ")
        : "none yet";
      const summary = [
        `Drives: ${driveLine || "none detected"}.`,
        `Scanned roots: ${rootLine}.`,
        active.length ? `Scanning now: ${active.map((snap) => snap.rootPath).join(", ")}.` : "No scans running.",
        value.window
          ? `The DiskHound window shows the ${value.window.view} tab${value.window.rootPath ? ` for ${value.window.rootPath}` : ""}.`
          : null,
        `Session "${auth.sessionName}" (${auth.roleName}) may: ${auth.capabilities.join(", ")}.`,
      ].filter(Boolean).join("\n");
      return { value, summary, activity: "Checked drives and scan status" };
    },
  );

  tool(
    "diskhound_scan_summary",
    {
      title: "Scan summary",
      description:
        "Overview of the latest completed scan for a root: totals, the largest files, the heaviest folders, and the file types using the most space. Omit rootPath to use the root the DiskHound window is showing.",
      inputSchema: {
        rootPath: z.string().min(1).max(4096).optional().describe("A scanned root, or any path inside one."),
        limit: z.number().int().min(1).max(100).default(15).describe("Rows per list (default 15)."),
        showInApp: z.boolean().optional().describe("Also switch the DiskHound window to this root's Overview."),
      },
      annotations: readOnly,
    },
    (input) => withNavigate(input.showInApp),
    async (input) => {
      const rootPath = await resolveRoot(input.rootPath);
      const snapshot = await requireSnapshot(rootPath);
      await navigateIf(input.showInApp, { view: "overview", rootPath });
      const nowMs = now();
      const scannedAt = snapshot.finishedAt ?? snapshot.lastUpdatedAt;
      const value = {
        rootPath,
        status: snapshot.status,
        scannedAt: new Date(scannedAt).toISOString(),
        age: ageText(scannedAt, nowMs),
        engine: snapshot.engine,
        sizeSemantics: snapshot.sizeSemantics ?? "allocated",
        totals: {
          bytes: snapshot.bytesSeen,
          size: bytesText(snapshot.bytesSeen),
          files: snapshot.filesVisited,
          directories: snapshot.directoriesVisited,
          skippedEntries: snapshot.skippedEntries,
        },
        largestFiles: snapshot.largestFiles.slice(0, input.limit).map((file) => ({
          path: file.path,
          sizeBytes: file.size,
          size: bytesText(file.size),
          modifiedAt: new Date(file.modifiedAt).toISOString(),
        })),
        heaviestFolders: [...snapshot.hottestDirectories]
          .sort((a, b) => b.size - a.size)
          .slice(0, input.limit)
          .map((dir) => ({ path: dir.path, sizeBytes: dir.size, size: bytesText(dir.size), fileCount: dir.fileCount })),
        topFileTypes: snapshot.topExtensions.slice(0, input.limit).map((bucket) => ({
          extension: bucket.extension,
          sizeBytes: bucket.size,
          size: bytesText(bucket.size),
          count: bucket.count,
        })),
      };
      const top = value.heaviestFolders.slice(0, 5).map((dir) => `${dir.path} (${dir.size})`).join(", ");
      const summary =
        `${rootPath}: ${bytesText(snapshot.bytesSeen)} in ${snapshot.filesVisited.toLocaleString()} files, scanned ${value.age}.` +
        (top ? `\nHeaviest folders: ${top}.` : "");
      return { value, summary, activity: `Summarized ${rootPath}` };
    },
  );

  tool(
    "diskhound_list_folder",
    {
      title: "List folder",
      description:
        "Immediate subfolders and files of one folder from the latest scan, largest first, with sizes on disk. This is the main drill-down tool: start at the scan root and follow the biggest folders. Uses scan data, so it is instant and does not touch the disk.",
      inputSchema: {
        path: z.string().min(1).max(4096).describe("Absolute path of the folder to list (must be inside a scanned root)."),
        limit: z.number().int().min(1).max(200).default(30).describe("Max folders and max files to return (default 30 each)."),
        includeFiles: z.boolean().default(true).describe("Include loose files in this folder (default true)."),
        showInApp: z.boolean().optional().describe("Also open this folder in DiskHound's Folders tab."),
      },
      annotations: readOnly,
    },
    (input) => withNavigate(input.showInApp),
    async (input) => {
      const folderPath = agentPath(input.path, backend.platform);
      const rootPath = await resolveRoot(folderPath);
      const children = await backend.folderChildren(rootPath, folderPath);
      if (children.totalItemCount === 0 && normPath(folderPath) !== normPath(rootPath)) {
        throw new Error(
          `The latest scan of ${rootPath} has nothing recorded under ${folderPath}. Check the path with diskhound_list_folder on its parent.`,
        );
      }
      await navigateIf(input.showInApp, { view: "folders", rootPath, folderPath });
      const total = children.totalSize || 1;
      const folders = [...children.dirs].sort((a, b) => b.size - a.size);
      const files = [...children.files].sort((a, b) => b.size - a.size);
      const value = {
        rootPath,
        path: folderPath,
        totalBytes: children.totalSize,
        total: bytesText(children.totalSize),
        folderCount: folders.length,
        fileCount: files.length,
        folders: folders.slice(0, input.limit).map((dir) => ({
          path: dir.path,
          name: Path.basename(dir.path),
          sizeBytes: dir.size,
          size: bytesText(dir.size),
          percent: Math.round((dir.size / total) * 1000) / 10,
          fileCount: dir.fileCount,
        })),
        files: input.includeFiles
          ? files.slice(0, input.limit).map((file) => ({
              path: file.path,
              name: file.name,
              sizeBytes: file.size,
              size: bytesText(file.size),
              modifiedAt: new Date(file.modifiedAt).toISOString(),
            }))
          : [],
        truncated: folders.length > input.limit || (input.includeFiles && files.length > input.limit),
        hiddenByProtectedFolders:
          children.hiddenExcludedCount > 0
            ? { count: children.hiddenExcludedCount, bytes: children.hiddenExcludedBytes, size: bytesText(children.hiddenExcludedBytes) }
            : null,
      };
      const top = value.folders.slice(0, 6).map((dir) => `${dir.name} ${dir.size}`).join(", ");
      const summary =
        `${folderPath}: ${value.total} in ${folders.length} folders and ${files.length} files.` +
        (top ? `\nLargest: ${top}.` : "");
      return { value, summary, activity: `Listed ${folderPath} (${value.total})` };
    },
  );

  tool(
    "diskhound_search_files",
    {
      title: "Search files",
      description:
        "Search every file in the latest scan index by path substring, extension, and minimum size; returns the largest matches first. Omit query to match all files (useful with minSizeBytes to find everything over, say, 1 GB).",
      inputSchema: {
        query: z.string().max(512).optional().describe("Case-insensitive substring of the full path, e.g. 'Downloads' or '.iso'."),
        rootPath: z.string().min(1).max(4096).optional().describe("A scanned root, or any path inside one."),
        extension: z.string().max(32).optional().describe("Only this extension, e.g. '.mov'."),
        minSizeBytes: z.number().int().min(0).optional().describe("Only files at least this large."),
        limit: z.number().int().min(1).max(500).default(50).describe("Max results (default 50)."),
      },
      annotations: readOnly,
    },
    () => ["disk.read"],
    async (input) => {
      const rootPath = await resolveRoot(input.rootPath);
      const extension = input.extension
        ? (input.extension.startsWith(".") ? input.extension : `.${input.extension}`).toLowerCase()
        : undefined;
      const result = await backend.searchIndex(rootPath, {
        query: input.query?.trim() || (backend.platform === "win32" ? "\\" : "/"),
        extension,
        minSizeBytes: input.minSizeBytes,
        limit: input.limit,
      });
      const hits = [...result.hits].sort((a, b) => b.size - a.size);
      const matchedBytes = hits.reduce((sum, hit) => sum + hit.size, 0);
      const value = {
        rootPath,
        filesScanned: result.filesScanned,
        truncated: result.truncated,
        matchedBytes,
        matched: bytesText(matchedBytes),
        results: hits.map((hit) => ({
          path: hit.path,
          sizeBytes: hit.size,
          size: bytesText(hit.size),
          modifiedAt: new Date(hit.modifiedAt).toISOString(),
        })),
      };
      const summary = `${hits.length}${result.truncated ? "+" : ""} matches in ${rootPath} totalling ${value.matched}.`;
      return { value, summary, activity: `Searched ${rootPath}${input.query ? ` for "${input.query}"` : ""}` };
    },
  );

  tool(
    "diskhound_cleanup_suggestions",
    {
      title: "Cleanup suggestions",
      description:
        "DiskHound's rule-based cleanup suggestions for a root (temp files, caches, old downloads, installers, logs, large media) with a risk level and reasoning for each. Treat these as leads to verify with the user, not a delete list.",
      inputSchema: {
        rootPath: z.string().min(1).max(4096).optional().describe("A scanned root, or any path inside one."),
        pathsPerSuggestion: z.number().int().min(1).max(50).default(8).describe("Example paths per suggestion (default 8)."),
      },
      annotations: readOnly,
    },
    () => ["disk.read"],
    async (input) => {
      const rootPath = await resolveRoot(input.rootPath);
      const analysis = await backend.cleanupSuggestions(rootPath);
      const suggestions = [...analysis.suggestions].sort((a, b) => b.totalSize - a.totalSize);
      const value = {
        rootPath,
        totalReclaimableBytes: analysis.totalReclaimableBytes,
        totalReclaimable: bytesText(analysis.totalReclaimableBytes),
        suggestions: suggestions.map((suggestion) => ({
          title: suggestion.title,
          category: suggestion.category,
          risk: suggestion.risk,
          sizeBytes: suggestion.totalSize,
          size: bytesText(suggestion.totalSize),
          fileCount: suggestion.fileCount,
          description: suggestion.description,
          reasoning: suggestion.reasoning,
          examplePaths: suggestion.paths.slice(0, input.pathsPerSuggestion),
          morePaths: Math.max(0, suggestion.paths.length - input.pathsPerSuggestion),
        })),
        note: platformSpaceNote(backend.platform),
      };
      const summary =
        `${suggestions.length} suggestions for ${rootPath}, up to ${value.totalReclaimable} reclaimable.` +
        (suggestions.length
          ? `\n${suggestions.slice(0, 5).map((s) => `${s.title}: ${bytesText(s.totalSize)} (${s.risk} risk)`).join("\n")}`
          : "");
      return { value, summary, activity: `Reviewed cleanup suggestions for ${rootPath}` };
    },
  );

  tool(
    "diskhound_dev_artifacts",
    {
      title: "Developer artifacts",
      description:
        "Developer disk hogs found in the latest scan, grouped by kind: git worktrees, node_modules, Rust target/, JS build output, Python venvs, Go/JVM/.NET caches, package caches, compiler caches. Each entry names its project, size, and growth since the previous scan.",
      inputSchema: {
        rootPath: z.string().min(1).max(4096).optional().describe("A scanned root, or any path inside one."),
        kind: z
          .enum(["worktree", "node-modules", "package-cache", "rust-target", "cargo-registry", "js-build", "python", "go-module", "jvm", "dotnet", "compiler-cache", "cmake-build", "diag-logs"])
          .optional()
          .describe("Only this kind."),
        limit: z.number().int().min(1).max(200).default(30).describe("Max artifacts (default 30)."),
        showInApp: z.boolean().optional().describe("Also open DiskHound's Dev Artifacts tab."),
      },
      annotations: readOnly,
    },
    (input) => withNavigate(input.showInApp),
    async (input) => {
      const rootPath = await resolveRoot(input.rootPath);
      const report = await backend.devArtifacts(rootPath);
      await navigateIf(input.showInApp, { view: "dev", rootPath });
      if (!report) {
        return {
          value: { rootPath, artifacts: [], kindTotals: [], totalBytes: 0 },
          summary: `No developer artifacts recorded for ${rootPath}. Re-scan the root to build the Dev Artifacts index.`,
        };
      }
      const artifacts = report.artifacts
        .filter((artifact) => !input.kind || artifact.kind === input.kind)
        .sort((a, b) => b.size - a.size);
      const notes: string[] = [];
      if (backend.platform === "darwin" && artifacts.some((a) => a.kind === "node-modules" || a.kind === "package-cache")) {
        notes.push(
          "On APFS, pnpm (and other tools using clonefile) clone package files from a shared store, so node_modules trees share blocks with the store and each other. Deleting one tree frees only its unshared blocks; the space returns when the last clone (including the store copy, via `pnpm store prune`) is gone.",
        );
      }
      if (backend.platform !== "darwin" && backend.platform !== "win32" && artifacts.some((a) => a.kind === "node-modules")) {
        notes.push(
          "On Linux, pnpm hardlinks node_modules files to its store. DiskHound counts each link, so node_modules sizes can overstate what deleting them frees; prune the store (`pnpm store prune`) to release shared data.",
        );
      }
      const value = {
        rootPath,
        totalBytes: report.totalBytes,
        total: bytesText(report.totalBytes),
        projectCount: report.projectCount,
        kindTotals: report.kindTotals
          .slice()
          .sort((a, b) => b.size - a.size)
          .map((bucket) => ({ kind: bucket.kind, sizeBytes: bucket.size, size: bytesText(bucket.size), count: bucket.count })),
        artifacts: artifacts.slice(0, input.limit).map((artifact) => ({
          path: artifact.path,
          kind: artifact.kind,
          project: artifact.projectName,
          projectPath: artifact.projectPath,
          sizeBytes: artifact.size,
          size: bytesText(artifact.size),
          fileCount: artifact.fileCount,
          growthSincePreviousScan: artifact.deltaBytes === null ? null : bytesText(Math.abs(artifact.deltaBytes)) + (artifact.deltaBytes < 0 ? " smaller" : " larger"),
        })),
        truncated: artifacts.length > input.limit,
        notes,
      };
      const summary =
        `${value.total} of developer artifacts across ${report.projectCount} projects in ${rootPath}.` +
        `\n${value.kindTotals.slice(0, 6).map((bucket) => `${bucket.kind}: ${bucket.size} (${bucket.count})`).join(", ")}`;
      return { value, summary, activity: `Reviewed dev artifacts in ${rootPath}` };
    },
  );

  tool(
    "diskhound_scan_history",
    {
      title: "Scan history",
      description: "Completed scans DiskHound kept for a root, newest first, with totals. Use the ids with diskhound_changes.",
      inputSchema: {
        rootPath: z.string().min(1).max(4096).optional().describe("A scanned root, or any path inside one."),
      },
      annotations: readOnly,
    },
    () => ["disk.read"],
    async (input) => {
      const rootPath = await resolveRoot(input.rootPath);
      const nowMs = now();
      const history = backend.scanHistory(rootPath);
      const value = {
        rootPath,
        scans: history.map((entry) => ({
          id: entry.id,
          scannedAt: new Date(entry.scannedAt).toISOString(),
          age: ageText(entry.scannedAt, nowMs),
          bytesSeen: entry.bytesSeen,
          size: bytesText(entry.bytesSeen),
          files: entry.filesVisited,
          engine: entry.engine ?? null,
        })),
      };
      const summary = `${history.length} scans kept for ${rootPath}` +
        (history.length ? `, newest ${ageText(history[0]!.scannedAt, nowMs)}, oldest ${ageText(history[history.length - 1]!.scannedAt, nowMs)}.` : ".");
      return { value, summary, activity: `Read scan history for ${rootPath}` };
    },
  );

  tool(
    "diskhound_changes",
    {
      title: "Changes between scans",
      description:
        "What grew, shrank, appeared, or disappeared between two scans of a root. By default compares the latest scan with the one before it; pass since (1h, 6h, 1d, 1w, 1M, 3M) or explicit scan ids from diskhound_scan_history. detail='summary' gives the biggest folder, file, and file-type deltas; detail='files' walks the full per-file index (slower on big drives).",
      inputSchema: {
        rootPath: z.string().min(1).max(4096).optional().describe("A scanned root, or any path inside one."),
        since: z.enum(["1h", "6h", "1d", "1w", "1M", "3M"]).optional().describe("Compare against the newest scan at least this old."),
        baselineId: z.string().max(200).optional().describe("Older scan id."),
        currentId: z.string().max(200).optional().describe("Newer scan id (default: latest)."),
        detail: z.enum(["summary", "files"]).default("summary"),
        limit: z.number().int().min(1).max(200).default(25).describe("Rows per list (default 25)."),
        showInApp: z.boolean().optional().describe("Also open DiskHound's Changes tab."),
      },
      annotations: readOnly,
    },
    (input) => withNavigate(input.showInApp),
    async (input) => {
      const rootPath = await resolveRoot(input.rootPath);
      const history = backend.scanHistory(rootPath);
      const current: ScanHistoryEntry | undefined = input.currentId
        ? history.find((entry) => entry.id === input.currentId)
        : history[0];
      if (!current) throw new Error(`No scan ${input.currentId ?? ""} for ${rootPath}.`);
      let baseline: ScanHistoryEntry | undefined;
      if (input.baselineId) {
        baseline = history.find((entry) => entry.id === input.baselineId);
      } else if (input.since) {
        const cutoff = current.scannedAt - SINCE_MS[input.since]!;
        baseline = history.find((entry) => entry.scannedAt <= cutoff) ?? history[history.length - 1];
      } else {
        baseline = history.find((entry) => entry.scannedAt < current.scannedAt);
      }
      if (!baseline || baseline.id === current.id) {
        throw new Error(`Only one scan of ${rootPath} is kept, so there is nothing to compare yet. Run another scan later.`);
      }
      await navigateIf(input.showInApp, { view: "changes", rootPath });
      const span = `${ageText(baseline.scannedAt, now())} → ${ageText(current.scannedAt, now())}`;
      if (input.detail === "files") {
        const full = await backend.fullDiff(baseline.id, current.id, input.limit);
        if (!full) throw new Error("The per-file index for one of these scans is missing; try detail='summary'.");
        const value = {
          rootPath,
          baselineId: baseline.id,
          currentId: current.id,
          span,
          totals: {
            changes: full.totalChanges,
            added: full.totalAdded,
            removed: full.totalRemoved,
            grew: full.totalGrew,
            shrank: full.totalShrank,
            bytesAdded: full.totalBytesAdded,
            bytesRemoved: full.totalBytesRemoved,
            net: `${full.totalBytesAdded >= full.totalBytesRemoved ? "+" : "-"}${bytesText(Math.abs(full.totalBytesAdded - full.totalBytesRemoved))}`,
          },
          changes: full.changes.map((change) => ({
            path: change.path,
            kind: change.kind,
            deltaBytes: change.deltaBytes,
            delta: `${change.deltaBytes >= 0 ? "+" : "-"}${bytesText(Math.abs(change.deltaBytes))}`,
            size: bytesText(change.size),
          })),
          truncated: full.truncated,
        };
        return {
          value,
          summary: `${full.totalChanges.toLocaleString()} file changes in ${rootPath} (${span}), net ${value.totals.net}.`,
          activity: `Compared scans of ${rootPath} (${span})`,
        };
      }
      const diff = await backend.diff(baseline.id, current.id);
      if (!diff) throw new Error("One of these scans could not be loaded.");
      const signed = (bytes: number) => `${bytes >= 0 ? "+" : "-"}${bytesText(Math.abs(bytes))}`;
      const value = {
        rootPath,
        baselineId: baseline.id,
        currentId: current.id,
        span,
        netBytes: diff.totalBytesDelta,
        net: signed(diff.totalBytesDelta),
        filesDelta: diff.totalFilesDelta,
        sizeSemanticsChanged: diff.sizeSemanticsChanged,
        hardlinkAccountingChanged: diff.hardlinkAccountingChanged,
        volumeAccountingChanged: diff.volumeAccountingChanged,
        folders: [...diff.directoryDeltas]
          .sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes))
          .slice(0, input.limit)
          .map((dir) => ({ path: dir.path, kind: dir.kind, deltaBytes: dir.deltaBytes, delta: signed(dir.deltaBytes), size: bytesText(dir.size) })),
        files: [...diff.fileDeltas]
          .sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes))
          .slice(0, input.limit)
          .map((file) => ({ path: file.path, kind: file.kind, deltaBytes: file.deltaBytes, delta: signed(file.deltaBytes), size: bytesText(file.size) })),
        fileTypes: [...diff.extensionDeltas]
          .sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes))
          .slice(0, input.limit)
          .map((ext) => ({ extension: ext.extension, deltaBytes: ext.deltaBytes, delta: signed(ext.deltaBytes) })),
        note: "Folder and file lists are the top movers DiskHound tracks per scan; use detail='files' for every file.",
      };
      const top = value.folders.slice(0, 5).map((dir) => `${dir.path} ${dir.delta}`).join(", ");
      // Same caveats the Changes tab shows: a change in accounting moves
      // the totals without any file changing.
      const caveat = diff.sizeSemanticsChanged
        ? "\nThese scans measured sizes differently (file size vs size on disk), so the totals aren't comparable. Compare two scans taken after the next one."
        : diff.hardlinkAccountingChanged
          ? "\nThe older scan counted a hardlinked file once per link; newer scans count it once. Part of this change is accounting, not space freed or used."
          : diff.volumeAccountingChanged
            ? "\nThe older scan walked the macOS Data volume twice and counted other mounted disks; newer scans count each folder once and stay on their disk. Part of this change is accounting, not space freed or used."
            : "";
      return {
        value,
        summary: `${rootPath} changed ${value.net} (${span}).` + (top ? `\nBiggest folder moves: ${top}.` : "") + caveat,
        activity: `Compared scans of ${rootPath} (${span})`,
      };
    },
  );

  tool(
    "diskhound_duplicates",
    {
      title: "Duplicate files",
      description:
        "Results of the most recent duplicate-file search for a root (content-hash matches), largest reclaimable groups first, or its progress if still running. Start one with diskhound_find_duplicates.",
      inputSchema: {
        rootPath: z.string().min(1).max(4096).optional().describe("The root the duplicate search ran on."),
        limit: z.number().int().min(1).max(200).default(20).describe("Max groups (default 20)."),
        showInApp: z.boolean().optional().describe("Also open DiskHound's Duplicates tab."),
      },
      annotations: readOnly,
    },
    (input) => withNavigate(input.showInApp),
    async (input) => {
      const rootPath = input.rootPath ? agentPath(input.rootPath, backend.platform) : await resolveRoot();
      const state = backend.duplicates(rootPath);
      await navigateIf(input.showInApp, { view: "duplicates", rootPath });
      if (!state.analysis) {
        const progress = state.progress;
        return {
          value: {
            rootPath,
            running: state.running,
            progress: progress
              ? { status: progress.status, filesWalked: progress.filesWalked, filesHashed: progress.filesHashed, groupsConfirmed: progress.groupsConfirmed, errorMessage: progress.errorMessage }
              : null,
          },
          summary: state.running
            ? `Duplicate search on ${rootPath} is running (${progress?.filesHashed ?? 0} files hashed). Check again shortly.`
            : `No duplicate search results for ${rootPath}. Start one with diskhound_find_duplicates.`,
        };
      }
      const analysis = state.analysis;
      const groups = [...analysis.groups]
        .map((group) => ({ group, wasted: group.size * Math.max(0, group.files.length - 1) }))
        .sort((a, b) => b.wasted - a.wasted);
      const value = {
        rootPath: analysis.rootPath,
        running: state.running,
        analyzedAt: new Date(analysis.analyzedAt).toISOString(),
        totalGroups: analysis.totalGroups,
        totalDuplicateFiles: analysis.totalDuplicateFiles,
        reclaimableBytes: analysis.totalWastedBytes,
        reclaimable: bytesText(analysis.totalWastedBytes),
        groups: groups.slice(0, input.limit).map(({ group, wasted }) => ({
          fileSizeBytes: group.size,
          fileSize: bytesText(group.size),
          copies: group.files.length,
          reclaimable: bytesText(wasted),
          files: group.files.slice(0, 12).map((file) => ({ path: file.path, modifiedAt: new Date(file.modifiedAt).toISOString() })),
        })),
        truncated: groups.length > input.limit,
        note:
          backend.platform === "darwin"
            ? "Identical content is not always duplicated storage: APFS clones and hardlinks share blocks, so deleting one copy may free nothing. Confirm with the user before removing copies."
            : "Identical content is not always duplicated storage: hardlinks (and reflinks on btrfs/XFS/ReFS) share blocks. Keep the copy the user actually uses.",
      };
      return {
        value,
        summary: `${analysis.totalGroups} duplicate groups in ${analysis.rootPath}, ${value.reclaimable} reclaimable if extra copies are removed.`,
        activity: `Reviewed duplicates in ${analysis.rootPath}`,
      };
    },
  );

  // ── Tools that start work ────────────────────────────────

  tool(
    "diskhound_start_scan",
    {
      title: "Start scan",
      description:
        "Scan a drive or folder (metadata only; no files are changed). Repeat scans of the same root are incremental and fast. Returns immediately; poll diskhound_status until the root leaves activeScans, then use the read tools. Refuses to restart a running scan unless restart is true.",
      inputSchema: {
        rootPath: z.string().min(1).max(4096).describe("Drive root (e.g. '/', 'C:\\\\') or any folder."),
        restart: z.boolean().default(false).describe("Cancel and restart if this root is already scanning."),
        showInApp: z.boolean().default(true).describe("Switch the DiskHound window to this root so the user sees progress (default true)."),
      },
      annotations: startsWork,
    },
    (input) => (input.showInApp ? ["scan.run", "app.navigate"] : ["scan.run"]),
    async (input) => {
      const rootPath = agentPath(input.rootPath, backend.platform);
      const running = (await backend.activeScans()).find((snap) => snap.rootPath && normPath(snap.rootPath) === normPath(rootPath));
      if (running && !input.restart) {
        return {
          value: { rootPath, started: false, alreadyRunning: true, filesVisited: running.filesVisited, bytesSeen: running.bytesSeen },
          summary: `A scan of ${rootPath} is already running (${running.filesVisited.toLocaleString()} files so far). Poll diskhound_status.`,
          activity: `Checked running scan of ${rootPath}`,
        };
      }
      const snapshot = await backend.startScan(rootPath);
      await navigateIf(input.showInApp, { view: "overview", rootPath });
      const finished = snapshot.status === "done";
      return {
        value: { rootPath, started: true, status: snapshot.status, engine: snapshot.engine },
        summary: finished
          ? `Nothing changed on ${rootPath} since the last scan; DiskHound reused it. Read results now.`
          : `Scan of ${rootPath} started (${snapshot.engine}). Poll diskhound_status until it finishes.`,
        activity: `Started a scan of ${rootPath}`,
      };
    },
  );

  tool(
    "diskhound_cancel_scan",
    {
      title: "Cancel scan",
      description: "Cancel the running scan for a root. The previous completed scan stays available.",
      inputSchema: {
        rootPath: z.string().min(1).max(4096).describe("The root being scanned."),
      },
      annotations: steersApp,
    },
    () => ["scan.run"],
    async (input) => {
      const rootPath = agentPath(input.rootPath, backend.platform);
      await backend.cancelScan(rootPath);
      return { value: { rootPath, cancelled: true }, summary: `Cancelled the scan of ${rootPath} (if one was running).` };
    },
  );

  tool(
    "diskhound_find_duplicates",
    {
      title: "Find duplicate files",
      description:
        "Start a duplicate-file search (content hashing) under a folder or drive. Uses the latest scan index when one covers the path, which is much faster than walking the disk. Returns immediately; read results with diskhound_duplicates. Hashing a whole drive can take many minutes — prefer a specific folder like Downloads or a media library.",
      inputSchema: {
        rootPath: z.string().min(1).max(4096).describe("Folder or drive to search."),
        minSizeBytes: z.number().int().min(0).default(1024 * 1024).describe("Ignore files smaller than this (default 1 MiB)."),
        showInApp: z.boolean().default(true).describe("Open DiskHound's Duplicates tab on this root (default true)."),
      },
      annotations: startsWork,
    },
    (input) => (input.showInApp ? ["scan.run", "app.navigate"] : ["scan.run"]),
    async (input) => {
      const rootPath = agentPath(input.rootPath, backend.platform);
      const state = backend.duplicates(rootPath);
      if (state.running) {
        return {
          value: { rootPath, started: false, alreadyRunning: true },
          summary: `A duplicate search on ${rootPath} is already running. Read progress with diskhound_duplicates.`,
        };
      }
      backend.startDuplicateScan(rootPath, input.minSizeBytes);
      await navigateIf(input.showInApp, { view: "duplicates", rootPath });
      return {
        value: { rootPath, started: true, minSizeBytes: input.minSizeBytes },
        summary: `Duplicate search started on ${rootPath}. Poll diskhound_duplicates for progress and results.`,
        activity: `Started a duplicate search in ${rootPath}`,
      };
    },
  );

  // ── Tools that steer the window ──────────────────────────

  tool(
    "diskhound_show",
    {
      title: "Show in DiskHound",
      description:
        "Point the DiskHound window at something so the user can see it: a tab (overview, files, folders, dev, duplicates, easyMove, changes, settings), optionally a scan root, and for the Folders tab a folder to open. Does not steal focus unless focus is true.",
      inputSchema: {
        view: z.enum(VIEWS).describe("Tab to show."),
        rootPath: z.string().min(1).max(4096).optional().describe("Scan root to show (default: current)."),
        folderPath: z.string().min(1).max(4096).optional().describe("With view='folders', the folder to open."),
        focus: z.boolean().default(false).describe("Bring the window to the front."),
      },
      annotations: steersApp,
    },
    () => ["app.navigate"],
    async (input) => {
      const folderPath = input.folderPath ? agentPath(input.folderPath, backend.platform) : undefined;
      const rootPath = input.rootPath
        ? agentPath(input.rootPath, backend.platform)
        : folderPath
          ? await resolveRoot(folderPath)
          : undefined;
      await backend.navigate({ view: input.view as AppView, rootPath, folderPath, focus: input.focus });
      const target = folderPath ?? rootPath;
      return {
        value: { view: input.view, rootPath: rootPath ?? null, folderPath: folderPath ?? null },
        summary: `DiskHound is showing ${input.view}${target ? ` for ${target}` : ""}.`,
      };
    },
  );

  tool(
    "diskhound_reveal_path",
    {
      title: "Reveal in file manager",
      description: "Open Finder / Explorer / the Linux file manager with this file or folder selected, so the user can inspect it themselves.",
      inputSchema: {
        path: z.string().min(1).max(4096).describe("Absolute path to reveal."),
      },
      annotations: steersApp,
    },
    () => ["app.navigate"],
    async (input) => {
      const target = agentPath(input.path, backend.platform);
      const result = await backend.revealPath(target);
      if (!result.ok) throw new Error(result.message);
      return { value: { path: target, revealed: true }, summary: `Revealed ${target}.` };
    },
  );

  // ── Trash (user-confirmed) ───────────────────────────────

  tool(
    "diskhound_move_to_trash",
    {
      title: "Move to Trash (asks the user)",
      description:
        "Ask the user to move files or folders to the Trash / Recycle Bin. DiskHound shows a confirmation dialog listing every item and its size; nothing moves unless the user clicks Move to Trash, and nothing is permanently deleted. Protected folders from DiskHound settings are always refused, and so are drive roots, the home folder and its standard folders (Documents, Downloads, Library, AppData…), and anything containing them. Explain to the user what you are proposing and why before calling this.",
      inputSchema: {
        paths: z.array(z.string().min(1).max(4096)).min(1).max(MAX_TRASH_PATHS).describe("Absolute paths to move to the Trash."),
        reason: z.string().max(500).optional().describe("One sentence shown in the dialog explaining why."),
      },
      annotations: trashes,
    },
    () => ["files.trash"],
    async (input, auth) => {
      const paths = [...new Set(input.paths.map((p) => agentPath(p, backend.platform)))];
      const outcome = await backend.confirmAndTrash({
        sessionName: auth.sessionName,
        paths,
        reason: input.reason,
        recheck: async () => {
          await authorizer.authorize(["files.trash"]);
        },
        signal: options.signal,
      });
      if (!outcome.confirmed) {
        return {
          value: { confirmed: false, results: [] },
          summary: "The user declined. Nothing was moved.",
          activity: `Asked to trash ${paths.length} item(s); declined`,
        };
      }
      const moved = outcome.results.filter((result) => result.ok);
      const movedBytes = moved.reduce((sum, result) => sum + (result.sizeBytes ?? 0), 0);
      return {
        value: {
          confirmed: true,
          movedCount: moved.length,
          movedBytes,
          moved: bytesText(movedBytes),
          results: outcome.results,
          note: platformSpaceNote(backend.platform),
        },
        summary:
          `Moved ${moved.length} of ${outcome.results.length} item(s) (${bytesText(movedBytes)}) to the Trash.` +
          (moved.length < outcome.results.length
            ? `\nNot moved: ${outcome.results.filter((r) => !r.ok).map((r) => `${r.path} (${r.message})`).join("; ")}`
            : "") +
          `\n${platformSpaceNote(backend.platform)}`,
        activity: `Moved ${moved.length} item(s) (${bytesText(movedBytes)}) to the Trash`,
      };
    },
  );

  // ── Skills (SEP-2640) + prompt fallbacks ─────────────────

  registerSkills(mcp, skills);

  const skillText = (uri: string) =>
    skills.skills.find((skill) => skill.uri === uri)?.files.find((file) => file.relativePath === "SKILL.md")?.text;

  const promptFromSkill = (uri: string, ask: string): GetPromptResult => {
    const text = skillText(uri);
    return {
      messages: [
        ...(text
          ? [{ role: "user" as const, content: { type: "resource" as const, resource: { uri, mimeType: "text/markdown", text } } }]
          : []),
        { role: "user" as const, content: { type: "text" as const, text: ask } },
      ],
    };
  };

  if (skillText(FREE_UP_SPACE_SKILL)) {
    mcp.registerPrompt(
      "free-up-space",
      {
        title: "Free up disk space with DiskHound",
        description: "Loads DiskHound's cleanup skill and starts a guided hunt for reclaimable space.",
        argsSchema: {
          goal: z.string().max(200).optional().describe("e.g. 'free 50 GB' or 'make room for Xcode'"),
          path: z.string().max(4096).optional().describe("Drive or folder to focus on"),
        },
      },
      ({ goal, path }) =>
        promptFromSkill(
          FREE_UP_SPACE_SKILL,
          `Follow the DiskHound skill above to help me free up disk space${path ? ` on ${path}` : ""}${goal ? ` — goal: ${goal}` : ""}. ` +
            "Start with diskhound_status, show your findings in the DiskHound window as you go, and ask before moving anything to the Trash.",
        ),
    );
  }
  if (skillText(INVESTIGATE_GROWTH_SKILL)) {
    mcp.registerPrompt(
      "investigate-growth",
      {
        title: "Why did my disk fill up?",
        description: "Loads DiskHound's growth-investigation skill and compares scans to find what grew.",
        argsSchema: {
          since: z.string().max(20).optional().describe("How far back to look, e.g. 1d, 1w, 1M"),
          path: z.string().max(4096).optional().describe("Drive or folder to investigate"),
        },
      },
      ({ since, path }) =>
        promptFromSkill(
          INVESTIGATE_GROWTH_SKILL,
          `Follow the DiskHound skill above to find out what has been using up space${path ? ` on ${path}` : ""}${since ? ` over the last ${since}` : ""}.`,
        ),
    );
  }

  return mcp;
}
