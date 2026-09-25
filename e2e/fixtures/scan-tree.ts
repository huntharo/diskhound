import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ScanTreeFile = {
  /** Relative to the tree root, "/"-separated. */
  path: string;
  name: string;
  bytes: number;
};

export type ScanTree = {
  root: string;
  /** Largest first, the order the Largest Files tab lists them. */
  files: readonly ScanTreeFile[];
  totalBytes: number;
  /** Top-level folders. */
  folders: readonly string[];
};

const KiB = 1024;

// Whole multiples of 4 KiB, so on 4 KiB-cluster file systems (APFS,
// ext4, NTFS) the allocated size the scanner reports equals the
// logical size. Sizes are distinct, so the ranking is unambiguous.
const FILES: readonly Omit<ScanTreeFile, "name">[] = [
  { path: "videos/holiday.mp4", bytes: 1536 * KiB },
  { path: "archive.zip", bytes: 1024 * KiB },
  { path: "videos/clip.mov", bytes: 768 * KiB },
  { path: "docs/report.pdf", bytes: 512 * KiB },
  { path: "docs/notes.txt", bytes: 16 * KiB },
];

/**
 * Write the standard tree under `root`. Random bytes, so file-system
 * compression or dedup cannot shrink what the scanner measures.
 */
export function writeScanTree(root: string): ScanTree {
  const files = FILES.map((file) => ({
    ...file,
    name: file.path.split("/").pop()!,
  }));
  for (const file of files) {
    const target = join(root, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, randomBytes(file.bytes));
  }
  return {
    root,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    folders: ["videos", "docs"],
  };
}
