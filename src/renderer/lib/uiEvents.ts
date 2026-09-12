import type { AppSettings } from "../../shared/contracts";

export const SETTINGS_UPDATED_EVENT = "diskhound:settings-updated";
export const DEV_ARTIFACTS_UPDATED_EVENT = "diskhound:dev-artifacts-updated";

export function dispatchDevArtifactsUpdated(rootPath: string): void {
  window.dispatchEvent(
    new CustomEvent(DEV_ARTIFACTS_UPDATED_EVENT, { detail: { rootPath } }),
  );
}

export function dispatchSettingsUpdated(settings: AppSettings): void {
  window.dispatchEvent(
    new CustomEvent<AppSettings>(SETTINGS_UPDATED_EVENT, {
      detail: settings,
    }),
  );
}
