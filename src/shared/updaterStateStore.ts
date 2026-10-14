import * as FS from "node:fs";

/**
 * Per-profile attempt reservations, successful checks and server/error
 * cooldowns survive restarts and app-version/channel changes. lastCheckedAt
 * remains the renderer's compatible "last attempted" timestamp. Install
 * bookkeeping shares this small file; unchanged patches never rewrite it.
 */
export interface UpdaterState {
  lastCheckedAt: number | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextCheckAt: number | null;
  retryAfterAt: number | null;
  consecutiveFailures: number;
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
  const timestamp = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  try {
    const raw = FS.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<UpdaterState>;
    return {
      lastCheckedAt: timestamp(parsed.lastCheckedAt),
      lastAttemptAt: timestamp(parsed.lastAttemptAt),
      lastSuccessAt: timestamp(parsed.lastSuccessAt),
      nextCheckAt: timestamp(parsed.nextCheckAt),
      retryAfterAt: timestamp(parsed.retryAfterAt),
      consecutiveFailures: typeof parsed.consecutiveFailures === "number"
        && Number.isInteger(parsed.consecutiveFailures)
        ? Math.max(0, Math.min(10, parsed.consecutiveFailures)) : 0,
      pendingInstallVersion:
        typeof parsed.pendingInstallVersion === "string" ? parsed.pendingInstallVersion : null,
      pendingInstallStartedAt:
        typeof parsed.pendingInstallStartedAt === "number" ? parsed.pendingInstallStartedAt : null,
    };
  } catch { /* missing / corrupt — treat as "never checked" */ }
  return { lastCheckedAt: null, lastAttemptAt: null, lastSuccessAt: null,
    nextCheckAt: null, retryAfterAt: null, consecutiveFailures: 0,
    pendingInstallVersion: null, pendingInstallStartedAt: null };
}
