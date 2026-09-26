// ── Local agent access (MCP) ────────────────────────────────
//
// Shared between the main process (src/mcp/*) and the renderer
// (Settings → AI Agents, the approval window, the header activity
// pill). Keep this module free of Node imports — Vite bundles it into
// the renderer.

/**
 * The endpoint is a fixed loopback port, not a discovery file: Claude
 * Code and Codex store the URL once (`claude mcp add … <url>`), so it
 * has to survive restarts. PwrSnap uses 51729 and PwrGit 51731; 51733
 * keeps DiskHound out of their way when all three run side by side.
 */
export const AGENT_ACCESS_PORT = 51733;
export const AGENT_ACCESS_HOST = "127.0.0.1";
export const AGENT_ACCESS_MCP_PATH = "/mcp";

/** Name agents see in `initialize`; Claude Code prefixes tools with it. */
export const MCP_SERVER_NAME = "diskhound";

/** SEP-2640 extension identifier (Skills over MCP). */
export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

export function agentAccessMcpUrl(port: number = AGENT_ACCESS_PORT): string {
  return `http://${AGENT_ACCESS_HOST}:${port}${AGENT_ACCESS_MCP_PATH}`;
}

/**
 * Copy-paste commands shown in Settings. `--scope user` matters for
 * Claude Code: the default `local` scope only registers the server for
 * the directory the terminal happens to be in.
 */
export function agentConnectRecipes(port: number = AGENT_ACCESS_PORT): { name: string; command: string }[] {
  const url = agentAccessMcpUrl(port);
  return [
    {
      name: "Claude Code",
      command: `claude mcp add --scope user --transport http ${MCP_SERVER_NAME} ${url}\nclaude mcp login ${MCP_SERVER_NAME}`,
    },
    {
      name: "Codex CLI",
      command: `codex mcp add ${MCP_SERVER_NAME} --url ${url} --oauth-client-registration dcr`,
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
] as const;

export type McpAgentCapability = (typeof MCP_AGENT_CAPABILITIES)[number];
export type McpAgentPermissionDanger = "standard" | "sensitive";

export const MCP_AGENT_CAPABILITY_DETAILS: Record<
  McpAgentCapability,
  { label: string; detail: string; danger: McpAgentPermissionDanger }
> = {
  "disk.read": {
    label: "Read drives and scan results",
    detail: "Drive capacity, scan summaries, folder sizes, file names and paths, search, history, duplicates, and cleanup suggestions.",
    danger: "sensitive",
  },
  "scan.run": {
    label: "Run scans",
    detail: "Start or cancel drive scans and duplicate searches. Scans read metadata only and never change files.",
    danger: "standard",
  },
  "app.navigate": {
    label: "Drive the DiskHound window",
    detail: "Switch tabs, open folders, and reveal items in Finder or Explorer so you can follow along.",
    danger: "standard",
  },
  "files.trash": {
    label: "Ask to move items to the Trash",
    detail: "Request that files or folders go to the Trash / Recycle Bin. DiskHound asks you to confirm every request and never deletes permanently.",
    danger: "sensitive",
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

export interface AgentAccessSnapshot {
  status: AgentAccessStatus;
  roles: McpAgentRole[];
  sessions: McpAgentSession[];
  activity: AgentActivityEntry[];
  policyFile: string;
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
  sessionName: string;
  requestedScopes: McpAgentCapability[];
  roles: McpAgentRole[];
  defaultRoleId: string;
}

export interface AgentConsentDecision {
  requestId: string;
  decision: "allow" | "deny";
  sessionName: string;
  roleId: string;
}
