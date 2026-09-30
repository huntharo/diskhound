// ── Local agent access (MCP) ────────────────────────────────
//
// Shared between the main process (src/mcp/*) and the renderer
// (Settings → AI Agents, the approval window, the header activity
// pill). Keep this module free of Node imports — Vite bundles it into
// the renderer.

/**
 * The endpoint is a fixed loopback port, not a discovery file: Claude
 * Code and Codex store the URL once (`claude mcp add … <url>`), so it
 * has to survive restarts. PwrSnap uses 51729, PwrGit 51731 and
 * PwrSuiteLab Control 51733; 51735 keeps DiskHound out of their way
 * when they run side by side.
 */
export const AGENT_ACCESS_PORT = 51735;
export const AGENT_ACCESS_HOST = "127.0.0.1";
export const AGENT_ACCESS_MCP_PATH = "/mcp";

/** Name agents see in `initialize`; Claude Code prefixes tools with it. */
export const MCP_SERVER_NAME = "diskhound";

/** SEP-2640 extension identifier (Skills over MCP). */
export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

export function agentAccessMcpUrl(port: number = AGENT_ACCESS_PORT): string {
  return `http://${AGENT_ACCESS_HOST}:${port}${AGENT_ACCESS_MCP_PATH}`;
}

export type AgentClientId = "claude-code" | "claude-desktop" | "codex" | "other";

/** One numbered step in Settings → AI Agents → Connect. */
export interface AgentSetupStep {
  text: string;
  /** Setup instructions to paste into the agent, with a Copy button. */
  prompt?: string;
  /** Doing it by hand instead, behind "Show <toggle>": notes, each with a snippet to copy. */
  manual?: { toggle: string; items: { text: string; snippet: string }[] };
  /** A button that does the step: open DiskHound's extension in Claude. */
  action?: "add-to-claude";
}

/** What "Add to Claude" did. `file` is the extension, to show when Claude didn't open it. */
export type AddToClaudeResult = { ok: true; file: string } | { ok: false; error: string; file?: string };

export interface AgentClientGuide {
  id: AgentClientId;
  name: string;
  /** How the client reaches DiskHound, shown next to its name. */
  via: string;
  steps: AgentSetupStep[];
  /** A first thing to ask once connected. */
  firstPrompt: string;
  /** A line under the steps. */
  note?: string;
}

/** Quote a path for PowerShell or a POSIX shell. Never interpolate a raw app path. */
function shellQuote(value: string, platform: string): string {
  return platform === "win32"
    ? "'" + value.replaceAll("'", "''") + "'"
    : "'" + value.replaceAll("'", "'\\''") + "'";
}

const helperArgs = (port: number) => (port === AGENT_ACCESS_PORT ? "no arguments" : `the arguments --port ${port}`);
const promptTail = "Preserve my other MCP servers, then help me connect and approve access in DiskHound.";

/**
 * One prompt for whichever agent the user has, the connect guide's main
 * button. Like the per-client prompts, it asks the agent to set itself
 * up: DiskHound never writes another app's configuration.
 */
export function agentSetupPrompt(port: number = AGENT_ACCESS_PORT, stdioPath = "diskhound-mcp"): string {
  return `Set up ${MCP_SERVER_NAME} as a user-level MCP server for this agent. For Claude, use the stdio executable "${stdioPath}" with ${helperArgs(port)}. For other clients, use the HTTP MCP endpoint ${agentAccessMcpUrl(port)} with OAuth. ${promptTail}`;
}

/**
 * Setup steps per client, shown in Settings → AI Agents.
 *
 * - DiskHound never writes another app's configuration. Agents that
 *   can run commands get a prompt to paste, and add DiskHound to their
 *   own configuration; the command to do it by hand sits behind a Show
 *   button.
 * - Claude Desktop's chat can't run commands, so DiskHound opens its
 *   extension (an MCP Bundle) in Claude, and Claude asks the user to
 *   install it. It serves the app's chats and Code sessions alike.
 *   Claude Desktop isn't made for Linux.
 * - Claude Code and Claude Desktop use the bundled stdio helper, which
 *   handles OAuth itself (Claude Desktop can't reach a loopback URL:
 *   its custom connectors connect from Anthropic's servers).
 * - Codex speaks HTTP + OAuth natively, and its CLI and app share
 *   ~/.codex/config.toml.
 * - `--scope user` matters for Claude Code: the default `local` scope
 *   only registers the server for the directory the terminal is in.
 */
