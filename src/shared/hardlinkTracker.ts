/**
 * Unix hardlink dedupe for the JS scan worker. Mirrors
 * `native/diskhound-native-scanner/src/hardlinks.rs`.
 *
 * A regular file with `nlink > 1` is one inode reached through several
 * names. A scan counts its bytes once: the first link the walk reaches
 * owns them, and every later link is indexed with `h:1` (the flag the
 * Windows MFT path writes), so it adds 0 to directory and total sizes.
 * This matches `du`, which also counts each inode once.
 *
 * "First" must be the same on every scan, or the full diff would show the
 * bytes moving between links. Both scanners therefore walk depth-first
 * and, inside each directory, visit files before subdirectories, each
 * group sorted by name bytes (`compareEntryNames`).
 *
 * Only multi-link inodes are tracked, and an inode is dropped once all of
 * its links have been seen.
 */

export interface LinkStat {
  dev: number | bigint;
  ino: number | bigint;
  nlink: number;
}

export class HardlinkTracker {
  /** `dev:ino` → links not seen yet. */
  private readonly pending = new Map<string, number>();
  private extraLinkCount = 0;

  /** True when this name is an extra link to an inode already counted. */
  isExtraLink(stat: LinkStat): boolean {
    if (stat.nlink <= 1) return false;
    const key = `${stat.dev}:${stat.ino}`;
    const remaining = this.pending.get(key);
    if (remaining === undefined) {
      this.pending.set(key, stat.nlink - 1);
      return false;
    }
    this.extraLinkCount += 1;
    if (remaining <= 1) this.pending.delete(key);
    else this.pending.set(key, remaining - 1);
    return true;
  }

  get extraLinks(): number {
    return this.extraLinkCount;
  }

  /** Hardlinked inodes with names the walk never reached (usually outside the root). */
  get inodesWithUnseenLinks(): number {
    return this.pending.size;
  }
}

/**
 * Name order inside one directory, by UTF-8 bytes to match Rust's
 * `OsStr` order. Plain `<` compares UTF-16 code units, which puts
 * astral-plane characters before U+E000–U+FFFF.
 */
export function compareEntryNames(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    const xSurrogate = x >= 0xd800 && x <= 0xdfff;
    const ySurrogate = y >= 0xd800 && y <= 0xdfff;
    if (xSurrogate !== ySurrogate) return xSurrogate ? 1 : -1;
    return x - y;
  }
  return a.length - b.length;
}
