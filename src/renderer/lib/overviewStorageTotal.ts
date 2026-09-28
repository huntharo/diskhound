import type { ScanSnapshot } from "../../shared/contracts";
import { summarizeScanSharing } from "../../shared/storageSharing";

type OverviewStorageSnapshot = Pick<
  ScanSnapshot,
  "bytesSeen" | "sizeSemantics" | "skippedEntries" | "storageAccounting"
>;

/** Presentation only: the scan and treemap continue to use bytesSeen. */
export function overviewStorageTotal(snapshot: OverviewStorageSnapshot) {
  const primaryTitle = [
    snapshot.sizeSemantics !== "allocated"
      ? "Scanned file sizes from an older scan. Rescan for allocated file bytes."
      : "Scanned allocated file bytes after sparse holes and filesystem compression. Shared clone blocks count for each file; this is not physical disk usage.",
    snapshot.skippedEntries > 0
      ? `${snapshot.skippedEntries} skipped entries are not included.`
      : null,
  ].filter(Boolean).join(" ");

  const sharing = summarizeScanSharing(snapshot.storageAccounting);
  if (!sharing || sharing.duplicateBytes === null) {
    return {
      primaryBytes: snapshot.bytesSeen,
      primaryLabel: "scanned file bytes",
      primaryTitle,
      adjustedBytes: null,
      adjustedLabel: null,
      adjustedTitle: null,
    };
  }

  const qualifiers = [
    "Estimate of scanned file bytes after subtracting known full-clone repeats; not physical disk usage. Partial clones can also share blocks.",
    sharing.approximate
      ? "Known full-clone repeats are a lower bound because clone-group tracking was truncated; this estimate may be high."
      : "Only known full-clone repeats are subtracted.",
    sharing.measuredBytes < snapshot.bytesSeen
      ? "Clone attributes were not measured for all scanned bytes."
      : null,
    snapshot.skippedEntries > 0
      ? `${snapshot.skippedEntries} skipped entries are not included.`
      : null,
  ];
  return {
    primaryBytes: snapshot.bytesSeen,
    primaryLabel: "scanned file bytes",
    primaryTitle,
    adjustedBytes: Math.max(0, snapshot.bytesSeen - sharing.duplicateBytes),
    adjustedLabel: "after known clone repeats",
    adjustedTitle: qualifiers.filter(Boolean).join(" "),
  };
}
