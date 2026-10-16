import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import { BUILT_IN_MCP_ROLES } from "../../shared/agentAccess";
import {
  mountLabel,
  trashName,
  type RemovalAction,
  type RemovalApprovalResult,
  type RemovalItem,
  type RemovalMeasureResult,
} from "../../shared/agentRemovals";
import { closeRemovalReview, useAgentAccess } from "../lib/agentAccessStore";
import { roleShortName, viaLabel } from "../lib/agentDisplay";
import { formatBytes, relativeTime } from "../lib/format";
import { reviewGroups, type ReviewRow } from "../lib/removalReview";
import { nativeApi } from "../nativeApi";
import { MiddleEllipsis } from "./MiddleEllipsis";

/**
 * The review list: every removal request agents made, grouped by agent
 * and reason. The user unticks items to skip them, turns a permanent
 * delete into a move to the Trash, sees what the ticked items free
 * together, and approves. Nothing here reads the disk or calls main
 * until the user measures or approves: the list came with the agent
 * snapshot, and ticks and actions are local until the button sends them.
 */

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function sizeText(items: readonly { sizeBytes: number | null }[]): string {
  const known = items.filter((item) => item.sizeBytes !== null);
  if (known.length === 0) return items.length ? "size unknown" : "0 B";
  const total = known.reduce((sum, item) => sum + item.sizeBytes!, 0);
  return `${known.length < items.length ? "at least " : ""}${formatBytes(total)}`;
}

function resultLabel(item: RemovalItem, bin: string): { text: string; tone: "ok" | "skip" | "bad" | "busy" } {
  switch (item.status) {
    case "running": return { text: "Removing…", tone: "busy" };
    case "moved": return { text: `Moved to the ${bin}`, tone: "ok" };
    case "deleted": return { text: "Deleted", tone: "ok" };
    case "partial": {
      const except = item.check.mountsInside.map((mount) => mountLabel(item.path, mount.path)).join(", ");
      return { text: `${item.outcome?.action === "trash" ? "Moved" : "Deleted"}, except ${except}`, tone: "ok" };
    }
    case "skipped": return { text: "Skipped", tone: "skip" };
    case "gone": return { text: "Already gone", tone: "skip" };
    case "refused": return { text: "Not allowed", tone: "bad" };
    case "failed": return { text: item.asked === "trash" ? "Not moved" : "Not deleted", tone: "bad" };
    default: return { text: "", tone: "skip" };
  }
}

