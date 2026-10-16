import type { ScanSnapshot } from "../../shared/contracts";
import { formatBytes, formatCount } from "../lib/format";
import { IndexLoadingPanel } from "./IndexLoadingPanel";

interface Props {
  snapshot: ScanSnapshot;
  elapsedMs: number;
  percent?: number | null;
  hasResults: boolean;
}

export function ScanProgressPanel({ snapshot, elapsedMs, percent, hasResults }: Props) {
  let stage: string;
  switch (snapshot.scanPhase) {
    case "starting":
      stage = "Preparing scan — loading the prior index if available…";
      break;
    case "reading_metadata":
      stage = "Reading the volume's filesystem metadata…";
      break;
    case "indexing":
      stage = "Indexing files…";
      break;
    case "finalizing":
      stage = "Finalizing — building the folder tree and flushing the index…";
      break;
    default:
      stage = "Scanning folders — files will appear as they're found…";
  }

  const expected = snapshot.scanPhase === "indexing" ? snapshot.expectedTotalFiles : null;
  const counts = expected && expected > 0
    ? `${formatCount(snapshot.filesVisited)} / ${formatCount(expected)} files indexed`
    : `${formatCount(snapshot.filesVisited)} files · ${formatCount(snapshot.directoriesVisited)} folders`;

  return (
    <div className={`scan-progress ${hasResults ? "with-results" : ""}`}>
      <IndexLoadingPanel
        title={`Scanning ${snapshot.rootPath}…`}
        stages={[{ afterSec: 0, label: stage }]}
        elapsedSec={Math.floor(Math.max(0, elapsedMs) / 1000)}
        progressPercent={percent}
        detail={`${counts} · ${formatBytes(snapshot.bytesSeen)}${typeof percent === "number" ? ` · ${percent}%` : ""}`}
      />
    </div>
  );
}
