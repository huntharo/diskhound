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

/** Overview leads with reclaimable bytes only for trees with clone measurements. */
export function overviewDevTileDisplay(
  artifacts: ReadonlyArray<Pick<DevArtifact, "path" | "size" | "clone">>,
) {
  if (artifacts.length === 0) return null;
  const sharing = summarizeDevSharing(artifacts);
  if (sharing.totalBytes <= 0) return null;
  const hasUnmeasured = sharing.measuredTrees < artifacts.length;
  const unmeasuredBytes = hasUnmeasured
    ? artifacts.reduce((sum, artifact) => sum + (artifact.clone ? 0 : artifact.size), 0)
    : 0;
  // summarizeDevSharing includes unmeasured trees at their full listed size.
  // Remove those assumed bytes before presenting a reclaimable range.
  const measuredSharing = hasUnmeasured ? {
    ...sharing,
    totalBytes: sharing.totalBytes - unmeasuredBytes,
    freesBytes: sharing.freesBytes - unmeasuredBytes,
    freesAtMostBytes: sharing.freesAtMostBytes - unmeasuredBytes,
  } : sharing;
  const reclaim = devReclaimDisplay(measuredSharing);
  const listed = formatBytes(sharing.totalBytes);
  const unmeasured = hasUnmeasured
    ? ` ${formatBytes(unmeasuredBytes)} of listed bytes belong to unmeasured trees.`
    : "";
  return {
    value: reclaim.cloneAwareTotal ? reclaim.value : listed,
    label: reclaim.cloneAwareTotal
      ? hasUnmeasured ? "measured trees reclaimable" : "dev artifacts reclaimable"
      : "dev artifacts listed",
    secondary: reclaim.cloneAwareTotal
      ? hasUnmeasured ? `${formatBytes(unmeasuredBytes)} unmeasured · ${listed} listed` : `${listed} listed`
      : null,
    title: reclaim.cloneAwareTotal
      ? `Open Dev Artifacts. Deleting ${hasUnmeasured ? "the measured trees" : "every listed tree"} frees about ${formatBytes(measuredSharing.freesBytes)}`
        + (reclaim.reclaimIsRange
          ? `, up to ${formatBytes(measuredSharing.freesAtMostBytes)} if no copy of their shared clones is left elsewhere`
          : "")
        + `. ${listed} listed.${unmeasured}`
        + (hasUnmeasured ? " Those bytes are excluded from this estimate." : "")
        + " Local snapshots can delay the release of those blocks."
      : `Open Dev Artifacts. ${listed} listed on this scan; listed size does not guarantee that deletion frees that much.`
        + (sharing.measuredTrees === 0 ? " Clone measurements are unavailable for this scan." : "")
        + unmeasured
        + (hasUnmeasured ? " Their reclaimable bytes are unknown." : "")
        + " Local snapshots can delay the release of those blocks.",
    listedBytes: sharing.totalBytes,
    freesBytes: measuredSharing.freesBytes,
    freesAtMostBytes: measuredSharing.freesAtMostBytes,
  };
}
