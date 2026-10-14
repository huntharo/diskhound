import * as Path from "node:path";

import type { McpAgentCapability } from "../shared/agentAccess";
import {
  removalChoice,
  mountLabel,
  trashName,
  type RemovalAction,
  type RemovalApprovalResult,
  type RemovalDecision,
  type RemovalItem,
  type RemovalItemStatus,
  type RemovalOutcome,
  type RemovalVolumeCheck,
} from "../shared/agentRemovals";
import type { PathActionResult } from "../shared/contracts";
import type { RemovalQueue } from "./removalQueue";

/**
 * Runs what the user approved in the review sheet. Items can wait for
 * days, so everything is checked again first: the session's current
 * role, the path on disk, the protected folders, and the volume. An
 * item whose volume changed since the user looked stays in the list
 * with the new facts instead of running. Results come from the disk
 * after each action, through main's own Trash and delete, which report
 * a path still on disk as not removed.
 */

export interface SessionAccess {
  name: string;
  roleName: string;
  capabilities: readonly McpAgentCapability[];
}

export interface RemovalReviewDeps {
  queue: RemovalQueue;
  /** The volume check, run again for the items about to go. */
  check(items: readonly { path: string; sizeBytes: number | null }[]): Promise<RemovalVolumeCheck[]>;
  /** On-disk spelling; throws when nothing is there. */
  canonicalPath(path: string): Promise<string>;
  /** Why an agent may not remove this path now (protected folders, home, drive roots), or null. */
  protection(): Promise<(requested: string, target: string) => string | null>;
  /** Read the sessions once per approval: id → the session as it is now, null once revoked or forgotten. */
  sessions(): (sessionId: string) => SessionAccess | null;
  trashPath(path: string): Promise<PathActionResult>;
  deletePath(path: string): Promise<PathActionResult>;
  /** Entry names in a folder. */
  listDir(path: string): Promise<string[]>;
  platform: NodeJS.Platform;
  now?: () => number;
}

/** What went where, for the window's strike-through and the measurement cache. */
export interface RemovalRun {
  result: RemovalApprovalResult;
  trashed: string[];
  deleted: string[];
}

function key(path: string, platform: NodeJS.Platform): string {
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
  return platform === "win32" || platform === "darwin" ? trimmed.toLowerCase() : trimmed;
}

function strictlyInside(outer: string, inner: string, platform: NodeJS.Platform): boolean {
  const o = key(outer, platform);
  const i = key(inner, platform);
  const sep = platform === "win32" ? "\\" : "/";
  return i !== o && i.startsWith(o.endsWith(sep) ? o : o + sep);
}

/**
 * The largest parts of `root` that hold none of `mounts`: what to
 * remove so no other volume is touched. `holders` are the folders left
 * in place because a mount sits inside them (root included).
 * Reads one folder listing per holder.
 */
export async function removalUnits(
  root: string,
  mounts: readonly string[],
  listDir: (path: string) => Promise<string[]>,
  platform: NodeJS.Platform,
): Promise<{ units: string[]; holders: string[] }> {
  const api = platform === "win32" ? Path.win32 : Path.posix;
  const mountKeys = new Set(mounts.map((mount) => key(mount, platform)));
  const units: string[] = [];
  const holders: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (mountKeys.has(key(dir, platform))) continue;
    const inside = mounts.filter((mount) => strictlyInside(dir, mount, platform));
    if (inside.length === 0) {
      units.push(dir);
      continue;
    }
    holders.push(dir);
    const names = await listDir(dir);
    for (const name of names) {
      const child = api.join(dir, name);
      // Only children on the way to a mount need opening; the rest go whole.
      if (mountKeys.has(key(child, platform)) || inside.some((mount) => strictlyInside(child, mount, platform))) stack.push(child);
      else units.push(child);
    }
  }
  return { units: units.sort(), holders };
}

