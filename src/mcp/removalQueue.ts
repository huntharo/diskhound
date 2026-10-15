import { randomUUID } from "node:crypto";
import * as FS from "node:fs";

import {
  sameVolumeFacts,
  type AgentRemovalList,
  type RemovalAction,
  type RemovalItem,
  type RemovalItemStatus,
  type RemovalOutcome,
  type RemovalRequest,
  type RemovalVolumeCheck,
} from "../shared/agentRemovals";

/**
 * The review list: what agents asked DiskHound to move to the Trash or
 * delete, waiting for the user, and what the user decided.
 *
 * Kept in `agent-removals.json` in userData so a request outlives the
 * agent's connection and a restart. It is written only when something
 * changes (a request arrives, the user decides, a re-check finds a
 * volume changed), debounced so a burst of requests is one write, and
 * flushed at quit. Writes are synchronous: quit flushes from Electron's
 * synchronous before-quit, where an async write could be cut off, and
 * the file stays small. An approval holds writes until it finishes, so it
 * costs one write however many items it runs. Decided requests stay a
 * week so agents can read what happened, then drop out at the next
 * write. See removalQueue.ioBudget.test.ts for the counts.
 */

export const REMOVALS_PROTOCOL = "diskhound.agent-removals/v1" as const;
const FILE_VERSION = 1;
/** Waiting items across every request; past this, agents are told to let the user catch up. */
export const MAX_WAITING_ITEMS = 500;
const KEEP_DECIDED_MS = 7 * 24 * 60 * 60_000;
const MAX_DECIDED_REQUESTS = 50;
const DEBOUNCE_MS = 500;

const STATUSES: readonly RemovalItemStatus[] = ["waiting", "moved", "deleted", "partial", "skipped", "failed", "gone", "refused"];

interface RemovalsFile {
  protocol: typeof REMOVALS_PROTOCOL;
  version: typeof FILE_VERSION;
  requests: RemovalRequest[];
}

export interface QueueInput {
  sessionId: string;
  sessionName: string;
  roleName: string;
  asked: RemovalAction;
  reason: string | null;
  /** `fileId`: what is at the path now (trashGuard's fileIdentity). */
  items: { path: string; sizeBytes: number | null; check: RemovalVolumeCheck; fileId?: string }[];
}

export class RemovalQueueFullError extends Error {}

const isAction = (value: unknown): value is RemovalAction => value === "trash" || value === "delete";
const isText = (value: unknown, max = 8192): value is string => typeof value === "string" && value.length <= max;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isSize = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);

function parseCheck(value: unknown): RemovalVolumeCheck | null {
  if (!value || typeof value !== "object") return null;
  const check = value as Partial<RemovalVolumeCheck>;
  if (
    !(check.volume === null || isText(check.volume, 4096)) ||
    !(check.trash === "yes" || check.trash === "no" || check.trash === "unknown") ||
    !(check.trashWhy === undefined || isText(check.trashWhy, 1000)) ||
    typeof check.readOnly !== "boolean" ||
    !Array.isArray(check.mountsInside) ||
    !check.mountsInside.every((mount) => mount && isText(mount.path, 4096) && isText(mount.volume, 4096)) ||
    !(check.volumesUnknown === undefined || typeof check.volumesUnknown === "boolean") ||
    !isTime(check.checkedAt)
  ) {
    return null;
  }
  return check as RemovalVolumeCheck;
}

function parseItem(value: unknown): RemovalItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<RemovalItem>;
  const check = parseCheck(item.check);
  if (
    !isText(item.id, 64) || !isText(item.path, 4096) || !isAction(item.asked) || !isSize(item.sizeBytes) ||
    !check || !STATUSES.includes(item.status as RemovalItemStatus) || !(item.fileId === undefined || isText(item.fileId, 100))
  ) {
    return null;
  }
  const outcome = item.outcome as Partial<RemovalOutcome> | undefined;
  if (outcome !== undefined && (
    !outcome || !(outcome.action === null || isAction(outcome.action)) || !isText(outcome.message, 4000) || !isTime(outcome.at) ||
    !(outcome.left === undefined || (Array.isArray(outcome.left) && outcome.left.every((path) => isText(path, 4096))))
  )) {
    return null;
  }
  return { ...(item as RemovalItem), check };
}

function parseRequest(value: unknown): RemovalRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Partial<RemovalRequest>;
  if (
    !isText(request.id, 64) || !isText(request.sessionId, 200) || !isText(request.sessionName, 200) ||
    !isText(request.roleName, 200) || !isAction(request.asked) || !(request.reason === null || isText(request.reason, 1000)) ||
    !isTime(request.requestedAt) || !(request.decidedAt === null || isTime(request.decidedAt)) || !Array.isArray(request.items)
  ) {
    return null;
  }
  const items = request.items.map(parseItem).filter((item): item is RemovalItem => item !== null);
  return items.length > 0 ? { ...(request as RemovalRequest), items } : null;
}