export function agentClientGuides(
  port: number = AGENT_ACCESS_PORT,
  stdioPath = "diskhound-mcp",
  platform = "linux",
): AgentClientGuide[] {
  const url = agentAccessMcpUrl(port);
  const portArgs = port === AGENT_ACCESS_PORT ? "" : ` --port ${port}`;
  const executable = shellQuote(stdioPath, platform);
  const stdioPrompt = (client: string) =>
    `Add ${MCP_SERVER_NAME} to my ${client} user configuration using the stdio executable "${stdioPath}", with ${helperArgs(port)}. ${promptTail}`;
  const httpPrompt = (whose: string) =>
    `Add ${MCP_SERVER_NAME} to ${whose} user configuration using the HTTP MCP endpoint ${url} with OAuth. ${promptTail}`;
  const firstPrompt = "What's using the most space on my disk?";
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      via: "stdio helper",
      firstPrompt,
      steps: [
        {
          text: "Paste this into Claude Code in your terminal or IDE.",
          prompt: stdioPrompt("Claude Code"),
          manual: {
            toggle: "command",
            items: [{
              text: "Or run this yourself in a terminal. It adds DiskHound for every project.",
              snippet: `claude mcp add --scope user --transport stdio ${MCP_SERVER_NAME} -- ${executable}${portArgs}`,
            }],
          },
        },
        { text: "Start a new Claude Code session (or run /mcp and reconnect diskhound). DiskHound asks you to approve it here." },
      ],
      // Its config reaches the Claude app's Code sessions too, where the extension already is.
      ...(platform === "linux" ? {} : { note: "In the Claude app, chats and Code sessions use the Claude Desktop extension instead." }),
    },
    ...(platform === "linux" ? [] : [{
      id: "claude-desktop" as const,
      name: "Claude Desktop",
      via: "Claude extension",
      firstPrompt,
      steps: [
        {
          text: "Add DiskHound's extension to Claude. Claude shows what it installs and asks you to confirm.",
          action: "add-to-claude" as const,
        },
        { text: "Click Install in Claude. DiskHound asks you to approve it here." },
      ],
      note: "The extension works in the Claude app's chats and its Code sessions.",
    }]),
    {
      id: "codex",
      name: "Codex",
      via: "HTTP + OAuth",
      firstPrompt,
      steps: [
        {
          text: "Paste this into Codex. The Codex CLI and the Codex app share their settings.",
          prompt: httpPrompt("my Codex"),
          manual: {
            toggle: "command",
            items: [{
              text: "Or run this yourself in a terminal:",
              snippet: `codex mcp add ${MCP_SERVER_NAME} --url ${url} --oauth-client-registration dcr`,
            }],
          },
        },
        { text: "Codex opens a browser tab that says Continue in DiskHound. Approve the request here." },
      ],
    },
    {
      id: "other",
      name: "Other MCP clients",
      via: "HTTP + OAuth or stdio",
      firstPrompt,
      steps: [
        {
          text: "Paste this into your agent.",
          prompt: httpPrompt("this agent's"),
          manual: {
            toggle: "details",
            items: [
              { text: "Clients that support OAuth over loopback HTTP connect to this URL:", snippet: url },
              { text: "Clients that launch local servers run this command, which handles sign-in for them:", snippet: `${executable}${portArgs}` },
            ],
          },
        },
      ],
    },
  ];
}

/**
 * What an agent Session may do. These double as OAuth scopes: a
 * Session's effective permissions are its role's permissions
 * intersected with the scopes the user approved, so editing a role
 * later can never exceed the original consent.
 */
export const MCP_AGENT_CAPABILITIES = [
  "disk.read",
  "scan.run",
  "app.navigate",
  "files.trash",
  "files.delete",
] as const;

export type McpAgentCapability = (typeof MCP_AGENT_CAPABILITIES)[number];
/**
 * - standard: can't expose or change anything the user hasn't seen.
 * - sensitive: exposes private data (every file name on the disk).
 * - destructive: removes files (after the user confirms each request).
 */
export type McpAgentPermissionDanger = "standard" | "sensitive" | "destructive";

export const MCP_AGENT_CAPABILITY_DETAILS: Record<
  McpAgentCapability,
  {
    label: string;
    /** For chips on the approval sheet's role cards. */
    short: string;
    /** Completes "this session can ask to …". */
    verb: string;
    detail: string;
    danger: McpAgentPermissionDanger;
  }
> = {
  "disk.read": {
    label: "Read drives and scan results",
    short: "Read scans",
    verb: "read drives and scan results",
    detail: "Drive capacity, scan summaries, folder sizes, file names and paths, search, history, duplicates, and cleanup suggestions.",
    danger: "sensitive",
  },
  "scan.run": {
    label: "Run scans",
    short: "Run scans",
    verb: "run scans",
    detail: "Start or cancel drive scans and duplicate searches. Scans read metadata only and never change files.",
    danger: "standard",
  },
  "app.navigate": {
    label: "Drive the DiskHound window",
    short: "Steer window",
    verb: "steer the DiskHound window",
    detail: "Switch tabs, open folders, and reveal items in Finder or Explorer so you can follow along.",
    danger: "standard",
  },
  "files.trash": {
    label: "Ask to move items to the Trash",
    short: "Trash · asks you",
    verb: "move items to the Trash",
    detail: "Request that files or folders go to the Trash / Recycle Bin. DiskHound asks you to confirm every request, and you can restore items until the Trash is emptied.",
    danger: "destructive",
  },
  "files.delete": {
    label: "Ask to delete items permanently",
    short: "Delete · asks you",
    verb: "delete items permanently",
    detail: "Request that files or folders be deleted without going to the Trash. DiskHound asks you to confirm every request. Deleted items can't be restored.",
    danger: "destructive",
  },
};