export function RemovalReviewSheet() {
  const snapshot = useAgentAccess();
  const platform = nativeApi.platform;
  const bin = trashName(platform);
  // Requests stay on the sheet once shown, so their results appear in place.
  const shown = useRef(new Set<string>());
  // Items on the list when the sheet opened. One an agent adds later starts
  // unticked, so Remove never runs something the user hasn't looked at.
  const opened = useRef<Set<string> | null>(null);
  const [ticks, setTicks] = useState(() => new Map<string, boolean>());
  const [actions, setActions] = useState(() => new Map<string, RemovalAction>());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RemovalApprovalResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [measure, setMeasure] = useState<{ key: string; result: RemovalMeasureResult; at: number } | null>(null);
  const [measuring, setMeasuring] = useState<string | null>(null);

  // Keys stay in the sheet: the views' shortcuts (Delete trashes the
  // focused file in Largest Files) must not act behind it.
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    sheetRef.current?.focus();
  }, []);

  const requests = useMemo(() => {
    if (!snapshot) return [];
    for (const request of snapshot.removals.requests) {
      if (request.items.some((item) => item.status === "waiting" || item.status === "running")) shown.current.add(request.id);
    }
    const list = snapshot.removals.requests.filter((request) => shown.current.has(request.id));
    opened.current ??= new Set(list.flatMap((request) => request.items.map((item) => item.id)));
    return list;
  }, [snapshot?.removals]);

  const late = useMemo(
    () => new Set(requests.flatMap((request) => request.items.filter((item) => !opened.current?.has(item.id)).map((item) => item.id))),
    [requests],
  );
  const groups = useMemo(() => {
    const start = new Map<string, boolean>([...late].map((id) => [id, false]));
    for (const [id, on] of ticks) start.set(id, on);
    return reviewGroups(requests, snapshot?.sessions ?? [], start, actions, platform);
  }, [requests, late, snapshot?.sessions, ticks, actions]);
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);

  if (!snapshot) return null;

  const waiting = rows.filter((row) => row.item.status === "waiting");
  const ticked = waiting.filter((row) => row.ticked);
  const toTrash = ticked.filter((row) => row.action === "trash");
  const toDelete = ticked.filter((row) => row.action === "delete");
  const tickedKey = ticked.map((row) => row.item.id).sort().join(",");
  const measured = measure && measure.key === tickedKey && measure.result.ok ? measure.result.measurement : null;
  const freesAlone = new Map(measured?.paths.map((path) => [path.path, path]) ?? []);
  const agents = new Set(waiting.map((row) => row.request.sessionId)).size;
  const running = snapshot.removals.running || busy;

  const setTick = (id: string, on: boolean) => setTicks((prev) => new Map(prev).set(id, on));
  const setAction = (id: string, action: RemovalAction) => setActions((prev) => new Map(prev).set(id, action));

  const approve = async (skipAll: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const decisions = waiting.map((row) => ({ itemId: row.item.id, run: !skipAll && row.ticked, action: row.action }));
      setResult(await nativeApi.approveAgentRemovals(decisions));
      // Items still waiting (their volume changed) start over from what DiskHound found.
      setTicks(new Map());
      setActions(new Map());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runMeasure = async () => {
    const key = tickedKey;
    setMeasuring(key);
    try {
      const outcome = await nativeApi.measureAgentRemovals(ticked.map((row) => row.item.id));
      setMeasure({ key, result: outcome, at: Date.now() });
    } catch (err) {
      setMeasure({ key, result: { ok: false, error: err instanceof Error ? err.message : String(err) }, at: Date.now() });
    } finally {
      setMeasuring(null);
    }
  };

  const primaryLabel = [
    toTrash.length ? `Move ${toTrash.length} to ${bin}` : null,
    toDelete.length ? `Delete ${toDelete.length}` : null,
  ].filter(Boolean).join(" · ") || "Remove";

  const meta = (row: ReviewRow): { text: string; tone: "" | "warn" | "gone" } | null => {
    const { item, choice } = row;
    if (item.status !== "waiting" && item.status !== "running") {
      return item.outcome && item.status !== "moved" && item.status !== "deleted" && item.status !== "skipped"
        ? { text: item.outcome.message, tone: item.status === "failed" || item.status === "refused" ? "warn" : "gone" }
        : null;
    }
    if (choice.locked) return { text: choice.locked, tone: "gone" };
    const lines: string[] = [];
    let tone: "" | "warn" = "";
    if (late.has(item.id) && !row.ticked) lines.push("Added while the list was open. Tick it to include it.");
    const alone = freesAlone.get(item.path);
    if (alone) {
      lines.push(`Frees ${formatBytes(alone.freesAloneBytes)}${alone.sharedBytes > 0 ? ` alone; ${formatBytes(alone.sharedBytes)} is shared with files outside it` : ""}.`);
    } else if (item.sizeBytes === null) {
      lines.push("No scan covers it, so its size is unknown until you measure.");
    }
    if (item.check.mountsInside.length > 0) {
      const labels = item.check.mountsInside.map((mount) => `${mountLabel(item.path, mount.path)} is the volume ${mount.volume}`).join("; ");
      lines.push(`${labels}, mounted inside it. DiskHound leaves it alone and removes the rest${row.ticked ? "" : " if you tick this"}.`);
      tone = "warn";
    }
    if (item.check.trash === "no" && (item.asked === "trash" || row.action === "trash")) {
      lines.push(choice.delete
        ? `${item.check.trashWhy ?? `It can't go to the ${bin}.`} Only a permanent delete would remove it${row.ticked ? "" : ", so it waits for you to tick it"}.`
        : item.check.trashWhy ?? "");
      tone = "warn";
    } else if (item.check.trash === "unknown" && row.action === "trash" && item.check.trashWhy) {
      lines.push(item.check.trashWhy);
      tone = "warn";
    }
    if (item.asked === "delete" && row.action === "trash") lines.push(`You changed this to the ${bin}.`);
    if (lines.length === 0) return null;
    return { text: lines.join(" "), tone };
  };

  const footerNote = (() => {
    if (result) return null;
    const parts = [
      toDelete.length ? `Deleted items free their space now.` : null,
      toTrash.length
        ? `The ${bin} keeps what it holds until you empty it${platform === "darwin" ? ", and a Time Machine local snapshot can keep space in use for a while" : ""}.`
        : null,
      "Skipped items are reported to their agent.",
    ];
    return parts.filter(Boolean).join(" ");
  })();

  const resultText = (() => {
    if (!result) return null;
    const removed = result.moved.items + result.deleted.items + result.partial;
    return [
      removed ? `Removed ${plural(removed, "item")} for ${plural(result.sessions, "agent")}.` : "Nothing was removed.",
      result.deleted.items ? `Deleted ${result.deleted.items}${result.deleted.items > result.deleted.unsized ? `: ${sizeText(rows.filter((row) => row.item.status === "deleted").map((row) => row.item))} free now` : ""}.` : null,
      result.moved.items ? `Moved ${result.moved.items} to the ${bin}${result.moved.items > result.moved.unsized ? `: ${sizeText(rows.filter((row) => row.item.status === "moved").map((row) => row.item))} more once you empty it` : ""}.` : null,
      result.failed ? `${result.failed} not removed.` : null,
      result.refused ? `${result.refused} not allowed any more.` : null,
      result.gone ? `${result.gone} already gone.` : null,
      result.skipped ? `${result.skipped} skipped.` : null,
      result.changed ? `${plural(result.changed, "item")} changed since you looked; ${result.changed === 1 ? "it's" : "they're"} still on the list.` : null,
    ].filter(Boolean).join(" ");
  })();

  return (
    <div className="rv-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !running) closeRemovalReview(); }}>
      <div
        className="rv-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rv-title"
        tabIndex={-1}
        ref={sheetRef}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" && !running) closeRemovalReview();
        }}
      >
        <div className="rv-head">
          <div className="rv-eyebrow">
            Agent requests · {plural(agents, "agent")} · {plural(waiting.length, "item")}
          </div>
          <h2 id="rv-title" className="rv-title">Review what agents want to remove</h2>
          <p className="rv-sub">
            Ticked items are removed when you click the button below. Unticked ones are skipped. Each agent is told what you decided.
          </p>
        </div>

        <div className="rv-body">
          {groups.length === 0 && (
            <div className="rv-empty">Nothing to review. When an agent asks to move or delete something, it waits here for you.</div>
          )}
          {groups.map(({ request, session, rows: groupRows }) => {
            const role = BUILT_IN_MCP_ROLES.find((candidate) => candidate.id === session?.roleId);
            return (
              <section key={request.id} className="rv-group" aria-label={`${request.sessionName}'s request`}>
                <div className="rv-group-head">
                  <span className="rv-group-name">{request.sessionName}</span>
                  {session?.client?.via && <span className="agent-role-chip">{viaLabel(session.client.via)}</span>}
                  <span className="agent-role-chip">{session && session.revokedAt === null ? roleShortName(role) : "Revoked"}</span>
                  <span className="rv-group-line">
                    asked to {request.asked === "trash" ? `move ${plural(request.items.length, "item")} to the ${bin}` : `delete ${plural(request.items.length, "item")} permanently`} · {relativeTime(request.requestedAt)}
                  </span>
                </div>
                {request.reason && <p className="rv-reason">“{request.reason}”</p>}
                <div className="rv-list">
                  {groupRows.map((row) => {
                    const { item, choice } = row;
                    const isWaiting = item.status === "waiting";
                    const note = meta(row);
                    const label = isWaiting ? null : resultLabel(item, bin);
                    return (
                      <div key={item.id} className={`rv-row ${isWaiting && !row.ticked ? "off" : ""} ${choice.locked && isWaiting ? "locked" : ""}`}>
                        <input
                          type="checkbox"
                          className="rv-check"
                          checked={row.ticked}
                          disabled={!isWaiting || Boolean(choice.locked) || running}
                          aria-label={`Remove ${item.path}`}
                          onChange={(event) => setTick(item.id, (event.currentTarget as HTMLInputElement).checked)}
                        />
                        <div className="rv-main">
                          <div className="rv-path" title={item.path}><MiddleEllipsis text={item.path} /></div>
                          {note && <div className={`rv-meta ${note.tone}`}>{note.text}</div>}
                        </div>
                        <div className="rv-size">{item.sizeBytes === null ? "—" : formatBytes(item.sizeBytes)}</div>
                        <div className="rv-action">
                          {label ? (
                            <span className={`rv-result ${label.tone}`}>{label.text}</span>
                          ) : choice.locked ? (
                            <span className="rv-one no">{item.check.trash === "no" ? `No ${bin}` : "Can't"}</span>
                          ) : choice.trash && choice.delete ? (
                            <span className="rv-seg" role="radiogroup" aria-label={`Action for ${item.path}`}>
                              {(["trash", "delete"] as const).map((action) => (
                                <button
                                  key={action}
                                  type="button"
                                  role="radio"
                                  aria-checked={row.action === action}
                                  className={`rv-segb ${row.action === action ? "on" : ""} ${action === "delete" ? "del" : ""}`}
                                  disabled={running}
                                  onClick={() => setAction(item.id, action)}
                                >
                                  {action === "trash" ? (platform === "win32" ? "Recycle" : "Trash") : "Delete"}
                                </button>
                              ))}
                            </span>
                          ) : (
                            <span className={`rv-one ${row.action === "delete" ? "del" : ""}`}>
                              {row.action === "trash" ? (platform === "win32" ? "Recycle Bin" : "Trash") : "Delete"}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>

        <div className="rv-foot">
          {result ? (
            <div className={`rv-done ${result.failed + result.refused + result.changed > 0 ? "warn" : ""}`} role="status">{resultText}</div>
          ) : (
            <>
              <div className="rv-sum">
                <span><b>{ticked.length}</b> of {waiting.length} ticked</span>
                <span><b>{sizeText(ticked.map((row) => row.item))}</b> on disk</span>
                {platform !== "win32" && ticked.length > 0 && (
                  measured ? (
                    <span>Frees <b>{formatBytes(measured.total.freesBytes)}</b> together · measured {relativeTime(measure!.at)}</span>
                  ) : (
                    <button type="button" className="agent-pop-link rv-measure" disabled={measuring !== null || running} onClick={() => void runMeasure()}>
                      {measuring ? "Measuring…" : measure && measure.key !== tickedKey ? "Ticks changed · measure again" : "Measure what they free together"}
                    </button>
                  )
                )}
              </div>
              {measure && measure.key === tickedKey && !measure.result.ok && <div className="rv-note warn">{measure.result.error}</div>}
              {footerNote && <div className="rv-note">{footerNote}</div>}
            </>
          )}
          {error && <div className="rv-note warn">{error}</div>}
          <div className="rv-acts">
            {waiting.length > 0 && !running ? (
              <>
                <button type="button" className="scan-btn" onClick={() => closeRemovalReview()}>Later</button>
                <button type="button" className="scan-btn" onClick={() => void approve(true)}>Skip all</button>
                <button
                  type="button"
                  className={`scan-btn scan-btn-primary ${toDelete.length ? "rv-danger" : ""}`}
                  disabled={ticked.length === 0}
                  onClick={() => void approve(false)}
                >
                  {primaryLabel}
                </button>
              </>
            ) : (
              <button type="button" className="scan-btn" disabled={running} onClick={() => closeRemovalReview()}>
                {running ? "Removing…" : "Close"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
