import * as FS from "node:fs/promises";
import * as Path from "node:path";

/**
 * Extra checks for paths an agent asks to move to the Trash. The user's
 * Protected Folders check compares strings, which was fine while paths
 * came from scan data; an agent can type any spelling it likes
 * (`/users/me/photos`, a symlink, `C:\PROGRA~1`), so resolve each path
 * to the one on disk first, then refuse folders no cleanup should
 * remove even with the user's click.
 */

/**
 * The on-disk spelling of `target`: symlinks in its parent folders
 * resolved, true letter case on macOS and Windows, long names instead
 * of 8.3 ones. A symlink itself is kept (trashing it moves the link,
 * not what it points to), but its name is re-cased from the directory
 * listing. Throws if nothing exists at `target`.
 */
export async function canonicalPath(target: string): Promise<string> {
  const stat = await FS.lstat(target);
  if (!stat.isSymbolicLink()) return FS.realpath(target);
  const parent = await FS.realpath(Path.dirname(target));
  const name = Path.basename(target);
  const entries = await FS.readdir(parent);
  const onDisk = entries.includes(name) ? name : entries.find((entry) => entry.toLowerCase() === name.toLowerCase());
  return Path.join(parent, onDisk ?? name);
}

function key(path: string, platform: NodeJS.Platform): string {
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
  // APFS and NTFS are case-insensitive by default.
  return platform === "win32" || platform === "darwin" ? trimmed.toLowerCase() : trimmed;
}

/** `candidate` is `folder` or inside it. */
function within(folder: string, candidate: string, platform: NodeJS.Platform): boolean {
  const f = key(folder, platform);
  const c = key(candidate, platform);
  const sep = platform === "win32" ? "\\" : "/";
  return c === f || c.startsWith(f.endsWith(sep) ? f : f + sep);
}

/**
 * Why an agent may not trash `target` (already canonical), or null.
 * Refuses drive roots, network and device paths, and anything that is
 * or contains one of `keep`: the home folder, its standard folders,
 * DiskHound's own data and install folder.
 */
export function agentTrashRefusal(
  target: string,
  keep: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  const api = platform === "win32" ? Path.win32 : Path.posix;
  if (platform === "win32" && /^[\\/]{2}/.test(target)) return "network and device paths can't be moved by agents";
  if (api.dirname(target) === target) return "it is a drive root";
  const folder = keep.find((candidate) => within(target, candidate, platform));
  if (!folder) return null;
  return key(folder, platform) === key(target, platform)
    ? "DiskHound never lets agents move this folder"
    : `it contains ${folder}`;
}

/** Drop paths that sit inside another requested path; the outer one covers them. */
export function outermostPaths(paths: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const unique = [...new Map(paths.map((path) => [key(path, platform), path])).values()];
  return unique.filter((path) => !unique.some((other) => other !== path && within(other, path, platform)));
}
