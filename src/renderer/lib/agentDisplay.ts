import type { AgentRemovalList } from "../../shared/agentRemovals";
import {
  MCP_AGENT_CAPABILITY_DETAILS,
  type AgentAccessSnapshot,
  type AgentActivityEntry,
  type AgentClientGuide,
  type AgentClientVia,
  type AgentPendingApproval,
  type McpAgentCapability,
  type McpAgentRole,
  type McpAgentSession,
} from "../../shared/agentAccess";

/** "Guide" for Cleanup Guide, "Explorer" for Disk Explorer: for chips. */
export function roleShortName(role: McpAgentRole | undefined): string {
  return role ? role.name.replace(/^(Cleanup|Disk) /, "") : "No role";
}

export function viaLabel(via: AgentClientVia | undefined): string {
  return via === "stdio" ? "stdio helper" : via === "http" ? "HTTP" : "";
}

/** The name a client signed in as (session names can be edited or numbered). */
export function sessionClientName(session: McpAgentSession): string {
  return session.client?.name ?? session.name;
}

/** Whether `name` (a client or session name) is the client a setup guide is for. */
export function isGuideClient(guide: AgentClientGuide, name: string): boolean {
  if (guide.id === "other") return false;
  const want = guide.name.toLowerCase();
  const got = name.trim().toLowerCase();
  return got === want || got.startsWith(`${want} `);
}

export function activeSessions(snapshot: AgentAccessSnapshot): McpAgentSession[] {
  return snapshot.sessions.filter((session) => session.revokedAt === null);
}

/** The newest action per session, from the activity feed (newest first). */
export function lastActionBySession(activity: readonly AgentActivityEntry[]): Map<string, AgentActivityEntry> {
  const last = new Map<string, AgentActivityEntry>();
  for (const entry of activity) {
    if (!last.has(entry.sessionId)) last.set(entry.sessionId, entry);
  }
  return last;
}

/** Blocked requests per session, counting repeats. */
export function blockedBySession(snapshot: AgentAccessSnapshot, since = 0): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of snapshot.security) {
    if (event.at < since) continue;
    counts.set(event.sessionId, (counts.get(event.sessionId) ?? 0) + event.count);
  }
  return counts;
}

export function pendingText(pending: AgentPendingApproval, now: number): string {
  if (pending.stale) return "Stopped waiting. It may have timed out.";
  const seconds = Math.max(0, Math.round((now - pending.requestedAt) / 1000));
  return `Waiting for your approval · ${seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`}`;
}

/** A permission's short chip label, with the Recycle Bin on Windows. */
export function capabilityChip(permission: McpAgentCapability, platform: string): string {
  const short = MCP_AGENT_CAPABILITY_DETAILS[permission].short;
  return platform === "win32" ? short.replace("Trash", "Recycle Bin") : short;
}

/** Items waiting in the review list, and who asked: "From Codex (4) and Claude Code (3)". */
export function reviewSummary(list: AgentRemovalList): { items: number; from: string } {
  const counts = new Map<string, number>();
  let items = 0;
  for (const request of list.requests) {
    const waiting = request.items.filter((item) => item.status === "waiting").length;
    if (waiting > 0) counts.set(request.sessionName, (counts.get(request.sessionName) ?? 0) + waiting);
    items += waiting;
  }
  const parts = [...counts].map(([name, count]) => `${name} (${count})`);
  const from = parts.length <= 2
    ? parts.join(" and ")
    : `${parts.slice(0, 2).join(", ")} and ${parts.length - 2} more`;
  return { items, from: from ? `From ${from}` : "" };
}