export interface McpAgentRole {
  id: string;
  name: string;
  description: string;
  permissions: McpAgentCapability[];
}

/**
 * Roles are fixed in code — there is no role editor. The policy file
 * only stores Sessions, which point at one of these ids.
 */
export const BUILT_IN_MCP_ROLES: readonly McpAgentRole[] = [
  {
    id: "builtin.reader",
    name: "Disk Explorer",
    description: "Read drive usage and scan results. Cannot start scans, move the app, or touch files.",
    permissions: ["disk.read"],
  },
  {
    id: "builtin.guide",
    name: "Cleanup Guide",
    description: "Read scan results, run scans, and steer the DiskHound window. Cannot touch files.",
    permissions: ["disk.read", "scan.run", "app.navigate"],
  },
  {
    id: "builtin.operator",
    name: "Cleanup Operator",
    description: "Everything the Cleanup Guide can do, plus ask to move items to the Trash. You confirm every request in DiskHound.",
    permissions: ["disk.read", "scan.run", "app.navigate", "files.trash"],
  },
  {
    id: "builtin.admin",
    name: "Cleanup Admin",
    description: "Everything the Cleanup Operator can do, plus ask to delete items permanently. You confirm every request in DiskHound.",
    permissions: ["disk.read", "scan.run", "app.navigate", "files.trash", "files.delete"],
  },
];

export const DEFAULT_CONSENT_ROLE_ID = "builtin.guide";

export interface McpAgentSession {
  id: string;
  name: string;
  roleId: string;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  oauth?: { clientId: string; scopes: McpAgentCapability[] };
  /** What the client called itself at sign-in, and how it connects. */
  client?: { name: string; via: AgentClientVia };
}

/** `stdio` is DiskHound's bundled diskhound-mcp helper. */
export type AgentClientVia = "stdio" | "http";

/** A session's effective permissions: its role, capped by what the agent asked for. */
export function sessionPermissions(session: McpAgentSession, roles: readonly McpAgentRole[] = BUILT_IN_MCP_ROLES): McpAgentCapability[] {
  const role = roles.find((candidate) => candidate.id === session.roleId);
  const approved = session.oauth?.scopes;
  return (role?.permissions ?? []).filter((permission) => !approved || approved.includes(permission));
}

export interface AgentAccessStatus {
  /** User setting — whether DiskHound should listen. */
  enabled: boolean;
  /** Whether the loopback listener is actually bound right now. */
  listening: boolean;
  mcpUrl: string;
  port: number;
  error?: string;
}

/** An agent login waiting for the user in DiskHound's approval sheet. */
export interface AgentPendingApproval {
  requestId: string;
  clientName: string;
  via: AgentClientVia;
  requestedAt: number;
  /** The agent stopped checking back (it likely timed out or quit). */
  stale: boolean;
}

/**
 * Something an agent tried that its session doesn't allow. Kept in
 * agent-security.log so the user can see it after a restart.
 */
export interface AgentSecurityEvent {
  id: string;
  at: number;
  sessionId: string;
  sessionName: string;
  roleName: string;
  /**
   * - tool_not_allowed: the session's role doesn't grant the tool.
   * - protected_path: a Trash or delete request named a folder agents
   *   may never remove.
   */
  kind: "tool_not_allowed" | "protected_path";
  tool: string;
  /** One line for the user: what was asked and why it was refused. */
  detail: string;
  /** Identical events within a minute are counted here, not repeated. */
  count: number;
}

export interface AgentAccessSnapshot {
  status: AgentAccessStatus;
  roles: McpAgentRole[];
  sessions: McpAgentSession[];
  activity: AgentActivityEntry[];
  pending: AgentPendingApproval[];
  security: AgentSecurityEvent[];
  policyFile: string;
  securityLogFile: string;
  stdioPath: string;
  platform: string;
}

/**
 * One line in the "Recent agent actions" feed and the header pill.
 * Written by the MCP tool layer after every call, success or failure.
 */
export interface AgentActivityEntry {
  id: string;
  at: number;
  sessionId: string;
  sessionName: string;
  tool: string;
  summary: string;
  ok: boolean;
}

export interface AgentConsentPrompt {
  requestId: string;
  clientName: string;
  via: AgentClientVia;
  sessionName: string;
  requestedScopes: McpAgentCapability[];
  roles: McpAgentRole[];
  defaultRoleId: string;
}

/**
 * Pushed to the approval sheet when the waiting agent goes quiet or
 * comes back, and when the queue behind it changes.
 */
export interface AgentConsentState {
  requestId: string;
  stale: boolean;
  /** The client whose request is shown after this one, if any. */
  next: string | null;
}

export interface AgentConsentDecision {
  requestId: string;
  decision: "allow" | "deny";
  sessionName: string;
  roleId: string;
}
