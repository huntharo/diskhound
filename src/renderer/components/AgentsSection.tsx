import { useEffect, useRef, useState } from "preact/hooks";

import {
  agentClientGuides,
  agentSetupPrompt,
  MCP_AGENT_CAPABILITY_DETAILS,
  sessionPermissions,
  type AddToClaudeResult,
  type AgentAccessSnapshot,
  type AgentActivityEntry,
  type AgentClientGuide,
  type AgentClientId,
  type AgentSetupStep,
  type McpAgentSession,
} from "../../shared/agentAccess";
import {
  setAgentAccess,
  useAgentAccess,
  useAgentSettingsFocus,
  type AgentSettingsTarget,
} from "../lib/agentAccessStore";
import {
  activeSessions,
  blockedBySession,
  capabilityChip,
  isGuideClient,
  lastActionBySession,
  pendingText,
  sessionClientName,
  viaLabel,
} from "../lib/agentDisplay";
import { relativeTime } from "../lib/format";
import { useVisibleInterval } from "../lib/visiblePoll";
import { nativeApi } from "../nativeApi";
import { toast } from "./Toasts";

const ACTIVE_MS = 30_000;
const RECENT_MS = 10 * 60_000;

/**
 * Settings → AI Agents: turn the loopback MCP server on and off, connect
 * a client (one tab per client, numbered steps, a last step that shows
 * whether it got through), approve or deny waiting sign-ins, change a
 * session's role or revoke it, and see what agents did and what they
 * were refused.
 *
 * Sessions and roles live in mcp-policy.json (main process), not in
 * AppSettings, so this section talks to its own IPC instead of the
 * shared settings `save`. The snapshot comes from the shared agent store
 * the header button already loaded, so opening Settings asks main for
 * nothing.
 */
