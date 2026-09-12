/**
 * Bytes to show while a tree is still deleting.
 * Use the report occupancy — walked extra-hardlink files are 0 and
 * would freeze the banner at 0 B.
 */
export function inFlightDeleteBytes(completedBytes: number, currentTreeSize: number): number {
  return Math.max(0, completedBytes) + Math.max(0, currentTreeSize);
}
