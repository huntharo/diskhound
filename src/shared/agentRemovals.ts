// ── Agent removal requests (the review list) ────────────────
//
// An agent's diskhound_move_to_trash or diskhound_delete_permanently
// call adds items to a list and returns at once. The user reviews the
// list in DiskHound when they're ready: they untick items to skip them,
// turn a permanent delete into a move to the Trash, and approve the
// rest. Shared between main (src/mcp/removal*.ts) and the review
// sheet. Keep this module free of Node imports: Vite bundles it into
// the renderer.

import type { McpAgentCapability } from "./agentAccess";

export type RemovalAction = "trash" | "delete";

/** Another volume mounted inside a folder. Neither action crosses it. */
export interface RemovalMountInside {
  path: string;
  /** The volume's name for the user. */
  volume: string;
}

/**
 * Whether the Trash (Recycle Bin on Windows) can take an item, checked
 * when the agent asks and again when the user approves.
 */
export interface RemovalVolumeCheck {
  /** The item's volume, named for the user: "the startup disk", "team-share", "D:", "/mnt/scratch". */
  volume: string | null;
  /**
   * Whether the Trash can take the item as a whole: the volume has one
   * and, on Windows, the item fits it. "unknown" when DiskHound couldn't
   * tell; the Trash then either takes it or leaves it on disk.
   */
  trash: "yes" | "no" | "unknown";
  /** Why not, or why DiskHound couldn't tell. One sentence. */
  trashWhy?: string;
  /** Nothing can remove it: the volume is mounted read-only. */
  readOnly: boolean;
  /** Other volumes mounted inside a folder. Both actions leave them alone. */
  mountsInside: RemovalMountInside[];
  /**
   * DiskHound couldn't read the list of volumes, so it can't tell
   * whether another volume is mounted inside. Nothing removes it then.
   */
  volumesUnknown?: boolean;
  checkedAt: number;
}

/** Whether two checks say the same about removing the item (the time aside). */
export function sameVolumeFacts(a: RemovalVolumeCheck, b: RemovalVolumeCheck): boolean {
  return a.trash === b.trash &&
    a.readOnly === b.readOnly &&
    Boolean(a.volumesUnknown) === Boolean(b.volumesUnknown) &&
    a.mountsInside.map((mount) => mount.path).join("\0") === b.mountsInside.map((mount) => mount.path).join("\0");
}

/**
 * - waiting: in the review list.
 * - running: being removed now (never written to disk).
 * - moved / deleted: done, and the path is gone.
 * - partial: done except for other volumes mounted inside, or some parts failed.
 * - skipped: the user unticked it, or chose Skip all.
 * - failed: DiskHound tried and the path is still on disk.
 * - gone: nothing was there any more when the user approved.
 * - refused: not attempted. The session was revoked or lost the
 *   permission, the path changed, or it is now protected.
 */
export type RemovalItemStatus =
  | "waiting"
  | "running"
  | "moved"
  | "deleted"
  | "partial"
  | "skipped"
  | "failed"
  | "gone"
  | "refused";

export interface RemovalOutcome {
  /** What DiskHound did; null when it removed nothing. */
  action: RemovalAction | null;
  /** One line for the user and the agent. */
  message: string;
  at: number;
  /** Paths left on disk on purpose: volumes mounted inside, and the folders that hold them. */
  left?: string[];
}

export interface RemovalItem {
  id: string;
  /** On-disk spelling (symlinks in parent folders resolved, true case). */
  path: string;
  /** What the agent asked for. */
  asked: RemovalAction;
  /** From the newest scan that covers it, or the file's own size; null for an unscanned folder. */
  sizeBytes: number | null;
  check: RemovalVolumeCheck;
  /** Device and inode (file ID on Windows) of what the agent asked about. Something else at the path later is left alone. */
  fileId?: string;
  status: RemovalItemStatus;
  /** Set once the item is decided. */
  outcome?: RemovalOutcome;
}

/** One tool call: up to 20 items with the agent's reason. */
export interface RemovalRequest {
  id: string;
  sessionId: string;
  /** As it was when the agent asked. */
  sessionName: string;
  roleName: string;
  asked: RemovalAction;
  reason: string | null;
  requestedAt: number;
  /** When the last of its items was decided. */
  decidedAt: number | null;
  items: RemovalItem[];
}

export interface AgentRemovalList {
  /** Oldest first. Decided requests are kept for a week so agents can read the outcome. */
  requests: RemovalRequest[];
  /** An approval is running. */
  running: boolean;
}

export const EMPTY_REMOVAL_LIST: AgentRemovalList = { requests: [], running: false };

