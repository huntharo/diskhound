import type { Dirent } from "node:fs";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

import type { DiagnosticsSessionKind } from "../shared/contracts";
import {
  parseSessionCreatedAt,
  sessionKindOf,
  SESSION_BOOKKEEPING_FILES,
  SESSION_MANIFEST_FILE,
  type DiagnosticsSessionManifest,
} from "./diagnosticsSession";

const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionLimits {
  maxSessions: number;
  maxTotalBytes: number;
  maxAgeMs: number;
}

/**
 * One gate snapshot pair at the 1.2 GB default is a few GB, so the byte
 * cap keeps about one pair; CPU profiles are ~1 MB each and only the
 * session count or age removes them.
 */
export const DEFAULT_RETENTION: RetentionLimits = {
  maxSessions: 12,
  maxTotalBytes: 6 * GIB,
  maxAgeMs: 30 * DAY_MS,
};

export interface SessionListing {
  name: string;
  kind: DiagnosticsSessionKind;
  path: string;
  createdAtMs: number;
  bytes: number;
  files: Array<{ name: string; bytes: number }>;
  manifest: DiagnosticsSessionManifest | null;
}

export type RemovalReason = "empty" | "age" | "count" | "bytes" | "cleared";

export interface PruneResult {
  removed: Array<{ name: string; bytes: number; reason: RemovalReason }>;
  /** Newest first. */
  kept: SessionListing[];
}

/**
 * Every session directory under `root`, newest first. Anything whose
 * name isn't a session's (heap-gate-state.json, a user's own files) is
 * left out, so retention never touches it.
 */
export async function listDiagnosticsSessions(root: string): Promise<SessionListing[]> {
  let names: string[];
  try {
    names = await FS.readdir(root);
  } catch {
    return [];
  }
  const sessions = await Promise.all(names.map((name) => readSession(root, name)));
  return sessions
    .filter((session): session is SessionListing => session !== null)
    .sort((left, right) => right.createdAtMs - left.createdAtMs || right.name.localeCompare(left.name));
}

async function readSession(root: string, name: string): Promise<SessionListing | null> {
  const kind = sessionKindOf(name);
  const createdAtMs = parseSessionCreatedAt(name);
  if (kind === null || createdAtMs === null) return null;
  const path = Path.join(root, name);
  let entries: Dirent[];
  try {
    entries = await FS.readdir(path, { withFileTypes: true });
  } catch {
    return null;
  }
  const files: SessionListing["files"] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      files.push({ name: entry.name, bytes: (await FS.stat(Path.join(path, entry.name))).size });
    } catch {
      // Gone since the readdir.
    }
  }
  let manifest: DiagnosticsSessionManifest | null = null;
  if (files.some((file) => file.name === SESSION_MANIFEST_FILE)) {
    try {
      manifest = JSON.parse(await FS.readFile(Path.join(path, SESSION_MANIFEST_FILE), "utf8")) as DiagnosticsSessionManifest;
    } catch {
      // A torn manifest still leaves the files listable.
    }
  }
  return {
    name,
    kind,
    path,
    createdAtMs,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
    manifest,
  };
}

/** A session with no capture: only session.json, samples or events. */
export function isEmptySession(session: SessionListing): boolean {
  return session.files.every((file) => SESSION_BOOKKEEPING_FILES.has(file.name));
}

/**
 * Deletes, in order: sessions with no capture, sessions older than
 * `maxAgeMs`, the oldest beyond `maxSessions`, then the oldest until
 * the rest fit in `maxTotalBytes`. `protect` names this launch's
 * sessions, which stay even when they alone exceed a cap.
 */
export async function pruneDiagnostics(
  root: string,
  options: { limits?: RetentionLimits; now?: number; protect?: ReadonlySet<string> } = {},
): Promise<PruneResult> {
  const limits = options.limits ?? DEFAULT_RETENTION;
  const now = options.now ?? Date.now();
  const protect = options.protect ?? new Set<string>();
  const removed: PruneResult["removed"] = [];
  const kept: SessionListing[] = [];

  const remove = async (session: SessionListing, reason: RemovalReason): Promise<boolean> => {
    try {
      await FS.rm(session.path, { recursive: true, force: true });
      removed.push({ name: session.name, bytes: session.bytes, reason });
      return true;
    } catch {
      return false;
    }
  };

  for (const session of await listDiagnosticsSessions(root)) {
    if (protect.has(session.name)) {
      kept.push(session);
    } else if (isEmptySession(session)) {
      if (!(await remove(session, "empty"))) kept.push(session);
    } else if (now - session.createdAtMs > limits.maxAgeMs) {
      if (!(await remove(session, "age"))) kept.push(session);
    } else {
      kept.push(session);
    }
  }

  const evictOldest = async (reason: RemovalReason, over: () => boolean): Promise<void> => {
    for (let index = kept.length - 1; index >= 0 && over(); index -= 1) {
      const session = kept[index];
      if (protect.has(session.name)) continue;
      if (await remove(session, reason)) kept.splice(index, 1);
    }
  };
  await evictOldest("count", () => kept.length > limits.maxSessions);
  await evictOldest("bytes", () => kept.reduce((sum, session) => sum + session.bytes, 0) > limits.maxTotalBytes);

  return { removed, kept };
}

/** Settings → Delete all. */
export async function clearDiagnostics(root: string): Promise<PruneResult> {
  const removed: PruneResult["removed"] = [];
  const kept: SessionListing[] = [];
  for (const session of await listDiagnosticsSessions(root)) {
    try {
      await FS.rm(session.path, { recursive: true, force: true });
      removed.push({ name: session.name, bytes: session.bytes, reason: "cleared" });
    } catch {
      kept.push(session);
    }
  }
  return { removed, kept };
}
