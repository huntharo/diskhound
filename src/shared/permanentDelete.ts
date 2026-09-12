import * as FSP from "node:fs/promises";
import * as Path from "node:path";

import type { PathActionResult, PermanentDeleteProgress } from "./contracts";

const PROGRESS_MS = 150;
const YIELD_EVERY = 32;

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

type WalkState = {
  rootPath: string;
  filesWalked: number;
  lastEmitAt: number;
  sinceYield: number;
  onProgress?: (progress: PermanentDeleteProgress) => void;
};

function emit(state: WalkState, path: string, force: boolean): void {
  const now = Date.now();
  if (!force && now - state.lastEmitAt < PROGRESS_MS) return;
  state.lastEmitAt = now;
  state.onProgress?.({
    rootPath: state.rootPath,
    path,
    filesWalked: state.filesWalked,
  });
}

async function yieldToEventLoop(state: WalkState): Promise<void> {
  state.sinceYield += 1;
  if (state.sinceYield < YIELD_EVERY) return;
  state.sinceYield = 0;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function unlinkLink(targetPath: string, isDirectory: boolean): Promise<void> {
  try {
    await FSP.unlink(targetPath);
  } catch (error) {
    if (isEnoentFsError(error)) return;
    // Directory junctions on Windows sometimes reject unlink and want rmdir.
    if (isDirectory) {
      await FSP.rmdir(targetPath);
      return;
    }
    throw error;
  }
}

async function unlinkForced(targetPath: string, directory: boolean): Promise<void> {
  try {
    if (directory) await FSP.rmdir(targetPath);
    else await FSP.unlink(targetPath);
  } catch (error) {
    if (isEnoentFsError(error)) return;
    if (isAccessDeniedFsError(error)) {
      await FSP.chmod(targetPath, 0o666).catch(() => {});
      if (directory) await FSP.rmdir(targetPath);
      else await FSP.unlink(targetPath);
      return;
    }
    throw error;
  }
}

async function removeNode(targetPath: string, state: WalkState): Promise<void> {
  let stat;
  try {
    stat = await FSP.lstat(targetPath);
  } catch (error) {
    if (isEnoentFsError(error)) return;
    throw error;
  }

  state.filesWalked += 1;
  emit(state, targetPath, state.filesWalked === 1);
  await yieldToEventLoop(state);

  if (stat.isSymbolicLink()) {
    await unlinkLink(targetPath, stat.isDirectory());
    return;
  }
  if (stat.isDirectory()) {
    let names: string[];
    try {
      names = await FSP.readdir(targetPath);
    } catch (error) {
      if (isEnoentFsError(error)) return;
      throw error;
    }
    for (const name of names) {
      await removeNode(Path.join(targetPath, name), state);
    }
    await unlinkForced(targetPath, true);
    return;
  }
  await unlinkForced(targetPath, false);
}

/**
 * Permanently remove a file, directory, or junction. Never Recycle Bin.
 * Walks the tree so callers can tick progress. Symlinks and Windows
 * junctions are unlinked without walking the target. Missing paths
 * are success — the tree is already gone.
 */
export async function permanentlyDeleteOnDisk(
  targetPath: string,
  onProgress?: (progress: PermanentDeleteProgress) => void,
): Promise<void> {
  const resolved = Path.resolve(targetPath);
  const state: WalkState = {
    rootPath: resolved,
    filesWalked: 0,
    lastEmitAt: 0,
    sinceYield: 0,
    onProgress,
  };
  emit(state, resolved, true);
  await removeNode(resolved, state);
  emit(state, resolved, true);

  try {
    await FSP.lstat(resolved);
  } catch (error) {
    if (isEnoentFsError(error)) return;
    throw error;
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
