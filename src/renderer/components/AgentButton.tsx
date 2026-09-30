import { useEffect, useRef, useState } from "preact/hooks";

import type { AgentAccessSnapshot } from "../../shared/agentAccess";
import { useAgentAccess, type AgentSettingsTarget } from "../lib/agentAccessStore";
import {
  activeSessions,
  blockedBySession,
  lastActionBySession,
  pendingText,
  roleShortName,
} from "../lib/agentDisplay";
import { relativeTime } from "../lib/format";
import { useVisibleInterval } from "../lib/visiblePoll";
import { nativeApi } from "../nativeApi";

/** The pill pulses while calls keep arriving, then settles. */
const ACTIVE_MS = 30_000;
/** And turns back into the button once an agent has been quiet this long. */
const VISIBLE_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/**
 * The header's way in to AI agents, always present so the feature can
 * be found before anything is set up:
 *
 * - off: a plain button;
 * - on: a green listening dot;
 * - an approval waiting (its sheet may be behind another app): amber,
 *   with a count;
 * - for 10 minutes after an agent's call: the pill naming it, pulsing
 *   blue for 30 s, red when the call failed or was blocked.
 *
 * A click opens a popover with who is connected, what each did last,
 * and links into Settings.
 */
export function AgentButton({ onOpenSettings }: { onOpenSettings: (target: AgentSettingsTarget) => void }) {
  const snapshot = useAgentAccess();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const wrapRef = useRef<HTMLDivElement>(null);

  const latest = snapshot?.status.enabled ? snapshot.activity[0] ?? null : null;
  const age = latest ? now - latest.at : Infinity;
  const pending = snapshot?.pending ?? [];

  // New activity carries main's clock; catch ours up so the pulse starts.
  useEffect(() => {
    if (latest) setNow(Date.now());
  }, [latest?.id]);

  // Tick only while something on screen reads the clock.
  const tickMs = open || pending.length > 0
    ? 1_000
    : age < ACTIVE_MS
      ? 5_000
      : age < VISIBLE_MS
        ? 30_000
        : null;
  useVisibleInterval(() => setNow(Date.now()), tickMs);

  // The header clips its overflow, so the popover is fixed-position,
  // anchored under the button.
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (rect) setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!snapshot) return null;

  const { status } = snapshot;
  const showPill = latest !== null && age < VISIBLE_MS;
  const active = age < ACTIVE_MS;
  const title = !status.enabled
    ? "Connect an AI agent"
    : status.error
      ? `AI agents: ${status.error}`
      : pending.length > 0
        ? `${pending[0]!.clientName} is waiting for your approval`
        : latest && showPill
          ? `${latest.sessionName}: ${latest.summary} (${relativeTime(latest.at)})`
          : `AI agents are on. Listening on ${status.mcpUrl}`;
  const badge = pending.length > 0 ? <span className="agent-btn-badge">{pending.length}</span> : null;
  const go = (target: AgentSettingsTarget) => {
    setOpen(false);
    onOpenSettings(target);
  };

  return (
    <div className="agent-btn-wrap" ref={wrapRef}>
      {showPill && latest ? (
        <button
          className={`agent-pill ${active ? "active" : ""} ${latest.ok ? "" : "failed"} ${open ? "open" : ""}`}
          onClick={() => setOpen(!open)}
          title={title}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`AI agent ${latest.sessionName}${active ? " is working" : ""}. Show AI agents.`}
        >
          <span className="agent-pill-dot" />
          <span className="agent-pill-name">{latest.sessionName}</span>
          {badge}
        </button>
      ) : (
        <button
          className={`header-icon-btn agent-btn ${pending.length > 0 ? "waiting" : ""} ${open ? "active" : ""}`}
          onClick={() => setOpen(!open)}
          title={title}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={pending.length > 0 ? title : "AI agents"}
        >
          <AgentGlyph />
          {status.listening && pending.length === 0 && <span className="agent-btn-listening" />}
          {badge}
        </button>
      )}
      {open && anchor && (
        <AgentPopover snapshot={snapshot} now={now} anchor={anchor} onGo={go} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

/** A small robot head: 1px strokes like the header's other icons. */
export function AgentGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
      <rect x="2" y="4.5" width="10" height="7.5" rx="2" />
      <path d="M7 2V4.5" />
      <circle cx="5" cy="8.2" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="9" cy="8.2" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function AgentPopover({ snapshot, now, anchor, onGo, onClose }: {
  snapshot: AgentAccessSnapshot;
  now: number;
  anchor: { top: number; right: number };
  onGo: (target: AgentSettingsTarget) => void;
  onClose: () => void;
}) {
  const { status } = snapshot;
  const sessions = activeSessions(snapshot);
  const last = lastActionBySession(snapshot.activity);
  const blockedToday = [...blockedBySession(snapshot, now - DAY_MS).values()].reduce((sum, n) => sum + n, 0);
  const rolesById = new Map(snapshot.roles.map((role) => [role.id, role]));
  const ordered = [...sessions].sort((a, b) => (last.get(b.id)?.at ?? 0) - (last.get(a.id)?.at ?? 0));
  const chip = status.error ? "error" : status.listening ? "on" : "off";

  return (
    <div className="agent-pop" role="dialog" aria-label="AI agents" style={{ top: anchor.top, right: anchor.right }}>
      <div className="agent-pop-head">
        <span>AI agents</span>
        <span className={`agent-status-chip ${chip}`}>{status.error ? "Error" : status.listening ? "On" : "Off"}</span>
      </div>

      {!status.enabled ? (
        <div className="agent-pop-off">
          <p>
            Let Claude Code, Claude Desktop, Codex or another MCP client read your scans and steer this
            window while it helps you free up space. Nothing listens until you turn it on.
          </p>
          <button className="scan-btn scan-btn-primary" onClick={() => onGo("connect")}>Set up…</button>
        </div>
      ) : (
        <>
          {status.error && <div className="agent-pop-error">{status.error}</div>}
          {snapshot.pending.map((pending) => (
            <div key={pending.requestId} className="agent-pop-row pending">
              <span className="agent-pill-dot waiting" />
              <div className="agent-pop-main">
                <div className="agent-pop-name">{pending.clientName}</div>
                <div className="agent-pop-what">{pendingText(pending, now)}</div>
              </div>
              <button
                className="action-btn agent-review-btn"
                onClick={() => {
                  onClose();
                  void nativeApi.focusAgentApproval();
                }}
              >
                Review
              </button>
            </div>
          ))}
          {ordered.slice(0, 5).map((session) => {
            const action = last.get(session.id);
            const recent = action ? now - action.at : Infinity;
            const dot = action && recent < VISIBLE_MS && !action.ok ? "failed" : recent < ACTIVE_MS ? "active" : "";
            return (
              <div key={session.id} className="agent-pop-row">
                <span className={`agent-pill-dot ${dot}`} />
                <div className="agent-pop-main">
                  <div className="agent-pop-name">{session.name}</div>
                  <div className={`agent-pop-what ${action && !action.ok ? "failed" : ""}`} title={action?.summary}>
                    {action ? `${action.summary} · ${relativeTime(action.at)}` : "No actions yet"}
                  </div>
                </div>
                <span className="agent-role-chip">{roleShortName(rolesById.get(session.roleId))}</span>
              </div>
            );
          })}
          {sessions.length > 5 && <div className="agent-pop-more">and {sessions.length - 5} more in Settings</div>}
          {sessions.length === 0 && snapshot.pending.length === 0 && (
            <div className="agent-pop-empty">No agents connected yet.</div>
          )}
          {blockedToday > 0 && (
            <button className="agent-pop-blocked" onClick={() => onGo("blocked")}>
              {blockedToday} blocked request{blockedToday === 1 ? "" : "s"} today
            </button>
          )}
        </>
      )}

      <div className="agent-pop-foot">
        {status.enabled && <button className="agent-pop-link" onClick={() => onGo("connect")}>Connect an agent…</button>}
        <button className="agent-pop-link" onClick={() => onGo("section")}>AI Agents settings…</button>
      </div>
    </div>
  );
}
