import * as Path from "node:path";

/** Normalize a path for comparison: strip trailing separators and only case-fold on Windows. */
export function normPath(p: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/** Drive-letter or backslash paths must use win32 dirname/basename on POSIX CI. */
export function pathLooksWindows(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.includes("\\");
}

export function dirnameOf(p: string): string {
  return pathLooksWindows(p) ? Path.win32.dirname(p) : Path.posix.dirname(p);
}

export function basenameOf(p: string): string {
  return pathLooksWindows(p) ? Path.win32.basename(p) : Path.posix.basename(p);
}

/**
 * Short label for the current scan root: `C:\` → `C:`, folder roots
 * keep their path. Used in tab chrome and empty states so a view is
 * never "the whole PC."
 */
export function formatScanRoot(rootPath: string): string {
  const trimmed = rootPath.replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(trimmed)) {
    return `${trimmed[0]!.toUpperCase()}:`;
  }
  if (trimmed === "" && /^[\\/]/.test(rootPath)) return "/";
  return trimmed || rootPath;
}
