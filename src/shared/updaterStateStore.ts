import * as FS from "node:fs";

/**
 * Persisted timestamp of the last time we successfully *attempted* an
 * update check (whether or not an update was available), plus the
 * version an in-progress install is expected to land. The renderer
 * pulls lastCheckedAt via getUpdateState() on mount so "last checked"
 * survives restarts instead of reading "Never" every time the app
 * cold-boots.
 */
export interface UpdaterState {
  lastCheckedAt: number | null;
  pendingInstallVersion: string | null;
  pendingInstallStartedAt: number | null;
}

export interface UpdaterStateStore {
  get: () => UpdaterState;
  /** Applies `patch` and rewrites the file, unless nothing changed. */
  update: (patch: Partial<UpdaterState>) => void;
}

export function createUpdaterStateStore(filePath: string): UpdaterStateStore {
  let state = readUpdaterState(filePath);

  const persist = () => {
    try {
      FS.writeFileSync(filePath, JSON.stringify(state));
    } catch { /* best effort */ }
  };

  return {
    get: () => state,
    update: (patch) => {
      const next = { ...state, ...patch };
      if (JSON.stringify(next) === JSON.stringify(state)) return;
      state = next;
      persist();
    },
  };
}

function readUpdaterState(filePath: string): UpdaterState {
  try {
    const raw = FS.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<UpdaterState>;
    return {
      lastCheckedAt: typeof parsed.lastCheckedAt === "number" ? parsed.lastCheckedAt : null,
      pendingInstallVersion:
        typeof parsed.pendingInstallVersion === "string" ? parsed.pendingInstallVersion : null,
      pendingInstallStartedAt:
        typeof parsed.pendingInstallStartedAt === "number" ? parsed.pendingInstallStartedAt : null,
    };
  } catch { /* missing / corrupt — treat as "never checked" */ }
  return { lastCheckedAt: null, pendingInstallVersion: null, pendingInstallStartedAt: null };
}
