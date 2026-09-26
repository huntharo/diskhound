import { render } from "preact";

import type { AppSettings } from "../shared/contracts";
import { App } from "./App";
import { AgentConsentWindow } from "./components/AgentConsentWindow";
import { SystemWidget } from "./components/SystemWidget";
import { setSizeUnitPreference } from "./lib/format";
import { SETTINGS_UPDATED_EVENT } from "./lib/uiEvents";
import { nativeApi } from "./nativeApi";
import "./index.css";

const params = new URLSearchParams(window.location.search);
const root = params.get("widget") === "1"
  ? <SystemWidget />
  : params.get("consent") === "1"
    ? <AgentConsentWindow />
    : <App />;

// Subscribe before loading so a late initial read cannot undo a newer setting.
let settingsRevision = 0;
const applySettings = (settings: AppSettings) => {
  settingsRevision++;
  setSizeUnitPreference(settings.general.sizeUnits);
};
nativeApi.onSettingsUpdated(applySettings);
window.addEventListener(SETTINGS_UPDATED_EVENT, (event) => {
  applySettings((event as CustomEvent<AppSettings>).detail);
});
const initialRevision = settingsRevision;
void nativeApi.getSettings().then((settings) => {
  if (settings && settingsRevision === initialRevision) applySettings(settings);
}).catch(() => { /* use the platform default if settings are unavailable */ }).finally(() => {
  render(root, document.getElementById("app") as HTMLElement);
});
