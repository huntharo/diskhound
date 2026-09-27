import { IterableMapper } from "@shutterstock/p-map-iterable";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";

import type { PathActionResult, PermanentDeleteProgress } from "./contracts";

const PREFETCH_OPTIONS = { concurrency: 1, maxUnread: 100 };
const MAPPER_OPTIONS = { concurrency: 4, maxUnread: 100 };
const PROGRESS_MS = 150;

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function isEnoentFsError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

export function isAccessDeniedFsError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EACCES" || code === "EPERM";
}

async function removeEntry(path: string, directory: boolean): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      if (directory) await FSP.rmdir(path);
      else await FSP.unlink(path); // Includes symlinks and Windows junctions.
      return;
    } catch (error) {
      if (isEnoentFsError(error)) return;
      const code = errorCode(error);
      if (attempt >= 2) throw error;
      // Windows read-only attributes can block deletion. Never chmod a link
      // target, and never recursively remove a replacement directory.
      if (process.platform === "win32" && code === "EPERM") {
        try {
          const stat = await FSP.lstat(path);
          if (stat.isSymbolicLink()) throw error;
          await FSP.chmod(path, directory ? 0o777 : 0o666);
        } catch (fixError) {
          if (isEnoentFsError(fixError)) return;
          throw fixError;
        }
      } else if (!["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY"].includes(code ?? "")) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

type DirectoryFrame = {
  path: string;
  handle: Awaited<ReturnType<typeof FSP.opendir>> | null;
  pending: number;
  ready?: () => void;
};

type Removal = { path: string; directory: boolean; parent?: DirectoryFrame };

/**
 * Stream a depth-first traversal through a single four-worker mapper. Each
 * directory keeps a small opendir buffer, not an array of all its entries.
 * Parents become eligible in the source only after their children settle;
 * waiting parents never occupy mapper slots. Memory grows with depth + the
 * bounded input and result queues, not the number of entries in the tree.
 */
export async function permanentlyDeleteOnDisk(
  targetPath: string,
  onProgress?: (progress: PermanentDeleteProgress) => void,
  expectedFiles?: number,
): Promise<void> {
  const resolved = Path.resolve(targetPath);
  const estimate = typeof expectedFiles === "number" && Number.isSafeInteger(expectedFiles) && expectedFiles > 0
    ? expectedFiles : null;
  let itemsDeleted = 0;
  let filesDeleted = 0;
  let failed = false;
  let firstError: unknown;
  const fail = (error: unknown) => {
    if (!failed) firstError = error;
    failed = true;
  };
  const emit = (path: string, percent: number | null, phase: "preparing" | "deleting", complete = false) => onProgress?.({
    rootPath: resolved, path, phase, itemsDeleted, itemsTotal: complete ? itemsDeleted : null, percent,
  });
  emit(resolved, null, "preparing");

  async function openDirectory(path: string): Promise<DirectoryFrame | "file" | null> {
    try {
      // Recheck directory entries before descending; do not follow directory
      // symlinks or junctions. This does not promise path-race containment.
      const stat = await FSP.lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return "file";
      return { path, handle: await FSP.opendir(path, { bufferSize: 32 }), pending: 0 };
    } catch (error) {
      if (isEnoentFsError(error)) return null;
      throw error;
    }
  }

  async function close(frame: DirectoryFrame): Promise<void> {
    const handle = frame.handle;
    frame.handle = null;
    if (handle) await handle.close();
  }

  async function* source(): AsyncGenerator<Removal> {
    const stack: DirectoryFrame[] = [];
    try {
      const root = await openDirectory(resolved);
      if (root === null) return;
      if (root === "file") {
        yield { path: resolved, directory: false };
        return;
      }
      stack.push(root);
      while (stack.length > 0 && !failed) {
        const frame = stack[stack.length - 1]!;
        let entry;
        try {
          entry = await frame.handle!.read();
        } catch (error) {
          if (!isEnoentFsError(error)) throw error;
          entry = null;
        }
        if (failed) break;
        if (entry) {
          const path = Path.join(frame.path, entry.name);
          if (entry.isDirectory() && !entry.isSymbolicLink()) {
            const child = await openDirectory(path);
            if (child === null) continue;
            if (child !== "file") {
              frame.pending++;
              stack.push(child);
              continue;
            }
          }
          frame.pending++;
          yield { path, directory: false, parent: frame };
        } else {
          await close(frame);
          if (frame.pending > 0 && !failed) {
            await new Promise<void>((resolve) => { frame.ready = resolve; });
          }
          if (failed) break;
          stack.pop();
          yield { path: frame.path, directory: true, parent: stack[stack.length - 1] };
        }
      }
    } catch (error) {
      // Do not let the async input throw: the library can otherwise reject
      // before active mappers settle. Finish the source and drain results.
      fail(error);
    } finally {
      while (stack.length > 0) {
        try { await close(stack.pop()!); } catch (error) { fail(error); }
      }
    }
  }

  let lastTenth = 0;
  let lastEmitAt = Date.now();
  emit(resolved, estimate === null ? null : 0, "deleting");
  // Separate enumeration from removal so a directory read does not occupy a
  // deletion runner. The identity mapper prefetches at most 100 pending jobs;
  // the deletion mapper independently buffers up to 100 completed results.
  const prefetched = new IterableMapper(source(), (entry) => entry, PREFETCH_OPTIONS);
  const completed = new IterableMapper(prefetched, async (entry) => {
    try {
      if (failed) return null;
      await removeEntry(entry.path, entry.directory);
      return entry;
    } catch (error) {
      fail(error);
      return null;
    } finally {
      const parent = entry.parent;
      if (parent && --parent.pending === 0) parent.ready?.();
    }
  }, MAPPER_OPTIONS);
  for await (const entry of completed) {
    if (entry === null) continue;
    itemsDeleted++;
    if (!entry.directory) filesDeleted++;
    // A scan count may be stale. Keep the estimate monotone, cap it below 100,
    // and never pretend the number of entries seen so far is a fixed total.
    const tenth = estimate === null ? null : Math.min(999, Math.floor(filesDeleted * 1000 / estimate));
    const now = Date.now();
    if (now - lastEmitAt < PROGRESS_MS || (tenth !== null && tenth <= lastTenth)) continue;
    lastTenth = tenth ?? 0;
    lastEmitAt = now;
    try { emit(entry.path, tenth === null ? null : tenth / 10, "deleting"); } catch (error) { fail(error); }
  }
  if (failed) throw firstError;

  try {
    await FSP.lstat(resolved);
  } catch (error) {
    if (!isEnoentFsError(error)) throw error;
    emit(resolved, 100, "deleting", true);
    return;
  }
  throw new Error("The path is still on disk after permanent delete.");
}

export function classifyPermanentDeleteError(
  error: unknown,
  alreadyElevated: boolean,
  targetPath: string,
): PathActionResult {
  const name = Path.basename(targetPath);
  if (process.platform === "win32" && !alreadyElevated && isAccessDeniedFsError(error)) {
    return {
      ok: false,
      requiresElevation: true,
      message:
        `${name} may require admin rights. ` +
        `Retry with admin — DiskHound will permanently delete it (not Recycle Bin).`,
    };
  }
  return {
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function tryPermanentDelete(
  targetPath: string,
  alreadyElevated: boolean,
  onProgress?: (progress: PermanentDeleteProgress) => void,
): Promise<PathActionResult> {
  try {
    await permanentlyDeleteOnDisk(targetPath, onProgress);
    return { ok: true, message: "Permanently deleted." };
  } catch (error) {
    return classifyPermanentDeleteError(error, alreadyElevated, targetPath);
  }
}
