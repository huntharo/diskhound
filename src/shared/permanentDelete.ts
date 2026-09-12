import * as FSP from "node:fs/promises";
import * as Path from "node:path";

import type { PathActionResult } from "./contracts";

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

/**
 * Permanently remove a file, directory, or junction. Never Recycle Bin.
 * Symlinks and Windows junctions are unlinked without walking the target.
 * Missing paths are success — the tree is already gone.
 */
export async function permanentlyDeleteOnDisk(targetPath: string): Promise<void> {
  const resolved = Path.resolve(targetPath);
  let stat;
  try {
    stat = await FSP.lstat(resolved);
  } catch (error) {
    if (isEnoentFsError(error)) return;
    throw error;
  }

  if (stat.isSymbolicLink()) {
    try {
      await FSP.unlink(resolved);
    } catch (error) {
      // Directory junctions on Windows sometimes reject unlink and want rmdir.
      if (stat.isDirectory()) {
        await FSP.rmdir(resolved);
      } else {
        throw error;
      }
    }
  } else if (stat.isDirectory()) {
    await FSP.rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 2,
    });
  } else {
    await FSP.unlink(resolved);
  }

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
): Promise<PathActionResult> {
  try {
    await permanentlyDeleteOnDisk(targetPath);
    return { ok: true, message: "Permanently deleted." };
  } catch (error) {
    return classifyPermanentDeleteError(error, alreadyElevated, targetPath);
  }
}
