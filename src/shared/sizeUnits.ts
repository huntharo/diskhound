import type { GeneralSettings } from "./contracts";

export type SizeUnitBase = 1000 | 1024;

export function resolveSizeUnitBase(preference: GeneralSettings["sizeUnits"], platform: string): SizeUnitBase {
  return preference === "decimal" || (preference === undefined && platform === "darwin") ? 1000 : 1024;
}

/** Binary retains the existing KB/MB/GB labels used by Windows Explorer. */
export function formatSizeBytes(bytes: number, base: SizeUnitBase): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.max(0, Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(base)), units.length - 1));
  const val = bytes / base ** exp;
  return `${val.toFixed(Math.abs(val) >= 100 || exp === 0 ? 0 : 1)} ${units[exp]}`;
}
