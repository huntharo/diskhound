import type { DevArtifact } from "./contracts";

export type ModificationWindow = 0 | 24 | 48 | 168;

export function validFileMtime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Unknown anywhere in a tree makes its aggregate unknown. */
export function mergeFileMtime(a: number | null | undefined, b: number | null | undefined): number | null {
  return validFileMtime(a) && validFileMtime(b) ? Math.max(a, b) : null;
}

/** Only cached scan/refresh data: no index reads or filesystem work on a toggle. */
export function modificationEligible(artifact: DevArtifact, hours: ModificationWindow, now: number): boolean {
  if (hours === 0) return true;
  const latest = artifact.latestFileMtimeMs;
  return validFileMtime(latest) && latest < now - hours * 3_600_000;
}

export function filterModifiedArtifacts(artifacts: DevArtifact[], hours: ModificationWindow, now: number): DevArtifact[] {
  return hours === 0 ? artifacts : artifacts.filter((a) => modificationEligible(a, hours, now));
}
