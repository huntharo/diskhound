/** Normalize a path for comparison: strip trailing separators and only case-fold on Windows. */
export function normPath(p: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/** Drive-letter or backslash paths must use win32 dirname/basename on POSIX CI. */
export function pathLooksWindows(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.includes("\\");
}

function lastSepIndex(p: string): number {
  return Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
}

/** Host-independent dirname. Matches Path.win32 / Path.posix for scan paths. */
export function dirnameOf(p: string): string {
  if (pathLooksWindows(p)) {
    const trimmed = p.replace(/[\\/]+$/, "");
    if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\`;
    const idx = lastSepIndex(trimmed);
    if (idx < 0) return ".";
    const parent = trimmed.slice(0, idx);
    if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
    if (parent === "") return "\\";
    return parent;
  }
  const trimmed = p.replace(/\/+$/, "");
  if (trimmed === "") return "/";
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) return ".";
  if (idx === 0) return "/";
  return trimmed.slice(0, idx);
}

export function basenameOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  if (trimmed === "") return "";
  const idx = lastSepIndex(trimmed);
  if (idx < 0) return trimmed;
  if (/^[A-Za-z]:$/.test(trimmed.slice(0, idx))) return trimmed.slice(idx + 1);
  return trimmed.slice(idx + 1);
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