function sameCheck(a: RemovalVolumeCheck, b: RemovalVolumeCheck): boolean {
  return a.trash === b.trash &&
    a.readOnly === b.readOnly &&
    a.mountsInside.map((mount) => mount.path).join("\0") === b.mountsInside.map((mount) => mount.path).join("\0");
}

const emptyCount = () => ({ items: 0, bytes: 0, unsized: 0 });

export class RemovalReview {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RemovalReviewDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** One approval at a time; a second click waits for the first. */
  approve(decisions: readonly RemovalDecision[]): Promise<RemovalRun> {
    const run = () => this.deps.queue.batch(() => this.run(decisions));
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async run(decisions: readonly RemovalDecision[]): Promise<RemovalRun> {
    const { queue, platform } = this.deps;
    const bin = trashName(platform);
    const result: RemovalApprovalResult = {
      moved: emptyCount(), deleted: emptyCount(), partial: 0, failed: 0, skipped: 0, gone: 0, refused: 0, changed: 0, sessions: 0,
    };
    const trashed: string[] = [];
    const deleted: string[] = [];
    const sessions = new Set<string>();

    // The latest decision per waiting item; anything else (decided, unknown) is ignored.
    const byItem = new Map<string, RemovalDecision>();
    for (const decision of decisions) byItem.set(decision.itemId, decision);
    const work = [...byItem.values()]
      .map((decision) => ({ decision, found: queue.find(decision.itemId) }))
      .filter((entry): entry is { decision: RemovalDecision; found: NonNullable<ReturnType<RemovalQueue["find"]>> } =>
        entry.found !== null && entry.found.item.status === "waiting");

    const decide = (item: RemovalItem, sessionId: string, status: Exclude<RemovalItemStatus, "waiting" | "running">, outcome: Omit<RemovalOutcome, "at">) => {
      queue.decide(item.id, status, { ...outcome, at: this.now() });
      if (status === "moved" || status === "deleted" || status === "partial") sessions.add(sessionId);
      if (status === "skipped") result.skipped++;
      else if (status === "gone") result.gone++;
      else if (status === "refused") result.refused++;
      else if (status === "failed") result.failed++;
      else if (status === "partial") result.partial++;
      else {
        const count = status === "moved" ? result.moved : result.deleted;
        count.items++;
        if (item.sizeBytes === null) count.unsized++;
        else count.bytes += item.sizeBytes;
      }
    };

    for (const { decision, found } of work) {
      if (!decision.run) decide(found.item, found.request.sessionId, "skipped", { action: null, message: "You skipped it." });
    }

    const toRun = work.filter(({ decision }) => decision.run);
    const protection = toRun.length > 0 ? await this.deps.protection() : () => null;
    const checks = toRun.length > 0
      ? await this.deps.check(toRun.map(({ found }) => ({ path: found.item.path, sizeBytes: found.item.sizeBytes })))
      : [];
    const sessionAccess = toRun.length > 0 ? this.deps.sessions() : () => null;
    queue.setRunning(toRun.map(({ found }) => found.item.id), true);

    for (const [index, { decision, found }] of toRun.entries()) {
      const { item, request } = found;
      const action: RemovalAction = decision.action;
      try {
        const access = sessionAccess(request.sessionId);
        if (!access) {
          decide(item, request.sessionId, "refused", { action: null, message: `${request.sessionName}'s session was revoked, so DiskHound didn't act on its request.` });
          continue;
        }
        const needed: McpAgentCapability = action === "trash" ? "files.trash" : "files.delete";
        if (!access.capabilities.includes(needed)) {
          decide(item, request.sessionId, "refused", {
            action: null,
            message: `${access.name}'s role (${access.roleName}) no longer allows ${action === "trash" ? `moving items to the ${bin}` : "permanent deletes"}.`,
          });
          continue;
        }
        let now: string;
        try {
          now = await this.deps.canonicalPath(item.path);
        } catch {
          decide(item, request.sessionId, "gone", { action: null, message: "Already gone." });
          continue;
        }
        if (now !== item.path) {
          decide(item, request.sessionId, "refused", { action: null, message: "This path changed after the agent asked, so DiskHound left it alone." });
          continue;
        }
        const blocked = protection(item.path, item.path);
        if (blocked) {
          decide(item, request.sessionId, "refused", { action: null, message: /^Refused|^Protected/.test(blocked) ? blocked : `Refused: ${blocked}.` });
          continue;
        }
        const check = checks[index]!;
        if (!sameCheck(item.check, check)) {
          // What the user saw is no longer true. Show them the new facts.
          queue.updateCheck(item.id, check);
          queue.setRunning([item.id], false);
          result.changed++;
          continue;
        }
        const choice = removalChoice({ asked: item.asked, check }, access.capabilities, access.name, platform);
        if (!choice[action]) {
          decide(item, request.sessionId, "refused", { action: null, message: choice.locked ?? `DiskHound can't ${action === "trash" ? `move this to the ${bin}` : "delete this"}.` });
          continue;
        }
        await this.removeOne(item, request.sessionId, action, check, decide, action === "trash" ? trashed : deleted);
      } catch (error) {
        decide(item, request.sessionId, "failed", { action: null, message: error instanceof Error ? error.message : String(error) });
      }
    }
    queue.setRunning(toRun.map(({ found }) => found.item.id), false);
    result.sessions = sessions.size;
    return { result, trashed, deleted };
  }

  private async removeOne(
    item: RemovalItem,
    sessionId: string,
    action: RemovalAction,
    check: RemovalVolumeCheck,
    decide: (item: RemovalItem, sessionId: string, status: Exclude<RemovalItemStatus, "waiting" | "running">, outcome: Omit<RemovalOutcome, "at">) => void,
    removed: string[],
  ): Promise<void> {
    const { platform } = this.deps;
    const bin = trashName(platform);
    const remove = (path: string) => (action === "trash" ? this.deps.trashPath(path) : this.deps.deletePath(path));
    const done = action === "trash"
      ? item.asked === "delete" ? `Moved to the ${bin} instead of deleted, as you chose.` : `Moved to the ${bin}.`
      : "Deleted permanently.";

    if (check.mountsInside.length === 0) {
      const outcome = await remove(item.path);
      if (outcome.ok) {
        removed.push(item.path);
        decide(item, sessionId, action === "trash" ? "moved" : "deleted", { action, message: done });
      } else {
        decide(item, sessionId, "failed", { action: null, message: outcome.message });
      }
      return;
    }

    // Another volume is mounted inside: remove everything around it.
    const mounts = check.mountsInside.map((mount) => mount.path);
    const { units, holders } = await removalUnits(item.path, mounts, this.deps.listDir, platform);
    const labels = check.mountsInside.map((mount) => `${mountLabel(item.path, mount.path)} (${mount.volume})`).join(", ");
    const left = [...mounts, ...holders];
    if (units.length === 0) {
      decide(item, sessionId, "skipped", {
        action: null,
        message: `Nothing to remove: everything inside is another volume (${labels}), which DiskHound leaves alone.`,
        left,
      });
      return;
    }
    const failures: string[] = [];
    const failedUnits: string[] = [];
    let ok = 0;
    for (const unit of units) {
      const outcome = await remove(unit);
      if (outcome.ok) {
        ok++;
        removed.push(unit);
      } else {
        failedUnits.push(unit);
        failures.push(`${unit}: ${outcome.message}`);
      }
    }
    const verb = action === "trash" ? `Moved to the ${bin}` : "Deleted permanently";
    if (ok === 0) {
      decide(item, sessionId, "failed", { action: null, message: failures.slice(0, 3).join(" "), left });
      return;
    }
    decide(item, sessionId, "partial", {
      action,
      message: `${verb}, except ${labels}: another volume mounted inside, which DiskHound left alone.` +
        (failures.length > 0 ? ` ${failures.length} part${failures.length === 1 ? "" : "s"} didn't go: ${failures.slice(0, 3).join(" ")}` : ""),
      left: [...left, ...failedUnits],
    });
  }
}
