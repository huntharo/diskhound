import { useEffect, useState } from "preact/hooks";

import type { AgentActivityEntry } from "../../shared/agentAccess";
import { relativeTime } from "../lib/format";
import { nativeApi } from "../nativeApi";

/** The pill pulses while calls keep arriving, then settles. */
const ACTIVE_MS = 30_000;
/** And disappears once an agent has been quiet this long. */
const VISIBLE_MS = 10 * 60_000;

/**
 * Header indicator for AI agents driving DiskHound over MCP: which
 * session acted last and what it did (tooltip). Hidden until an agent
 * makes a call; clicking it opens Settings → AI Agents.
 */
export function AgentActivityPill({ onOpen }: { onOpen: () => void }) {
  const [latest, setLatest] = useState<AgentActivityEntry | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    nativeApi
      .getAgentAccess()
      .then((snapshot) => setLatest((current) => current ?? snapshot.activity[0] ?? null))
      .catch(() => undefined);
    const offActivity = nativeApi.onAgentActivity((entry) => {
      setLatest(entry);
      setNow(Date.now());
    });
    const offChanged = nativeApi.onAgentAccessChanged((snapshot) => {
      if (!snapshot.status.listening) setLatest(null);
    });
    return () => {
      offActivity();
      offChanged();
    };
  }, []);

  const age = latest ? now - latest.at : Infinity;

  // Tick only while the pill is on screen, fast enough to end the pulse on time.
  useEffect(() => {
    if (age >= VISIBLE_MS) return;
    const id = window.setInterval(() => setNow(Date.now()), age < ACTIVE_MS ? 5_000 : 30_000);
    return () => window.clearInterval(id);
  }, [age < ACTIVE_MS, age < VISIBLE_MS]);

  if (!latest || age >= VISIBLE_MS) return null;

  const active = age < ACTIVE_MS;
  return (
    <button
      className={`agent-pill ${active ? "active" : ""} ${latest.ok ? "" : "failed"}`}
      onClick={onOpen}
      title={`${latest.sessionName}: ${latest.summary} (${relativeTime(latest.at)})\nClick for AI agent settings.`}
      aria-label={`AI agent ${latest.sessionName}${active ? " is working" : ""}. Open AI agent settings.`}
    >
      <span className="agent-pill-dot" />
      <span className="agent-pill-name">{latest.sessionName}</span>
    </button>
  );
}
