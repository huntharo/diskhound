import type { ScanDisplayProgress } from "../lib/scanProgress";

export function ProgressBar({ percent, label }: { percent: number | null; label: string }) {
  return <div className={`phase-progress-track ${percent === null ? "indeterminate" : ""}`}
    role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
    aria-valuenow={percent ?? undefined}>
    <div className="phase-progress-fill" style={percent === null ? undefined : { width: `${percent}%` }} />
  </div>;
}

export function ScanProgress({ progress }: { progress: ScanDisplayProgress }) {
  return <div className="scan-phase-card">
    <div className="scan-phase-heading"><strong>{progress.label}</strong>
      {progress.percent !== null && <span>{progress.percent}%</span>}
    </div>
    {progress.detail && <div className="scan-phase-detail">{progress.detail}</div>}
    {progress.active && <ProgressBar percent={progress.percent} label={progress.label} />}
  </div>;
}
