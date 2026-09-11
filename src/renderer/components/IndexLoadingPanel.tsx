interface Stage {
  afterSec: number;
  label: string;
}

interface Props {
  title: string;
  stages: Stage[];
  elapsedSec: number;
  compact?: boolean;
  /** Scan root, shown so a full-view loader is not mistaken for "the PC". */
  eyebrow?: string;
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

export function IndexLoadingPanel({ title, stages, elapsedSec, compact, eyebrow }: Props) {
  const stage = activeStage(stages, elapsedSec);
  return (
    <div className={`index-loading ${compact ? "compact" : ""}`}>
      {eyebrow ? <div className="index-loading-root">{eyebrow}</div> : null}
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

export const DEV_SIDECAR_STAGES: Stage[] = [
  { afterSec: 0, label: "Opening the Dev Artifacts sidecar…" },
  { afterSec: 3, label: "Reading the sidecar for this scan…" },
];

export const DEV_LOADING_STAGES: Stage[] = DEV_SIDECAR_STAGES;

export const DEV_FOLDER_TREE_STAGES: Stage[] = [
  { afterSec: 0, label: "This scan has no Dev sidecar yet." },
  { afterSec: 3, label: "Classifying from the folder tree…" },
  { afterSec: 12, label: "Grouping worktrees, node_modules, and targets…" },
  { afterSec: 30, label: "Still reading the folder tree. First open on an older huge-drive scan can take a minute." },
];

export const DEV_RESCAN_STAGES: Stage[] = [
  { afterSec: 0, label: "Walking known artifact trees on this scan…" },
  { afterSec: 3, label: "Refreshing node_modules, targets, and caches…" },
  { afterSec: 12, label: "Large package trees can take several minutes." },
  { afterSec: 30, label: "Still walking known trees. This is not a full drive scan." },
];
