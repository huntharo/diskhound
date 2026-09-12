import type { ScanFileRecord } from "../../shared/contracts";

export type FileCategoryFilter =
  | "all"
  | "video"
  | "archives"
  | "installers"
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
  { id: "installers", label: "Installers" },
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
  archives: new Set([".7z", ".bz2", ".gz", ".iso", ".rar", ".tar", ".xz", ".zip"]),
  installers: new Set([".appx", ".dmg", ".exe", ".iso", ".msi", ".msix", ".pkg"]),
  images: new Set([".gif", ".heic", ".jpeg", ".jpg", ".png", ".psd", ".raw", ".svg", ".webp"]),
  audio: new Set([".aac", ".flac", ".m4a", ".mp3", ".wav", ".wma"]),
  documents: new Set([".csv", ".doc", ".docx", ".pdf", ".ppt", ".pptx", ".txt", ".xls", ".xlsx"]),
};

export function matchesFileCategory(
  extension: string,
  category: FileCategoryFilter,
): boolean {
  if (category === "all") return true;
  return FILTER_EXTS[category].has(extension.toLowerCase());
}

export function fileMatchesCategory(
  file: Pick<ScanFileRecord, "extension">,
  category: FileCategoryFilter,
): boolean {
  return matchesFileCategory(file.extension, category);
}
