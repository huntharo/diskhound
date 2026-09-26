import { useEffect, useState } from "preact/hooks";

import {
  MCP_AGENT_CAPABILITY_DETAILS,
  type AgentConsentPrompt,
} from "../../shared/agentAccess";
import type { GeneralSettings } from "../../shared/contracts";
import { nativeApi } from "../nativeApi";

/**
 * The approval window main opens when an agent runs its OAuth login
 * (`claude mcp login diskhound`, Codex's first connect). The browser
 * tab the agent opened only shows a waiting page; the decision is
 * made here, in a window only DiskHound controls. Closing the window
 * counts as Deny.
 */
export function AgentConsentWindow() {
  const [prompt, setPrompt] = useState<AgentConsentPrompt | null>(null);
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.body.classList.add("agent-consent-body");
    // index.html's <title> would otherwise replace the window title main set.
    document.title = "Approve agent access — DiskHound";
    void nativeApi.getSettings().then((settings) => {
      const root = document.documentElement;
      root.classList.remove("dark", "light");
      root.classList.add(resolveTheme(settings.general.theme));
    });
    void nativeApi.agentConsentRead().then((next) => {
      if (!next) {
        setError("This request is no longer waiting for approval.");
        return;
      }
      setPrompt(next);
      setName(next.sessionName);
      setRoleId(next.roles.some((role) => role.id === next.defaultRoleId)
        ? next.defaultRoleId
        : next.roles[0]?.id ?? "");
    });
    return () => document.body.classList.remove("agent-consent-body");
  }, []);

  const role = prompt?.roles.find((candidate) => candidate.id === roleId);

  const decide = async (decision: "allow" | "deny") => {
    if (!prompt || busy) return;
    setBusy(true);
    const result = await nativeApi.agentConsentDecide({
      requestId: prompt.requestId,
      decision,
      sessionName: name.trim(),
      roleId,
    });
    // On success main closes this window.
    if (!result.ok) {
      setError(result.message ?? "DiskHound couldn't record that decision.");
      setBusy(false);
    }
  };

  return (
    <main className="agent-consent">
      <header className="agent-consent-header">
        <div className="agent-consent-eyebrow">DiskHound · AI Agents</div>
        <h1>Approve agent access</h1>
        <p>
          <strong>{prompt?.clientName ?? "An agent"}</strong> wants to connect to DiskHound over MCP.
          Choose what this session may do.
        </p>
      </header>

      {error && <div className="agent-consent-error" role="alert">{error}</div>}

      {prompt && (
        <>
          <label className="agent-consent-field">
            <span>Session name</span>
            <input
              className="filter-input"
              autoFocus
              maxLength={200}
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
            />
          </label>

          <label className="agent-consent-field">
            <span>Role</span>
            <select
              className="setting-select"
              value={roleId}
              onChange={(e) => setRoleId((e.target as HTMLSelectElement).value)}
            >
              {prompt.roles.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
              ))}
            </select>
          </label>

          {role ? (
            <>
              <p className="agent-consent-role-desc">{role.description}</p>
              <ul className="agent-consent-permissions">
                {role.permissions.map((permission) => {
                  const details = MCP_AGENT_CAPABILITY_DETAILS[permission];
                  return (
                    <li key={permission} className={details.danger === "sensitive" ? "sensitive" : ""}>
                      <div className="agent-consent-permission-label">{details.label}</div>
                      <div className="agent-consent-permission-detail">{details.detail}</div>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="agent-consent-role-desc">No role fits the permissions this agent requested.</p>
          )}

          <p className="agent-consent-footnote">
            Files are only ever moved to the {nativeApi.platform === "win32" ? "Recycle Bin" : "Trash"}, and
            DiskHound asks you before each move. Change the role or revoke this session in
            Settings → AI Agents at any time.
          </p>

          <div className="agent-consent-actions">
            <button className="action-btn" disabled={busy} onClick={() => void decide("deny")}>
              Deny
            </button>
            <button
              className="action-btn primary"
              disabled={busy || !name.trim() || !role}
              onClick={() => void decide("allow")}
            >
              Approve
            </button>
          </div>
        </>
      )}
    </main>
  );
}

function resolveTheme(theme: GeneralSettings["theme"]): "dark" | "light" {
  if (theme === "light") return "light";
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return "dark";
}
