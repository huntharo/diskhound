import { useEffect, useRef, useState } from "preact/hooks";

import type { AgentAccessSnapshot } from "../../shared/agentAccess";
import { nativeApi } from "../nativeApi";

/**
 * One copy of the agent access snapshot for the main window. The header
 * agent button and Settings → AI Agents both read it. Main pushes every
 * change (sessions, pending approvals, status), each agent action and
 * each blocked request, so opening Settings or the popover asks main for
 * nothing after the first load.
 */
let current: AgentAccessSnapshot | null = null;
let loading: Promise<void> | null = null;
let subscribed = false;
const listeners = new Set<(snapshot: AgentAccessSnapshot) => void>();

function publish(next: AgentAccessSnapshot): void {
  current = next;
  for (const listener of [...listeners]) listener(next);
}

function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  nativeApi.onAgentAccessChanged(publish);
  nativeApi.onAgentActivity((entry) => {
    if (!current) return;
    publish({
      ...current,
      activity: [entry, ...current.activity.filter((e) => e.id !== entry.id)].slice(0, 100),
    });
  });
  // A repeat of an event arrives with the same id and a higher count.
  nativeApi.onAgentSecurityEvent((event) => {
    if (!current) return;
    publish({
      ...current,
      security: [event, ...current.security.filter((e) => e.id !== event.id)].slice(0, 200),
    });
  });
}

/** Load once; later callers share the same request. */
export function loadAgentAccess(): Promise<void> {
  subscribe();
  loading ??= nativeApi.getAgentAccess().then(publish, () => {
    loading = null;
  });
  return loading;
}

/** Store the snapshot an action (toggle, revoke, role change) returned. */
export function setAgentAccess(next: AgentAccessSnapshot): void {
  publish(next);
}

/** Where in Settings → AI Agents a link should land. */
export type AgentSettingsTarget = "section" | "connect" | "blocked";

let focusRequest: AgentSettingsTarget | null = null;
const focusListeners = new Set<(target: AgentSettingsTarget) => void>();

/**
 * Ask Settings → AI Agents to show a part of itself. Settings may not be
 * mounted yet (the tab is switching), so the request waits until it is.
 */
export function focusAgentSettings(target: AgentSettingsTarget): void {
  focusRequest = target;
  for (const listener of [...focusListeners]) listener(target);
}

/** For AgentsSection: the request made before it mounted, and later ones. */
export function useAgentSettingsFocus(onFocus: (target: AgentSettingsTarget) => void): void {
  const latest = useRef(onFocus);
  latest.current = onFocus;
  useEffect(() => {
    const listener = (target: AgentSettingsTarget) => {
      focusRequest = null;
      latest.current(target);
    };
    focusListeners.add(listener);
    if (focusRequest) listener(focusRequest);
    return () => {
      focusListeners.delete(listener);
    };
  }, []);
}

export function useAgentAccess(): AgentAccessSnapshot | null {
  const [snapshot, setSnapshot] = useState(current);
  useEffect(() => {
    listeners.add(setSnapshot);
    if (current) setSnapshot(current);
    else void loadAgentAccess();
    return () => {
      listeners.delete(setSnapshot);
    };
  }, []);
  return snapshot;
}
