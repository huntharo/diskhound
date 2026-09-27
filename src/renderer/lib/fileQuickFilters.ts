import { INSTALLER_EXTENSIONS, isVirtualMachineFile, VM_EXTENSIONS } from "../../shared/fileCategories";
import type { ExtensionBucket, ScanFileRecord } from "../../shared/contracts";

export type FileCategoryFilter =
  | "all"
  | "video"
  | "archives"
  | "installers"
  | "virtual-machines"
  | "images"
  | "audio"
  | "documents";

export type QuickFilter = FileCategoryFilter | "recent";

export type RecentWindow = "7d" | "30d" | "90d";

export const RECENT_WINDOWS: { id: RecentWindow; label: string; ms: number }[] = [
  { id: "7d", label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
  { id: "90d", label: "90 days", ms: 90 * 24 * 60 * 60 * 1000 },
];

export const FILE_CATEGORY_CHIPS: { id: FileCategoryFilter; label: string; title?: string }[] = [
  { id: "all", label: "All" },
  { id: "video", label: "Video" },
  { id: "archives", label: "Archives" },
  { id: "installers", label: "Installers", title: "Installer packages and ISO/DMG disk images — review before deleting" },
  { id: "virtual-machines", label: "Virtual machines", title: "VM disks, snapshots, bundles and exported appliances" },
  { id: "images", label: "Images" },
  { id: "audio", label: "Audio" },
  { id: "documents", label: "Docs" },
];

export const QUICK_FILTERS: { id: QuickFilter; label: string; title?: string }[] = [
  { id: "all", label: "All" },
  {
    id: "recent",
    label: "Recently large",
    title: "Files modified in the last N days, sorted by size — the things that recently took up the most space",
  },
  ...FILE_CATEGORY_CHIPS.filter((chip) => chip.id !== "all"),
];

export const FILTER_EXTS: Record<Exclude<FileCategoryFilter, "all">, Set<string>> = {
  video: new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm", ".wmv"]),
  archives: new Set([".7z", ".bz2", ".gz", ".rar", ".tar", ".xz", ".zip"]),
  installers: INSTALLER_EXTENSIONS,
  "virtual-machines": VM_EXTENSIONS,
  images: new Set([".gif", ".heic", ".jpeg", ".jpg", ".png", ".psd", ".raw", ".svg", ".webp"]),
  audio: new Set([".aac", ".flac", ".m4a", ".mp3", ".wav", ".wma"]),
  documents: new Set([".csv", ".doc", ".docx", ".pdf", ".ppt", ".pptx", ".txt", ".xls", ".xlsx"]),
};

export function matchesFileCategory(
  extension: string,
  category: FileCategoryFilter,
  path = "",
): boolean {
  if (category === "all") return true;
  const vm = isVirtualMachineFile(path, extension);
  if (category === "virtual-machines") return vm;
  if (vm) return false;
  return FILTER_EXTS[category].has(extension.toLowerCase());
}

export function fileMatchesCategory(
  file: Pick<ScanFileRecord, "extension"> & Partial<Pick<ScanFileRecord, "path">>,
  category: FileCategoryFilter,
): boolean {
  return matchesFileCategory(file.extension, category, file.path);
}

/** Extension breakdown of the already filtered overview, not all .img/.raw files. */
export function filteredExtensionBuckets(files: readonly Pick<ScanFileRecord, "extension" | "size">[]): ExtensionBucket[] {
  const buckets = new Map<string, ExtensionBucket>();
  for (const file of files) {
    const extension = file.extension.toLowerCase();
    let bucket = buckets.get(extension);
    if (!bucket) { bucket = { extension, size: 0, count: 0 }; buckets.set(extension, bucket); }
    bucket.size += file.size;
    bucket.count++;
  }
  return [...buckets.values()];
}

/** Scan-wide extension totals cannot express path-aware categories. Keep
 * their sampled replacement explicitly scoped so callers cannot imply
 * completeness when smaller files fall below the treemap loading cap. */
export function overviewExtensionInventory(
  scanTotals: ExtensionBucket[],
  filteredSample: readonly Pick<ScanFileRecord, "extension" | "size">[],
  category: FileCategoryFilter,
): { scope: "scan" | "sample"; buckets: ExtensionBucket[] } {
  return category === "all"
    ? { scope: "scan", buckets: scanTotals }
    : { scope: "sample", buckets: filteredExtensionBuckets(filteredSample) };
}