const copyRequest = (request: RemovalRequest): RemovalRequest => ({
  ...request,
  items: request.items.map((item) => ({
    ...item,
    check: { ...item.check, mountsInside: item.check.mountsInside.map((mount) => ({ ...mount })) },
    ...(item.outcome ? { outcome: { ...item.outcome, ...(item.outcome.left ? { left: [...item.outcome.left] } : {}) } } : {}),
  })),
});

export class RemovalQueue {
  private requests: RemovalRequest[] | null = null;
  /** Item id → its request and item, so deciding an item is O(1). */
  private readonly index = new Map<string, { request: RemovalRequest; item: RemovalItem }>();
  /** Waiting items by session and path, so a re-ask finds its earlier item in O(1). */
  private readonly waitingByPath = new Map<string, string>();
  /** Items being removed right now. Never written: a restart puts them back to waiting. */
  private readonly running = new Set<string>();
  private dirty = false;
  private holds = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly filePath: string,
    private readonly options: {
      now?: () => number;
      debounceMs?: number;
      /** Paths compare case-insensitively on macOS and Windows. */
      platform?: NodeJS.Platform;
      /** Something about the list changed (in memory); push it to the window. */
      onChange?: () => void;
      log?: (message: string) => void;
      maxWaitingItems?: number;
    } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private key(path: string): string {
    const platform = this.options.platform ?? process.platform;
    return platform === "win32" || platform === "darwin" ? path.toLowerCase() : path;
  }