export function AgentsSection() {
  const snapshot = useAgentAccess();
  const [busy, setBusy] = useState(false);
  // null: open while nothing is connected, folded once something is.
  const [connectOpen, setConnectOpen] = useState<boolean | null>(null);
  const [guideId, setGuideId] = useState<AgentClientId>("claude-code");
  const [scrollTarget, setScrollTarget] = useState<AgentSettingsTarget | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const sectionRef = useRef<HTMLDivElement>(null);
  const connectRef = useRef<HTMLDivElement>(null);
  const blockedRef = useRef<HTMLDivElement>(null);

  useAgentSettingsFocus((target) => {
    if (target === "connect") setConnectOpen(true);
    setScrollTarget(target);
  });

  // Scroll once the section (and an opened Connect) has rendered.
  useEffect(() => {
    if (!scrollTarget || !snapshot) return;
    const frame = window.requestAnimationFrame(() => {
      const element = scrollTarget === "connect"
        ? connectRef.current
        : scrollTarget === "blocked"
          ? blockedRef.current
          : sectionRef.current;
      element?.scrollIntoView({ block: "start" });
      setScrollTarget(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scrollTarget, snapshot !== null]);

  // Waiting times on pending sign-ins count up.
  useVisibleInterval(() => setNow(Date.now()), snapshot && snapshot.pending.length > 0 ? 1_000 : null);
  useEffect(() => {
    setNow(Date.now());
  }, [snapshot]);

  if (!snapshot) return null;

  const { status } = snapshot;
  const active = activeSessions(snapshot);
  const revoked = snapshot.sessions.filter((session) => session.revokedAt !== null);
  const last = lastActionBySession(snapshot.activity);
  const blocked = blockedBySession(snapshot);
  const sessions = [...active].sort((a, b) =>
    (last.get(b.id)?.at ?? Date.parse(b.createdAt)) - (last.get(a.id)?.at ?? Date.parse(a.createdAt)));
  const showConnect = connectOpen ?? active.length === 0;

  const run = async (action: () => Promise<AgentAccessSnapshot>, failure: string): Promise<AgentAccessSnapshot | null> => {
    setBusy(true);
    try {
      const next = await action();
      setAgentAccess(next);
      return next;
    } catch (err) {
      toast("error", failure, err instanceof Error ? err.message : String(err));
      return null;
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
    <div className="settings-section" id="settings-ai-agents" ref={sectionRef}>
      <div className="settings-section-title">AI Agents</div>
      <div className="settings-section-note">
        Let Claude Code, Claude Desktop, Codex or another MCP client read your scans, run scans and steer
        this window while it helps you free up space. DiskHound also gives connected agents its cleanup
        procedures (MCP skills), including the APFS clone and Time Machine snapshot checks on macOS.
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
        <div className="agent-toggle-group">
          {status.error && status.enabled && (
            <button
              className="action-btn"
              disabled={busy}
              onClick={() => void run(() => nativeApi.setAgentAccessEnabled(true), "Couldn't start AI agent access")}
            >
              Try again
            </button>
          )}
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
      </div>

      {snapshot.pending.length > 0 && (
        <>
          <div className="agent-subtitle">Waiting for approval</div>
          {snapshot.pending.map((pending, index) => (
            <div key={pending.requestId} className={`agent-pending-row ${pending.stale ? "stale" : ""}`}>
              <span className={`agent-pill-dot ${pending.stale ? "" : "waiting"}`} />
              <div className="protected-folder-info">
                <div className="agent-session-name">{pending.clientName}</div>
                <div className="agent-session-meta">
                  {viaLabel(pending.via)}
                  {" · "}
                  {index === 0 ? pendingText(pending, now) : `Next after ${snapshot.pending[0]!.clientName}`}
                </div>
              </div>
              {index === 0 ? (
                <button className="action-btn agent-review-btn" onClick={() => void nativeApi.focusAgentApproval()}>
                  Review
                </button>
              ) : <span />}
              <button
                className="action-btn"
                disabled={busy}
                onClick={() => void run(() => nativeApi.dismissAgentApproval(pending.requestId), "Couldn't deny the request")}
              >
                Deny
              </button>
            </div>
          ))}
        </>
      )}

      <div className="agent-subtitle">Sessions</div>
      <div className="agent-session-list">
        {sessions.length === 0 ? (
          <div className="protected-folder-empty">
            No agents approved yet.{status.enabled ? " Connect one below." : ""}
          </div>
        ) : (
          sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              snapshot={snapshot}
              last={last.get(session.id)}
              blocked={blocked.get(session.id) ?? 0}
              now={now}
              busy={busy}
              onShowBlocked={() => setScrollTarget("blocked")}
              onAssign={(roleId) => {
                const before = new Set(sessionPermissions(session, snapshot.roles));
                void run(
                  () => nativeApi.assignAgentSessionRole(session.id, roleId),
                  "Couldn't change the role",
                ).then((next) => {
                  const updated = next?.sessions.find((candidate) => candidate.id === session.id);
                  if (updated) announceRoleChange(updated, before, next!);
                });
              }}
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

      <div className="agent-subtitle" ref={connectRef}>Connect an agent</div>
      {showConnect ? (
        <ConnectGuide
          snapshot={snapshot}
          guideId={guideId}
          onGuide={setGuideId}
          last={last}
          now={now}
          busy={busy}
          onTurnOn={() => void run(() => nativeApi.setAgentAccessEnabled(true), "Couldn't start AI agent access")}
        />
      ) : (
        <button className="agent-disclose" onClick={() => setConnectOpen(true)} aria-expanded={false}>
          <span className="agent-disclose-chevron" />
          Connect another agent: {agentClientGuides(status.port, snapshot.stdioPath, snapshot.platform)
            .filter((guide) => guide.id !== "other").map((guide) => guide.name).join(", ")}, other clients
        </button>
      )}

      {(status.enabled || snapshot.security.length > 0) && (
        <>
          <div className="agent-subtitle" ref={blockedRef}>Blocked requests</div>
          <div className="agent-activity-list">
            {snapshot.security.length === 0 ? (
              <div className="protected-folder-empty">
                Nothing blocked. When an agent asks for something its role doesn't allow, DiskHound refuses it and
                lists it here.
              </div>
            ) : (
              snapshot.security.slice(0, 8).map((event) => (
                <div key={event.id} className="agent-activity-row agent-blocked-row">
                  <span className="agent-activity-time">{relativeTime(event.at)}</span>
                  <span className="agent-activity-session">{event.sessionName}</span>
                  <span className="agent-activity-summary" title={`${event.tool}: ${event.detail}`}>{event.detail}</span>
                  <span className="agent-blocked-count">{event.count > 1 ? `×${event.count}` : ""}</span>
                </div>
              ))
            )}
          </div>
          {snapshot.security.length > 0 && (
            <div className="agent-revoked">
              <span>Kept in agent-security.log, across restarts.</span>
              <button
                className="action-btn"
                onClick={() => {
                  void nativeApi.revealPath(snapshot.securityLogFile).then((result) => {
                    if (!result.ok) toast("info", "Nothing saved yet", "DiskHound writes blocked requests a few seconds after they happen.");
                  });
                }}
              >
                Show file
              </button>
            </div>
          )}
        </>
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
                <span />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Say what a role change did, and when the agent will notice it. */
function announceRoleChange(session: McpAgentSession, before: Set<string>, snapshot: AgentAccessSnapshot) {
  const role = snapshot.roles.find((candidate) => candidate.id === session.roleId);
  if (!role) return;
  const after = sessionPermissions(session, snapshot.roles);
  const added = after.filter((permission) => !before.has(permission));
  const removed = [...before].filter((permission) => !after.includes(permission as never));
  const client = sessionClientName(session);
  // Claude Desktop keeps the tool list it got when it connected.
  const reload = client === "Claude Desktop"
    ? "Claude Desktop picks up the new tools after you turn DiskHound off and on in Claude's Settings → Extensions. Until then DiskHound refuses anything the role doesn't allow."
    : session.client?.via === "stdio"
      ? `${client} reloads its tools on its own.`
      : `${client} sees the change in its tool list after it reconnects; until then DiskHound refuses anything the role doesn't allow.`;
  if (added.length === 0 && removed.length === 0) {
    toast("info", `${session.name} is now ${role.name}`, "Nothing changed: this agent didn't ask for the extra permissions when it signed in.");
    return;
  }
  const destructive = added.filter((permission) => MCP_AGENT_CAPABILITY_DETAILS[permission].danger === "destructive");
  const detail = destructive.length > 0
    ? `It can now ask to ${destructive.map((p) => MCP_AGENT_CAPABILITY_DETAILS[p].verb).join(" and ")}. You confirm every request. ${reload}`
    : reload;
  toast("info", `${session.name} is now ${role.name}`, detail);
}

function SessionRow({ session, snapshot, last, blocked, now, busy, onShowBlocked, onAssign, onRevoke }: {
  session: McpAgentSession;
  snapshot: AgentAccessSnapshot;
  last: AgentActivityEntry | undefined;
  blocked: number;
  now: number;
  busy: boolean;
  onShowBlocked: () => void;
  onAssign: (roleId: string) => void;
  onRevoke: () => void;
}) {
  const role = snapshot.roles.find((candidate) => candidate.id === session.roleId);
  // Effective permissions are the role intersected with the scopes the
  // agent asked for at sign-in, so a bigger role can't exceed them.
  const effective = sessionPermissions(session, snapshot.roles);
  const capped = (role?.permissions ?? []).filter((permission) => !effective.includes(permission));
  const client = sessionClientName(session);
  const age = last ? now - last.at : Infinity;
  const dot = last && !last.ok && age < RECENT_MS ? "failed" : age < ACTIVE_MS ? "active" : "";

  return (
    <div className="agent-session-row">
      <div className="protected-folder-info">
        <div className="agent-session-name">
          <span className={`agent-pill-dot ${dot}`} />
          <span className="agent-session-title">{session.name}</span>
          {session.client && <span className="agent-via">{session.client.via === "stdio" ? "stdio" : "HTTP"}</span>}
        </div>
        <div className="agent-session-meta">
          {client !== session.name ? `${client} · ` : ""}
          Approved {relativeTime(Date.parse(session.createdAt))}
        </div>
        {effective.length > 0 && (
          <div className="agent-role-caps agent-session-caps">
            {effective.map((permission) => (
              <span
                key={permission}
                className={`agent-cap ${MCP_AGENT_CAPABILITY_DETAILS[permission].danger}`}
                title={MCP_AGENT_CAPABILITY_DETAILS[permission].label}
              >
                {capabilityChip(permission, snapshot.platform)}
              </span>
            ))}
          </div>
        )}
        <div className={`agent-session-meta ${last && !last.ok ? "agent-session-failed" : ""}`} title={last?.summary}>
          {last ? `Last: ${last.summary} · ${relativeTime(last.at)}` : "No actions yet"}
          {blocked > 0 && (
            <>
              {" · "}
              <button className="agent-blocked-link" onClick={onShowBlocked}>{blocked} blocked</button>
            </>
          )}
        </div>
        {capped.length > 0 && (
          <div className="agent-session-meta agent-session-capped">
            {client} didn't ask for: {capped.map((p) => MCP_AGENT_CAPABILITY_DETAILS[p].label).join(", ")}, so this
            role can't give it that. Revoke the session and reconnect {client} to ask again.
          </div>
        )}
      </div>
      <select
        className="setting-select"
        value={session.roleId}
        disabled={busy}
        aria-label={`Role for ${session.name}`}
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

function ConnectGuide({ snapshot, guideId, onGuide, last, now, busy, onTurnOn }: {
  snapshot: AgentAccessSnapshot;
  guideId: AgentClientId;
  onGuide: (id: AgentClientId) => void;
  last: Map<string, AgentActivityEntry>;
  now: number;
  busy: boolean;
  onTurnOn: () => void;
}) {
  const guides = agentClientGuides(snapshot.status.port, snapshot.stdioPath, snapshot.platform);
  const guide = guides.find((candidate) => candidate.id === guideId) ?? guides[0]!;
  const active = activeSessions(snapshot);
  const sessionsFor = (candidate: AgentClientGuide) =>
    active.filter((session) => isGuideClient(candidate, sessionClientName(session)));
  const connected = sessionsFor(guide).sort((a, b) =>
    (last.get(b.id)?.at ?? Date.parse(b.createdAt)) - (last.get(a.id)?.at ?? Date.parse(a.createdAt)))[0];
  const pending = snapshot.pending.find((candidate) => isGuideClient(guide, candidate.clientName));

  return (
    <div className="agent-connect">
      <div className="agent-connect-lead">
        <CopyButton
          text={agentSetupPrompt(snapshot.status.port, snapshot.stdioPath)}
          label="Copy prompt for your agent"
          copiedLabel="Prompt copied"
          className="scan-btn scan-btn-primary"
        />
        <span className="agent-connect-lead-text">
          Paste it into Claude Code, Codex or another agent. The agent sets DiskHound up, and you approve it here. Or follow the steps for your agent:
        </span>
      </div>
      <div className="agent-client-tabs" role="tablist" aria-label="Agent">
        {guides.map((candidate) => (
          <button
            key={candidate.id}
            role="tab"
            aria-selected={candidate.id === guide.id}
            className={`chip ${candidate.id === guide.id ? "active" : ""}`}
            onClick={() => onGuide(candidate.id)}
          >
            {sessionsFor(candidate).length > 0 && <span className="agent-tab-dot" />}
            {candidate.name}
          </button>
        ))}
      </div>
      <ol className="agent-steps">
        {guide.steps.map((step, index) => (
          <SetupStep key={`${guide.id}-${index}`} n={index + 1} step={step} done={Boolean(connected)} />
        ))}
        <li className="agent-step">
          <span className={`agent-step-num ${connected ? "done" : ""}`}>{connected ? "✓" : guide.steps.length + 1}</span>
          <ConnectStatus
            snapshot={snapshot}
            guide={guide}
            connected={connected}
            pending={pending}
            last={connected ? last.get(connected.id) : undefined}
            now={now}
            busy={busy}
            onTurnOn={onTurnOn}
          />
        </li>
      </ol>
      <div className="agent-try">
        <span>Then ask:</span>
        <span className="agent-try-prompt">{guide.firstPrompt}</span>
        <CopyButton text={guide.firstPrompt} />
      </div>
      {guide.note && <div className="agent-hint">{guide.note}</div>}
      {snapshot.platform === "linux" && guide.id !== "codex" && (
        <div className="agent-hint">
          Running DiskHound as an AppImage? Its helper moves on every launch: copy diskhound-mcp from the
          AppImage's resources/native folder somewhere stable and use that path instead.
        </div>
      )}
    </div>
  );
}

function ConnectStatus({ snapshot, guide, connected, pending, last, now, busy, onTurnOn }: {
  snapshot: AgentAccessSnapshot;
  guide: AgentClientGuide;
  connected: McpAgentSession | undefined;
  pending: AgentAccessSnapshot["pending"][number] | undefined;
  last: AgentActivityEntry | undefined;
  now: number;
  busy: boolean;
  onTurnOn: () => void;
}) {
  const { status } = snapshot;
  // "Set up…" lands here with the toggle scrolled out of view, so the
  // step turns agents on itself.
  if (!status.enabled) {
    return (
      <div className="agent-live">
        <div className="agent-live-main">
          <div>AI agents are off.</div>
          <div className="agent-live-meta">Turn them on so {guide.name} can connect. Only this computer can, and you approve each agent.</div>
        </div>
        <button className="scan-btn scan-btn-primary" disabled={busy} onClick={onTurnOn}>Turn on</button>
      </div>
    );
  }
  if (status.error) {
    return (
      <div className="agent-live failed">
        <div className="agent-live-main">
          <div>DiskHound isn't listening.</div>
          <div className="agent-live-meta">{status.error}</div>
        </div>
      </div>
    );
  }
  if (pending) {
    return (
      <div className="agent-live waiting">
        <span className="agent-pill-dot waiting" />
        <div className="agent-live-main">
          <div>{pending.stale ? `${pending.clientName} stopped waiting` : `${pending.clientName} is waiting for your approval`}</div>
          <div className="agent-live-meta">{pendingText(pending, now)} · {viaLabel(pending.via)}</div>
        </div>
        <button className="action-btn agent-review-btn" onClick={() => void nativeApi.focusAgentApproval()}>Review</button>
      </div>
    );
  }
  if (connected) {
    const role = snapshot.roles.find((candidate) => candidate.id === connected.roleId);
    return (
      <div className="agent-live connected">
        <span className="agent-live-ok" />
        <div className="agent-live-main">
          <div>Connected as {connected.name} · {role?.name ?? "no role"}</div>
          <div className="agent-live-meta">{last ? `Last: ${last.summary} · ${relativeTime(last.at)}` : "No actions yet"}</div>
        </div>
      </div>
    );
  }
  if (guide.id === "other") {
    return (
      <div className="agent-live">
        <div className="agent-live-main">
          <div>DiskHound asks you to approve each new client here.</div>
          <div className="agent-live-meta">Approved clients show under Sessions.</div>
        </div>
      </div>
    );
  }
  return (
    <div className="agent-live">
      <span className="agent-live-ring" />
      <div className="agent-live-main">
        <div>Waiting for {guide.name} to connect…</div>
        <div className="agent-live-meta">DiskHound asks you to approve it here when it does.</div>
      </div>
    </div>
  );
}

function SetupStep({ n, step, done }: { n: number; step: AgentSetupStep; done: boolean }) {
  const [showManual, setShowManual] = useState(false);

  return (
    <li className="agent-step">
      <span className={`agent-step-num ${done ? "done" : ""}`}>{done ? "✓" : n}</span>
      <div className="agent-step-body">
        <div className="agent-step-text">{step.text}</div>
        {step.prompt && (
          <div className="agent-command">
            <pre className="agent-command-text agent-prompt-text">{step.prompt}</pre>
            <CopyButton text={step.prompt} />
          </div>
        )}
        {step.action === "add-to-claude" && <AddToClaude />}
        {step.manual && (
          <>
            <button className="action-btn agent-manual-toggle" onClick={() => setShowManual(!showManual)} aria-expanded={showManual}>
              {showManual ? `Hide ${step.manual.toggle}` : `Show ${step.manual.toggle}`}
            </button>
            {showManual && step.manual.items.map((item) => (
              <div key={item.snippet}>
                <div className="agent-manual-text">{item.text}</div>
                <div className="agent-command">
                  <pre className="agent-command-text">{item.snippet}</pre>
                  <CopyButton text={item.snippet} />
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </li>
  );
}

/** Opens DiskHound's extension in Claude, which asks the user to install it. */
function AddToClaude() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AddToClaudeResult | null>(null);
  const add = async () => {
    setBusy(true);
    try {
      setResult(await nativeApi.addAgentToClaude());
    } catch (error) {
      setResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="agent-step-action">
      <button className="scan-btn scan-btn-primary" disabled={busy} onClick={() => void add()}>
        {busy ? "Opening Claude…" : "Add to Claude"}
      </button>
      {result?.ok && <span className="agent-step-result">Opened in Claude.</span>}
      {result && !result.ok && (
        <span className="agent-step-result failed">
          {result.error}
          {result.file && " Open the file with Claude to install it."}
        </span>
      )}
      {result && !result.ok && result.file && (
        <button className="action-btn" onClick={() => void nativeApi.revealPath(result.file!)}>Show file</button>
      )}
    </div>
  );
}

/** Copy, confirmed on the button itself for two seconds. */
function CopyButton({ text, label = "Copy", copiedLabel = "Copied", className = "action-btn agent-copy" }: {
  text: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      className={`${className} ${copied ? "copied" : ""}`}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => toast("error", "Couldn't copy to the clipboard"),
        );
      }}
    >
      {copied ? copiedLabel : label}
    </button>
  );
}
