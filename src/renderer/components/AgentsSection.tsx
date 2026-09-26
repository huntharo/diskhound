import { useEffect, useState } from "preact/hooks";

import {
  agentConnectRecipes,
  MCP_AGENT_CAPABILITY_DETAILS,
  type AgentAccessSnapshot,
  type McpAgentSession,
} from "../../shared/agentAccess";
import { relativeTime } from "../lib/format";
import { nativeApi } from "../nativeApi";
import { toast } from "./Toasts";

/**
 * Settings → AI Agents. Turns the loopback MCP server on and off,
 * shows the copy-paste commands for Claude Code and Codex, and lists
 * approved Sessions with their role. Sessions and roles live in
 * mcp-policy.json (main process), not in AppSettings, so this section
 * talks to its own IPC instead of the shared settings `save`.
 */
export function AgentsSection() {
  const [snapshot, setSnapshot] = useState<AgentAccessSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void nativeApi.getAgentAccess().then((next) => {
      if (!cancelled) setSnapshot(next);
    });
    const offChanged = nativeApi.onAgentAccessChanged(setSnapshot);
    const offActivity = nativeApi.onAgentActivity((entry) => {
      setSnapshot((current) => current && {
        ...current,
        activity: [entry, ...current.activity.filter((e) => e.id !== entry.id)].slice(0, 100),
      });
    });
    return () => {
      cancelled = true;
      offChanged();
      offActivity();
    };
  }, []);

  if (!snapshot) return null;

  const { status } = snapshot;
  const active = snapshot.sessions.filter((session) => session.revokedAt === null);
  const revoked = snapshot.sessions.filter((session) => session.revokedAt !== null);

  const run = async (action: () => Promise<AgentAccessSnapshot>, failure: string) => {
    setBusy(true);
    try {
      setSnapshot(await action());
    } catch (err) {
      toast("error", failure, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const statusText = status.error
    ? status.error
    : status.listening
      ? `Listening on ${status.mcpUrl}. Only this computer can connect, and every agent needs your approval.`
      : "Off. Nothing listens until you turn this on.";

  return (
    <div className="settings-section" id="settings-ai-agents">
      <div className="settings-section-title">AI Agents</div>
      <div className="settings-section-note">
        Let Claude Code, Codex, or another MCP client read your scans, run scans, and steer this window
        while it helps you free up space. DiskHound also hands connected agents its cleanup procedures
        (MCP skills), including the APFS clone and Time Machine snapshot checks on macOS.
      </div>

      <div className={`setting-row ${busy ? "setting-row-disabled" : ""}`}>
        <div>
          <div className="setting-label">
            Allow local AI agents
            <span className={`agent-status-chip ${status.error ? "error" : status.listening ? "on" : "off"}`}>
              {status.error ? "Error" : status.listening ? "On" : "Off"}
            </span>
          </div>
          <div className={`setting-desc ${status.error ? "agent-status-error" : ""}`}>{statusText}</div>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={status.enabled}
            disabled={busy}
            onChange={(e) => {
              const enabled = (e.target as HTMLInputElement).checked;
              void run(() => nativeApi.setAgentAccessEnabled(enabled), "Couldn't change AI agent access");
            }}
          />
          <div className="toggle-track" />
          <div className="toggle-thumb" />
        </label>
      </div>

      {status.enabled && (
        <div className="agent-connect">
          <div className="agent-subtitle">Connect an agent</div>
          {agentConnectRecipes(status.port).map((recipe) => (
            <div key={recipe.name} className="agent-recipe">
              <div className="agent-recipe-head">
                <span>{recipe.name}</span>
                <button
                  className="action-btn"
                  onClick={() => {
                    void navigator.clipboard.writeText(recipe.command).then(
                      () => toast("success", `Copied the ${recipe.name} command`),
                      () => toast("error", "Couldn't copy to the clipboard"),
                    );
                  }}
                >
                  Copy
                </button>
              </div>
              <pre className="agent-recipe-command">{recipe.command}</pre>
            </div>
          ))}
          <div className="agent-hint">
            The agent opens a browser tab to sign in; approve the request in the DiskHound window that
            appears.
          </div>
        </div>
      )}

      <div className="agent-subtitle">Sessions</div>
      <div className="agent-session-list">
        {active.length === 0 ? (
          <div className="protected-folder-empty">
            No agents approved yet.
          </div>
        ) : (
          active.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              snapshot={snapshot}
              busy={busy}
              onAssign={(roleId) => void run(
                () => nativeApi.assignAgentSessionRole(session.id, roleId),
                "Couldn't change the role",
              )}
              onRevoke={() => void run(
                () => nativeApi.revokeAgentSession(session.id),
                "Couldn't revoke the session",
              )}
            />
          ))
        )}
      </div>
      {revoked.length > 0 && (
        <div className="agent-revoked">
          <span>
            {revoked.length} revoked session{revoked.length === 1 ? "" : "s"}
            {" "}({revoked.map((session) => session.name).join(", ")})
          </span>
          <button
            className="action-btn"
            disabled={busy}
            onClick={() => void run(() => nativeApi.forgetRevokedAgentSessions(), "Couldn't clear revoked sessions")}
          >
            Forget revoked
          </button>
        </div>
      )}

      {snapshot.activity.length > 0 && (
        <>
          <div className="agent-subtitle">Recent agent actions</div>
          <div className="agent-activity-list">
            {snapshot.activity.slice(0, 12).map((entry) => (
              <div key={entry.id} className={`agent-activity-row ${entry.ok ? "" : "failed"}`}>
                <span className="agent-activity-time">{relativeTime(entry.at)}</span>
                <span className="agent-activity-session">{entry.sessionName}</span>
                <span className="agent-activity-summary" title={`${entry.tool}: ${entry.summary}`}>
                  {entry.summary}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SessionRow({ session, snapshot, busy, onAssign, onRevoke }: {
  session: McpAgentSession;
  snapshot: AgentAccessSnapshot;
  busy: boolean;
  onAssign: (roleId: string) => void;
  onRevoke: () => void;
}) {
  const role = snapshot.roles.find((candidate) => candidate.id === session.roleId);
  // Effective permissions are the role intersected with the scopes the
  // agent asked for at sign-in, so a bigger role can't exceed them.
  const approved = new Set(session.oauth?.scopes ?? role?.permissions ?? []);
  const effective = (role?.permissions ?? []).filter((permission) => approved.has(permission));
  const capped = (role?.permissions ?? []).filter((permission) => !approved.has(permission));

  return (
    <div className="agent-session-row">
      <div className="protected-folder-info">
        <div className="protected-folder-name">{session.name}</div>
        <div className="agent-session-meta">
          Approved {relativeTime(Date.parse(session.createdAt))}
          {effective.length > 0 && ` · ${effective.map((p) => MCP_AGENT_CAPABILITY_DETAILS[p].label).join(", ")}`}
        </div>
        {capped.length > 0 && (
          <div className="agent-session-meta agent-session-capped">
            This agent didn't ask for: {capped.map((p) => MCP_AGENT_CAPABILITY_DETAILS[p].label).join(", ")}.
          </div>
        )}
      </div>
      <select
        className="setting-select"
        value={session.roleId}
        disabled={busy}
        onChange={(e) => onAssign((e.target as HTMLSelectElement).value)}
      >
        {snapshot.roles.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
        ))}
      </select>
      <button className="action-btn danger" disabled={busy} onClick={onRevoke}>
        Revoke
      </button>
    </div>
  );
}
