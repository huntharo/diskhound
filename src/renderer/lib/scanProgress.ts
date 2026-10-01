import type { DiskhoundPlatform, DiskSpaceInfo, FullDiffProgress, ScanSnapshot } from "../../shared/contracts";
import { owningDrive, rootKeyFor } from "./driveMatch";

export interface ScanDisplayProgress {
  active: boolean;
  label: string;
  detail: string;
  percent: number | null;
}

export function comparisonForScan(snapshot: ScanSnapshot, progress: FullDiffProgress[], platform: DiskhoundPlatform) {
  return progress.filter((item) =>
    item.isLatestPair && rootKeyFor(item.rootPath, platform) === rootKeyFor(snapshot.rootPath, platform)
    && item.scanStartedAt === snapshot.startedAt,
  ).sort((a, b) => b.revision - a.revision)[0];
}

export function comparisonPercent(progress: FullDiffProgress): number {
  return Math.min(progress.status === "complete" ? 100 : 99, Math.max(0, Math.round(progress.fraction * 100)));
}

export function scanDisplayProgress(
  snapshot: ScanSnapshot | null,
  drives: DiskSpaceInfo[],
  comparisons: FullDiffProgress[],
  platform: DiskhoundPlatform,
): ScanDisplayProgress {
  if (!snapshot) return { active: false, label: "Ready", detail: "", percent: null };
  if (snapshot.status === "running") {
    if (snapshot.scanPhase === "finalizing") {
      const steps = {
        finishing_index: "Finishing file index",
        writing_folder_tree: "Writing folder tree",
        flushing_index: "Flushing file index",
        classifying_dev_artifacts: "Classifying Dev Artifacts",
      };
      return { active: true, label: "Finalizing", detail: steps[snapshot.finalizingStep ?? "finishing_index"], percent: null };
    }
    const mount = owningDrive(drives.map((drive) => drive.drive), snapshot.rootPath ?? "", platform);
    const drive = drives.find((item) => item.drive === mount);
    const fraction = snapshot.scanPhase === "indexing" && (snapshot.expectedTotalFiles ?? 0) > 0
      ? snapshot.filesVisited / snapshot.expectedTotalFiles!
      : drive && drive.usedBytes > 0 && snapshot.bytesSeen > 0 ? snapshot.bytesSeen / drive.usedBytes : null;
    return {
      active: true, label: "Scanning",
      detail: snapshot.scanPhase === "reading_metadata" ? "Reading filesystem metadata" : snapshot.scanPhase === "starting" ? "Preparing scan" : "",
      percent: fraction !== null && Number.isFinite(fraction) ? Math.min(99, Math.max(0, Math.round(fraction * 100))) : null,
    };
  }
  if (snapshot.status === "done") {
    const comparison = comparisonForScan(snapshot, comparisons, platform);
    if (comparison?.status === "running") return {
      active: true, label: "Examining changes",
      detail: comparison.phase === "sorting" ? "Reading scan indexes" : "Comparing files",
      percent: comparisonPercent(comparison),
    };
    if (comparison?.status === "error") return { active: false, label: "Comparison unavailable", detail: "Scan complete · Retry in Changes", percent: null };
    return { active: false, label: "Complete", detail: "", percent: 100 };
  }
  return { active: false, label: snapshot.status === "error" ? "Scan failed" : snapshot.status === "cancelled" ? "Stopped" : "Ready", detail: "", percent: null };
}
