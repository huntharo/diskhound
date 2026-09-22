/**
 * Key for per-root scan state. Trailing slashes are trimmed so
 * `C:\Users\` and `C:\Users` match, but a scan of `/` must stay `/`.
 * Trimming that one down to "" made every Linux pill miss the running
 * scan, so the root pill never showed progress.
 */
export function rootKeyFor(rootPath: string | null | undefined, platform: string): string {
  if (!rootPath) return "";
  const trimmed = rootPath.replace(/[\\/]+$/, "");
  const key = trimmed || (rootPath.includes("\\") ? "\\" : "/");
  return platform === "win32" ? key.toLowerCase() : key;
}

/**
 * Drive pill that owns `path`. Longest mount wins, so a scan of
 * `/home/tom` lights `/home` and not `/`. A scan of `/` lights only `/`.
 * Windows drive letters use the same rule (`C:\Users` belongs to `C:\`).
 */
export function owningDrive(
  drives: readonly string[],
  path: string,
  platform: string,
): string | null {
  const pathKey = rootKeyFor(path, platform);
  if (!pathKey) return null;
  let best: { drive: string; key: string } | null = null;
  for (const drive of drives) {
    const key = rootKeyFor(drive, platform);
    if (!key) continue;
    const owns = key === "/" || key === "\\"
      ? pathKey === key || pathKey.startsWith(key)
      : pathKey === key || pathKey.startsWith(`${key}/`) || pathKey.startsWith(`${key}\\`);
    if (!owns) continue;
    if (!best || key.length > best.key.length) best = { drive, key };
  }
  return best?.drive ?? null;
}