/** What the user picked for one item in the review sheet. */
export interface RemovalDecision {
  itemId: string;
  /** Ticked: remove it. Unticked: skip it. */
  run: boolean;
  action: RemovalAction;
}

export interface RemovalCount {
  items: number;
  /** Sum of the items' known sizes. */
  bytes: number;
  /** Items with no recorded size. */
  unsized: number;
}

/** What an approval did, for the toast and the sheet's footer. */
export interface RemovalApprovalResult {
  moved: RemovalCount;
  deleted: RemovalCount;
  /** Removed except for volumes mounted inside, or some parts failed. */
  partial: number;
  failed: number;
  skipped: number;
  gone: number;
  refused: number;
  /** Left waiting: the volume changed since the user looked, so they review it again. */
  changed: number;
  /** Agents that had something removed. */
  sessions: number;
}

export function trashName(platform: string): string {
  return platform === "win32" ? "Recycle Bin" : "Trash";
}

export function waitingItems(list: AgentRemovalList): RemovalItem[] {
  return list.requests.flatMap((request) => request.items.filter((item) => item.status === "waiting"));
}

/** What the user can pick for an item, and how the sheet opens it. */
export interface RemovalChoice {
  trash: boolean;
  delete: boolean;
  /** Ticked when the sheet opens: possible as asked, with nothing left for the user to decide. */
  ticked: boolean;
  action: RemovalAction;
  /** Why it can't be removed at all; the checkbox is disabled. */
  locked: string | null;
}

/**
 * The actions an item allows. `granted` is the session's permissions
 * now, or null once it is revoked.
 *
 * - The Trash, when the check didn't rule it out and the role still grants it.
 * - A permanent delete, when the role grants it and either the agent
 *   asked for one or the Trash can't take the item. A request for the
 *   Trash is never turned into a delete when the Trash would take it.
 * - Ticked only when the agent's own action is possible and no volume
 *   is mounted inside; anything else waits for the user to choose.
 */
export function removalChoice(
  item: Pick<RemovalItem, "asked" | "check">,
  granted: readonly McpAgentCapability[] | null,
  sessionName: string,
  platform: string,
): RemovalChoice {
  const bin = trashName(platform);
  const lock = (locked: string): RemovalChoice => ({ trash: false, delete: false, ticked: false, action: item.asked, locked });
  if (!granted) return lock(`${sessionName} was revoked, so its requests can't be approved.`);
  const { check } = item;
  if (check.readOnly) return lock(`${check.volume ?? "This volume"} is read-only, so nothing can remove it.`);
  if (check.volumesUnknown) {
    return lock(`${check.trashWhy ?? "DiskHound couldn't read the list of volumes."} It removes nothing it can't check, so this can only be skipped; the agent can ask again.`);
  }
  const trash = check.trash !== "no" && granted.includes("files.trash");
  const del = granted.includes("files.delete") && (item.asked === "delete" || check.trash === "no");
  if (!trash && !del) {
    if (check.trash === "no") {
      return lock(
        `${check.trashWhy ?? `It can't go to the ${bin}.`} Only a permanent delete would remove it, and ${sessionName} ${item.asked === "delete" ? "may no longer delete permanently" : "didn't ask for one"}.`,
      );
    }
    return lock(`${sessionName}'s role no longer allows this.`);
  }
  const askedOk = item.asked === "trash" ? trash : del;
  const action = askedOk ? item.asked : trash ? "trash" : "delete";
  // Windows deletes what its Recycle Bin can't hold instead of recycling
  // it, so an item that may not fit waits for the user to tick it.
  const mayNotFit = platform === "win32" && action === "trash" && check.trash === "unknown";
  return { trash, delete: del, ticked: askedOk && check.mountsInside.length === 0 && !mayNotFit, action, locked: null };
}

/** "archive/" for a mount inside `/x/datasets`; the mount's path relative to the item. */
export function mountLabel(itemPath: string, mountPath: string): string {
  const rest = mountPath.slice(itemPath.length).replace(/^[\\/]+/, "");
  return `${rest || mountPath}${mountPath.includes("\\") ? "\\" : "/"}`;
}

/** What removing the ticked items together frees (the scanner's measure mode). */
export interface RemovalSetMeasurement {
  paths: { path: string; sizeBytes: number; freesAloneBytes: number; sharedBytes: number; uncertainBytes: number }[];
  total: { files: number; sizeBytes: number; freesBytes: number; heldElsewhereBytes: number; uncertainBytes: number };
  /** False off APFS, where no clone data exists. */
  cloneMetadata: boolean;
  measuredAt: number;
}

export type RemovalMeasureResult = { ok: true; measurement: RemovalSetMeasurement } | { ok: false; error: string };