  /** Read the file the first time anything asks. */
  private load(): RemovalRequest[] {
    if (this.requests) return this.requests;
    let requests: RemovalRequest[] = [];
    try {
      const file = JSON.parse(FS.readFileSync(this.filePath, "utf8")) as Partial<RemovalsFile>;
      if (file?.protocol !== REMOVALS_PROTOCOL || file.version !== FILE_VERSION || !Array.isArray(file.requests)) {
        throw new Error("unknown format");
      }
      requests = file.requests.map(parseRequest).filter((request): request is RemovalRequest => request !== null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Keep the file as it is until something changes; the next write replaces it.
        this.options.log?.(`couldn't read ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.requests = requests;
    this.reindex();
    return requests;
  }

  private reindex(): void {
    this.index.clear();
    this.waitingByPath.clear();
    for (const request of this.requests ?? []) {
      for (const item of request.items) this.indexItem(request, item);
    }
  }

  private pathKey(sessionId: string, path: string): string {
    return `${sessionId}\0${this.key(path)}`;
  }

  private indexItem(request: RemovalRequest, item: RemovalItem): void {
    this.index.set(item.id, { request, item });
    if (item.status === "waiting") this.waitingByPath.set(this.pathKey(request.sessionId, item.path), item.id);
  }

  /** Whether the file has been read (it is read on first use only). */
  get loaded(): boolean {
    return this.requests !== null;
  }

  list(): AgentRemovalList {
    const requests = this.load().map(copyRequest);
    for (const request of requests) {
      for (const item of request.items) {
        if (this.running.has(item.id)) item.status = "running";
      }
    }
    return { requests, running: this.running.size > 0 };
  }

  /** Requests of one session, oldest first. */
  forSession(sessionId: string): RemovalRequest[] {
    return this.list().requests.filter((request) => request.sessionId === sessionId);
  }

  waitingCount(): number {
    this.load();
    return this.waitingByPath.size;
  }

  /** A copy of one item and its request (without the request's other items). */
  find(itemId: string): { request: RemovalRequest; item: RemovalItem } | null {
    this.load();
    const found = this.index.get(itemId);
    if (!found) return null;
    const [item] = copyRequest({ ...found.request, items: [found.item] }).items;
    return { request: { ...found.request, items: [] }, item: item! };
  }

  /**
   * Add one agent request. The same session asking again for a path
   * that is still waiting moves it to this request (its newer reason
   * and action win) rather than listing it twice. Asking again for
   * exactly a waiting request changes nothing, so an agent repeating
   * itself costs no write.
   */
  add(input: QueueInput): { request: RemovalRequest; replaced: number } {
    this.load();
    const again = new Set<string>();
    for (const item of input.items) {
      const id = this.waitingByPath.get(this.pathKey(input.sessionId, item.path));
      if (id) again.add(id);
    }
    const repeated = this.repeatOf(input, again);
    if (repeated) return { request: copyRequest(repeated), replaced: again.size };
    const waiting = this.waitingByPath.size - again.size;
    const max = this.options.maxWaitingItems ?? MAX_WAITING_ITEMS;
    if (waiting + input.items.length > max) {
      throw new RemovalQueueFullError(
        `DiskHound's review list already has ${waiting} items waiting, and holds at most ${max}. Ask the user to review the list in DiskHound before adding more.`,
      );
    }
    // Take the re-asked items out of their earlier requests.
    const emptied = new Set<RemovalRequest>();
    for (const id of again) {
      const found = this.index.get(id)!;
      found.request.items = found.request.items.filter((item) => item.id !== id);
      this.index.delete(id);
      this.waitingByPath.delete(this.pathKey(found.request.sessionId, found.item.path));
      if (found.request.items.length === 0) {
        emptied.add(found.request);
      } else if (found.request.decidedAt === null && found.request.items.every((item) => item.status !== "waiting")) {
        // Its last waiting item moved here, so it is decided, and pruned in time like any other.
        found.request.decidedAt = Math.max(...found.request.items.map((item) => item.outcome?.at ?? 0));
      }
    }
    if (emptied.size > 0) this.requests = this.requests!.filter((request) => !emptied.has(request));
    const request: RemovalRequest = {
      id: `rq_${randomUUID()}`,
      sessionId: input.sessionId,
      sessionName: input.sessionName,
      roleName: input.roleName,
      asked: input.asked,
      reason: input.reason,
      requestedAt: this.now(),
      decidedAt: null,
      items: input.items.map((item) => ({
        id: `it_${randomUUID()}`,
        path: item.path,
        asked: input.asked,
        sizeBytes: item.sizeBytes,
        check: item.check,
        ...(item.fileId === undefined ? {} : { fileId: item.fileId }),
        status: "waiting",
      })),
    };
    this.requests!.push(request);
    for (const item of request.items) this.indexItem(request, item);
    this.changed();
    return { request: copyRequest(request), replaced: again.size };
  }

  /**
   * The waiting request `input` repeats exactly, if any: same items,
   * action and reason, and the same volume facts and file at each path.
   * Anything new replaces it, so the list never keeps stale facts.
   */
  private repeatOf(input: QueueInput, again: ReadonlySet<string>): RemovalRequest | null {
    if (again.size === 0 || again.size !== input.items.length) return null;
    const [first] = again;
    const request = this.index.get(first!)!.request;
    const same = request.items.length === again.size &&
      request.items.every((item) => item.status === "waiting" && again.has(item.id)) &&
      request.asked === input.asked && request.reason === input.reason;
    if (!same) return null;
    const stored = new Map(request.items.map((item) => [this.key(item.path), item]));
    const unchanged = input.items.every((item) => {
      const was = stored.get(this.key(item.path));
      return was !== undefined && was.fileId === item.fileId && sameVolumeFacts(was.check, item.check);
    });
    return unchanged ? request : null;
  }

  /** Mark items as being removed (or not). In memory only. */
  setRunning(itemIds: readonly string[], running: boolean): void {
    for (const id of itemIds) {
      if (running) this.running.add(id);
      else this.running.delete(id);
    }
    this.options.onChange?.();
  }

  /** A re-check found the item's volume changed: the user reviews it again. */
  updateCheck(itemId: string, check: RemovalVolumeCheck): void {
    this.load();
    const item = this.index.get(itemId)?.item;
    if (!item || item.status !== "waiting") return;
    item.check = check;
    this.changed();
  }

  decide(itemId: string, status: Exclude<RemovalItemStatus, "waiting" | "running">, outcome: RemovalOutcome): void {
    this.load();
    const found = this.index.get(itemId);
    if (!found || found.item.status !== "waiting") return;
    found.item.status = status;
    found.item.outcome = outcome;
    this.waitingByPath.delete(this.pathKey(found.request.sessionId, found.item.path));
    this.running.delete(itemId);
    // A request holds at most 20 items, so this stays cheap.
    if (found.request.items.every((candidate) => candidate.status !== "waiting")) found.request.decidedAt = outcome.at;
    this.changed();
  }

  /**
   * Run `work` with writes held, then write once if anything changed.
   * An approval decides many items; this keeps it to one write.
   */
  async batch<T>(work: () => Promise<T>): Promise<T> {
    this.holds++;
    try {
      return await work();
    } finally {
      this.holds--;
      if (this.holds === 0 && this.dirty) await this.flush();
    }
  }

  /** Write now if anything changed. */
  async flush(): Promise<void> {
    this.flushSync();
  }

  /**
   * Write now if anything changed, before returning. Quit calls this
   * from Electron's synchronous before-quit. The file is under 500 KB
   * with a busy week of history, a few milliseconds to write.
   */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty || !this.requests) return;
    this.dirty = false;
    this.prune();
    const file: RemovalsFile = { protocol: REMOVALS_PROTOCOL, version: FILE_VERSION, requests: this.requests };
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      FS.writeFileSync(temporary, `${JSON.stringify(file)}\n`, { encoding: "utf8", mode: 0o600 });
      FS.renameSync(temporary, this.filePath);
    } catch (error) {
      this.dirty = true;
      this.options.log?.(`couldn't write ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  dispose(): Promise<void> {
    return this.flush();
  }

  private changed(): void {
    this.dirty = true;
    this.options.onChange?.();
    if (this.holds > 0 || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.debounceMs ?? DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** Drop decided requests older than a week, and all but the newest 50. */
  private prune(): void {
    if (!this.requests) return;
    const cutoff = this.now() - KEEP_DECIDED_MS;
    const decided = this.requests
      .filter((request) => request.decidedAt !== null)
      .sort((a, b) => b.decidedAt! - a.decidedAt!);
    const keep = new Set(decided.filter((request) => request.decidedAt! >= cutoff).slice(0, MAX_DECIDED_REQUESTS));
    this.requests = this.requests.filter((request) => request.decidedAt === null || keep.has(request));
    this.reindex();
  }
}
