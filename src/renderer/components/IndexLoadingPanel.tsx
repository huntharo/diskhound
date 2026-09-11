interface Stage {
  afterSec: number;
  label: string;
}

interface Props {
  title: string;
  stages: Stage[];
  elapsedSec: number;
  compact?: boolean;
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function activeStage(stages: Stage[], elapsedSec: number): Stage {
  let current = stages[0] ?? { afterSec: 0, label: "Loading…" };
  for (const stage of stages) {
    if (elapsedSec >= stage.afterSec) current = stage;
  }
  return current;
}

export function IndexLoadingPanel({ title, stages, elapsedSec, compact }: Props) {
  const stage = activeStage(stages, elapsedSec);
  return (
    <div className={`index-loading ${compact ? "compact" : ""}`}>
      <div className="index-loading-ring" aria-hidden="true" />
      <div className="index-loading-title">{title}</div>
      <div className="index-loading-bar" aria-hidden="true">
        <div className="index-loading-bar-fill" />
      </div>
      <div key={stage.label} className="index-loading-status">
        {stage.label}
      </div>
      <div className="index-loading-elapsed">{formatElapsed(elapsedSec)}</div>
    </div>
  );
}

export const FOLDER_LOADING_STAGES: Stage[] = [
  { afterSec: 0, label: "Opening the folder index…" },
  { afterSec: 3, label: "Reading the folder tree sidecar…" },
  { afterSec: 12, label: "Assembling this folder's children…" },
  { afterSec: 30, label: "Still working — large drives take a minute the first time." },
];

export const DEV_LOADING_STAGES: Stage[] = [
  { afterSec: 0, label: "Opening the scan index…" },
  { afterSec: 3, label: "Finding worktrees, node_modules, and targets…" },
  { afterSec: 12, label: "Rolling up caches and build trees…" },
  { afterSec: 30, label: "Still reading — millions of files can take a minute." },
];
