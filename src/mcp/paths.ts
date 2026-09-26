import * as OS from "node:os";
import * as Path from "node:path";

import { normPath } from "../shared/pathUtils";

/**
 * Whether `candidate` is `root` or inside it. Case-insensitive on
 * Windows (via normPath); separator-aware so `/Users/a` does not
 * contain `/Users/ab`.
 */
export function isInside(root: string, candidate: string): boolean {
  const r = normPath(root);
  const c = normPath(candidate);
  // normPath strips trailing separators, so a POSIX "/" root becomes "".
  if (r === "") return c === "" || c.startsWith("/");
  return c === r || c.startsWith(`${r}/`) || c.startsWith(`${r}\\`);
}

/**
 * The absolute path an agent meant. `~` expands to the home folder, and
 * a bare drive letter ("C:", which diskhound_status reports on Windows)
 * becomes that drive's root. Anything else relative is refused: it
 * would resolve against DiskHound's working directory (on Windows,
 * `Path.resolve("C:")` is that directory, not the drive).
 */
export function agentPath(input: string, platform: NodeJS.Platform = process.platform, home = OS.homedir()): string {
  const api = platform === "win32" ? Path.win32 : Path.posix;
  let value = input.trim();
  if (value === "~" || value.startsWith("~/") || (platform === "win32" && value.startsWith("~\\"))) {
    value = api.join(home, value.slice(1));
  }
  if (platform === "win32") {
    if (/^[A-Za-z]:$/.test(value)) value = `${value}\\`;
    // "\\foo" is absolute to Path.win32 but means "on the current drive".
    if (!/^[A-Za-z]:[\\/]/.test(value) && !/^[\\/]{2}[^\\/]/.test(value)) {
      throw new Error(`Use an absolute path such as C:\\Users (got "${input}").`);
    }
  } else if (!api.isAbsolute(value)) {
    throw new Error(`Use an absolute path such as /Users (got "${input}").`);
  }
  return api.resolve(value);
}
