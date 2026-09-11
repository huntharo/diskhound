/** Normalize a path for comparison: strip trailing separators and only case-fold on Windows. */
export function normPath(p: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
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
