import type { DevArtifact } from "../../shared/contracts";
import { summarizeDevSharing } from "../../shared/storageSharing";
import { formatBytes, formatBytesRange } from "./format";

type SharingSummary = ReturnType<typeof summarizeDevSharing>;

/** The same threshold and headline in Overview and the Dev Artifacts tab. */
export function devReclaimDisplay(sharing: SharingSummary) {
  const cloneAwareTotal = sharing.measuredTrees > 0
    && sharing.totalBytes - sharing.freesBytes >= Math.max(64 * 1024 * 1024, sharing.totalBytes * 0.02);
  const reclaimRange = formatBytesRange(sharing.freesBytes, sharing.freesAtMostBytes);
  const reclaimIsRange = reclaimRange !== formatBytes(sharing.freesBytes);
  return {
    cloneAwareTotal,
    reclaimRange,
    reclaimIsRange,
    value: cloneAwareTotal
      ? reclaimIsRange ? reclaimRange : `≈ ${reclaimRange}`
      : formatBytes(sharing.totalBytes),
  };
}

/** Overview leads with what deleting all listed trees may free, when measured. */
export function overviewDevTileDisplay(
  artifacts: ReadonlyArray<Pick<DevArtifact, "path" | "size" | "clone">>,
) {
  if (artifacts.length === 0) return null;
  const sharing = summarizeDevSharing(artifacts);
  if (sharing.totalBytes <= 0) return null;
  const reclaim = devReclaimDisplay(sharing);
  const listed = formatBytes(sharing.totalBytes);
  const unmeasured = sharing.measuredTrees < artifacts.length
    ? " Some trees had no clone measurements; their listed sizes are included in this estimate."
    : "";
  return {
    value: reclaim.value,
    label: reclaim.cloneAwareTotal ? "dev artifacts reclaimable" : "dev artifacts listed",
    secondary: reclaim.cloneAwareTotal ? `${listed} listed` : null,
    title: reclaim.cloneAwareTotal
      ? `Open Dev Artifacts. Deleting every listed tree frees about ${formatBytes(sharing.freesBytes)}`
        + (reclaim.reclaimIsRange
          ? `, up to ${formatBytes(sharing.freesAtMostBytes)} if no copy of their shared clones is left elsewhere`
          : "")
        + `. ${listed} listed. Local snapshots can delay the release of those blocks.${unmeasured}`
      : `Open Dev Artifacts. ${listed} listed on this scan; listed size does not guarantee that deletion frees that much.`
        + (sharing.measuredTrees === 0 ? " Clone measurements are unavailable for this scan." : "")
        + " Local snapshots can delay the release of those blocks.",
    listedBytes: sharing.totalBytes,
    freesBytes: sharing.freesBytes,
    freesAtMostBytes: sharing.freesAtMostBytes,
  };
}
