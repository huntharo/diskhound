import type { Stats } from "node:fs";

/** POSIX `st_blocks` unit. Matches `du` and Unix DiskHound occupancy. */
export const POSIX_BLOCK_BYTES = 512;

/**
 * Bytes that actually occupy the volume.
 *
 * Unix: `stat.blocks * 512` (sparse holes and filesystem compression).
 * Windows Node `fs.stat` has no allocated-size field — callers that need
 * NTFS sparse/compressed occupancy have to go through the native scanner
 * or `GetCompressedFileSize`. This helper then falls back to logical size.
 */
export function occupancyBytes(stat: Stats): number {
  if (process.platform !== "win32") {
    const maybeBlocks = (stat as Stats & { blocks?: number }).blocks;
    if (typeof maybeBlocks === "number" && Number.isFinite(maybeBlocks)) {
      return Math.max(0, maybeBlocks * POSIX_BLOCK_BYTES);
    }
  }
  return Math.max(0, stat.size);
}
