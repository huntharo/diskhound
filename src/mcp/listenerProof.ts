import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

/** 32 bytes, same file the stdio helper reads before it sends a saved token. */
export const LISTENER_KEY_BYTES = 32;

/** 32 random bytes, base64url, no padding. The helper's `random()` is this shape. */
export const PROOF_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const PRIVATE_KEY = "DiskHound's listener key must stay private to your user.";

/**
 * Same place the helper's `dirs::data_local_dir()` uses, not Electron's
 * userData. Linux is `$XDG_DATA_HOME` or `~/.local/share`; macOS is
 * `~/Library/Application Support`; Windows is `%LOCALAPPDATA%`.
 */
export function listenerKeyPath(
  home = OS.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const api = platform === "win32" ? Path.win32 : Path.posix;
  const root = platform === "win32"
    ? env.LOCALAPPDATA || api.join(home, "AppData", "Local")
    : platform === "darwin"
      ? api.join(home, "Library", "Application Support")
      : env.XDG_DATA_HOME && api.isAbsolute(env.XDG_DATA_HOME)
        ? env.XDG_DATA_HOME
        : api.join(home, ".local", "share");
  return api.join(root, "DiskHound", "mcp-listener-key");
}

/** HMAC-SHA256 of the nonce, hex. The key itself never leaves the disk. */
export function listenerProof(key: Buffer, nonce: string): string {
  return createHmac("sha256", key).update(nonce, "utf8").digest("hex");
}

/**
 * Read the listener key, or create it on first enable. A key another
 * user can read is refused: chmod would not undo a copy they already took.
 */
export function ensureListenerKey(file: string): Buffer {
  const directory = Path.dirname(file);
  const created = !existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && created) chmodSync(directory, 0o700);
  assertPrivate(directory, "dir");

  if (existsSync(file)) {
    assertPrivate(file, "file");
    const key = readFileSync(file);
    if (key.length !== LISTENER_KEY_BYTES) throw new Error(PRIVATE_KEY);
    return key;
  }

  const key = randomBytes(LISTENER_KEY_BYTES);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, key, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  assertPrivate(file, "file");
  return key;
}

function assertPrivate(file: string, kind: "dir" | "file") {
  const info = lstatSync(file);
  if (info.isSymbolicLink()) throw new Error(PRIVATE_KEY);
  if (kind === "dir" ? !info.isDirectory() : !info.isFile()) throw new Error(PRIVATE_KEY);
  if (process.platform === "win32") return;
  const mode = info.mode & 0o777;
  const expected = kind === "dir" ? 0o700 : 0o600;
  if (mode !== expected || info.uid !== process.getuid?.()) throw new Error(PRIVATE_KEY);
}
