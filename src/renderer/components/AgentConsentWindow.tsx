import { useEffect, useRef, useState } from "preact/hooks";

import {
  MCP_AGENT_CAPABILITY_DETAILS,
  type AgentConsentPrompt,
  type McpAgentCapability,
  type McpAgentRole,
} from "../../shared/agentAccess";
import type { GeneralSettings } from "../../shared/contracts";
import { capabilityChip } from "../lib/agentDisplay";
import { nativeApi } from "../nativeApi";

/**
 * The approval sheet main attaches to DiskHound's main window when an
 * agent signs in (the stdio helper, or Codex's browser tab). The agent's
 * side only waits; the decision is made here, in a window only DiskHound
 * controls. Closing it counts as Deny.
 */
export function AgentConsentWindow() {
  const [prompt, setPrompt] = useState<AgentConsentPrompt | null>(null);
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [stale, setStale] = useState(false);
  const [next, setNext] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const deltaRef = useRef<HTMLDivElement>(null);

  // The sheet scrolls, so a role that adds permissions brings its
  // warning into view above the buttons before the user approves.
  useEffect(() => {
    deltaRef.current?.querySelector(".agent-consent-delta")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [roleId]);

  useEffect(() => {
    document.body.classList.add("agent-consent-body");
    // index.html's <title> would otherwise replace the window title main set.
    document.title = "Approve agent access — DiskHound";
    void nativeApi.getSettings().then((settings) => {
      const root = document.documentElement;
      root.classList.remove("dark", "light");
      root.classList.add(resolveTheme(settings.general.theme));
    });
    let requestId: string | null = null;
    const off = nativeApi.onAgentConsentState((state) => {
      if (requestId !== null && state.requestId !== requestId) return;
      setStale(state.stale);
      setNext(state.next);
    });
    void nativeApi.agentConsentRead().then((read) => {
      if (!read) {
        setError("This request is no longer waiting for approval.");
        return;
      }
      requestId = read.requestId;
      setPrompt(read);
      setStale(read.stale);
      setNext(read.next);
      setName(read.sessionName);
      setRoleId(read.roles.some((role) => role.id === read.defaultRoleId)
        ? read.defaultRoleId
        : read.roles[0]?.id ?? "");
    });
    return () => {
      off();
      document.body.classList.remove("agent-consent-body");
    };
  }, []);

  const role = prompt?.roles.find((candidate) => candidate.id === roleId);
  const defaultRole = prompt?.roles.find((candidate) => candidate.id === prompt.defaultRoleId);
  const client = prompt?.clientName ?? "An agent";

  const decide = async (decision: "allow" | "deny") => {
    if (!prompt || busy) return;
    setBusy(true);
    const result = await nativeApi.agentConsentDecide({
      requestId: prompt.requestId,
      decision,
      sessionName: name.trim(),
      roleId,
    });
    // On success main closes this sheet.
    if (!result.ok) {
      setError(result.message ?? "DiskHound couldn't record that decision.");
      setBusy(false);
    }
  };

  return (
    <main className="agent-consent">
      <header className="agent-consent-header">
        <div className="agent-consent-eyebrow">
          Agent sign-in{prompt ? ` · via ${prompt.via === "stdio" ? "stdio helper" : "HTTP"}` : ""}
        </div>
        <h1>Approve {client}?</h1>
        <p>
          <strong>{client}</strong> wants to use DiskHound. Choose what this session may do.
        </p>
      </header>

      {stale && (
        <div className="agent-consent-stale" role="status">
          <span className="agent-consent-stale-dot" />
          <span>
            <strong>{client} stopped waiting for this answer.</strong> It may have timed out or quit, so
            approving now would connect nothing. Deny it, then reconnect from {client}.
          </span>
        </div>
      )}
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

          <div className="agent-consent-field" id="agent-consent-role-label">Role</div>
          {prompt.roles.length === 0 ? (
            <p className="agent-consent-role-desc">No role fits the permissions this agent requested.</p>
          ) : (
            <div className="agent-role-cards" role="radiogroup" aria-labelledby="agent-consent-role-label">
              {prompt.roles.map((candidate) => (
                <RoleCard
                  key={candidate.id}
                  role={candidate}
                  selected={candidate.id === roleId}
                  disabled={busy}
                  onSelect={() => setRoleId(candidate.id)}
                />
              ))}
            </div>
          )}

          {role && (
            <>
              <div ref={deltaRef}>
                <Delta role={role} base={defaultRole} />
              </div>
              <button className="agent-consent-more" onClick={() => setDetails(!details)} aria-expanded={details}>
                <span className={`agent-disclose-chevron ${details ? "open" : ""}`} />
                What each permission allows
              </button>
              {details && (
                <ul className="agent-consent-permissions">
                  {role.permissions.map((permission) => {
                    const detail = MCP_AGENT_CAPABILITY_DETAILS[permission];
                    return (
                      <li key={permission} className={detail.danger}>
                        <div className="agent-consent-permission-label">{detail.label}</div>
                        <div className="agent-consent-permission-detail">{detail.detail}</div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}

          <p className="agent-consent-footnote">
            Change the role or revoke this session any time in Settings → AI Agents.
          </p>

          <div className="agent-consent-actions">
            {next && <span className="agent-consent-queue">Next: {next}</span>}
            <button className={`action-btn ${stale ? "agent-consent-default" : ""}`} disabled={busy} onClick={() => void decide("deny")}>
              Deny
            </button>
            <button
              className="scan-btn scan-btn-primary agent-consent-approve"
              disabled={busy || stale || !name.trim() || !role}
              title={stale ? `${client} is no longer waiting` : undefined}
              onClick={() => void decide("allow")}
            >
              {role ? `Approve as ${role.name}` : "Approve"}
            </button>
          </div>
        </>
      )}
    </main>
  );
}

function RoleCard({ role, selected, disabled, onSelect }: {
  role: McpAgentRole;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const deletes = role.permissions.includes("files.delete");
  return (
    <button
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      className={`agent-role-card ${selected ? (deletes ? "selected destructive" : "selected") : ""}`}
      onClick={onSelect}
    >
      <span className="agent-role-radio" />
      <span className="agent-role-body">
        <span className="agent-role-name">{role.name}</span>
        <span className="agent-role-line">{role.description}</span>
        <span className="agent-role-caps">
          {role.permissions.map((permission) => (
            <span key={permission} className={`agent-cap ${MCP_AGENT_CAPABILITY_DETAILS[permission].danger}`}>
              {capabilityChip(permission, nativeApi.platform)}
            </span>
          ))}
        </span>
      </span>
    </button>
  );
}

/** What the picked role adds over the default, when it adds anything. */
function Delta({ role, base }: { role: McpAgentRole; base: McpAgentRole | undefined }) {
  if (!base || role.id === base.id) return null;
  const added = role.permissions.filter((permission) => !base.permissions.includes(permission));
  if (added.length === 0) return null;
  const destructive = added.some((permission) => MCP_AGENT_CAPABILITY_DETAILS[permission].danger === "destructive");
  const deletes = added.includes("files.delete");
  const bin = nativeApi.platform === "win32" ? "Recycle Bin" : "Trash";
  const verbs = added.map((permission) => MCP_AGENT_CAPABILITY_DETAILS[permission].verb.replace("Trash", bin));
  return (
    <div className={`agent-consent-delta ${deletes ? "destructive" : ""}`}>
      <span className="agent-consent-delta-plus">+</span>
      <span>
        More than the default <strong>{base.name}</strong>: this session can {destructive ? "ask to " : ""}
        {verbs.join(" and ")}.
        {deletes ? " Deleted items can't be restored." : ""}
        {destructive ? " You confirm every request." : ""}
      </span>
    </div>
  );
}

function resolveTheme(theme: GeneralSettings["theme"]): "dark" | "light" {
  if (theme === "light") return "light";
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return "dark";
}
