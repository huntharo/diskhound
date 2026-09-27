import type { DiskSpaceInfo } from "../../shared/contracts";
import { formatBytes } from "./format";

type DriveCapacity = Pick<DiskSpaceInfo, "totalBytes" | "freeBytes" | "usedPercent" | "availableBytes" | "purgeableBytes">;

export function driveSpaceLabel(drive: DriveCapacity): string {
  return drive.availableBytes === undefined ? "free" : "available";
}

export function formatDriveSpace(drive: DriveCapacity): string {
  const space = `${formatBytes(drive.availableBytes ?? drive.freeBytes)} ${driveSpaceLabel(drive)}`;
  return drive.availableBytes !== undefined && drive.purgeableBytes !== undefined
    ? `${space} · ${formatBytes(drive.purgeableBytes)} purgeable`
    : space;
}

/** Purgeable space belongs to Available, so it must not make the bar red. */
export function driveUsedPercent(drive: DriveCapacity): number {
  return drive.availableBytes === undefined ? drive.usedPercent
    : drive.totalBytes > 0 ? Math.max(0, Math.min(100, (1 - drive.availableBytes / drive.totalBytes) * 100)) : 0;
}
