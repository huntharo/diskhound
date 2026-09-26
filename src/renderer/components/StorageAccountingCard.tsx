import { useEffect, useState } from "preact/hooks";

import type { ScanSnapshot, StorageAccountingReport } from "../../shared/contracts";
import {
  summarizeScanSharing,
  THIN_SNAPSHOTS_COMMAND,
  userDataSnapshots,
} from "../../shared/storageSharing";
import { formatBytes, formatCount, relativeTime } from "../lib/format";
import { saveLocalPreference } from "../lib/localPreference";
import { STORAGE_ACCOUNTING_STALE_EVENT } from "../lib/uiEvents";
import { nativeApi } from "../nativeApi";
import { toast } from "./Toasts";

/** Background refresh; the main process caches for 15 s anyway. */
const REFRESH_MS = 60_000;
const COLLAPSED_KEY = "diskhound:storage-card-collapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Overview card (macOS): the two reasons "delete X to free Y" goes
 * wrong on APFS — local snapshots still holding deleted blocks, and
 * clones sharing blocks between trees — with what the user can do.
 *
 * Snapshot numbers come from `tmutil` / `diskutil` / Foundation via the
 * main process; clone numbers from the scan's `storageAccounting`.
 * Every figure is labelled with where it comes from, because none of
 * them is "what deleting this frees" on its own.
 */
export function StorageAccountingCard({ snapshot, onViewDev }: {
  snapshot: ScanSnapshot;
  onViewDev?: () => void;
}) {
  const [report, setReport] = useState<StorageAccountingReport | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      saveLocalPreference(COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  };
  const rootPath = snapshot.status === "done" ? snapshot.rootPath : null;
  const isMac = nativeApi.platform === "darwin";

  useEffect(() => {
    if (!isMac || !rootPath) {
      setReport(null);
      return;
    }
    let cancelled = false;
    const load = (fresh = false) => {
      void nativeApi.getStorageAccounting(rootPath, { fresh }).then((next) => {
        if (!cancelled) setReport(next);
      }).catch(() => { /* keep the last report */ });
    };
    load();
    // Each collection runs five subprocesses: skip ticks while the window
    // is hidden, and let focus use the main-process cache (not `fresh`).
    const id = window.setInterval(() => {
      if (!document.hidden) load();
    }, REFRESH_MS);
    const onStale = () => load(true);
    const onFocus = () => load();
    window.addEventListener(STORAGE_ACCOUNTING_STALE_EVENT, onStale);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener(STORAGE_ACCOUNTING_STALE_EVENT, onStale);
      window.removeEventListener("focus", onFocus);
    };
  }, [isMac, rootPath, snapshot.finishedAt]);

  if (!isMac || !rootPath || !report?.supported) return null;

  const sharing = summarizeScanSharing(snapshot.storageAccounting);
  const snapshots = userDataSnapshots(report);
  const tmCount = snapshots.filter((s) => s.kind === "time-machine").length;
  const newest = snapshots.find((s) => s.createdAt !== null);
  const oldest = [...snapshots].reverse().find((s) => s.createdAt !== null);
  const purgeable = report.purgeableBytes ?? 0;
  const snapshotLabel = snapshots.length === 0
    ? "No local snapshots"
    : tmCount === snapshots.length
      ? `${formatCount(tmCount)} local Time Machine snapshot${tmCount === 1 ? "" : "s"}`
      : `${formatCount(snapshots.length)} local snapshot${snapshots.length === 1 ? "" : "s"}`;

  const copyThinCommand = () => {
    void navigator.clipboard?.writeText(THIN_SNAPSHOTS_COMMAND).then(
      () => toast("success", "Copied", THIN_SNAPSHOTS_COMMAND),
      () => toast("error", "Could not copy", THIN_SNAPSHOTS_COMMAND),
    );
  };

  const header = (
    <div className="storage-card-head">
      <div className="storage-card-kicker">
        Why deleting may not free space
        <span className="storage-card-kicker-meta">
          {collapsed
            ? ` · ${purgeable > 0 ? `≈ ${formatBytes(purgeable)} purgeable` : "nothing purgeable"}`
              // Lower only the leading "No"; "Time Machine" keeps its capitals.
              + ` · ${snapshotLabel.charAt(0).toLowerCase()}${snapshotLabel.slice(1)}`
              + (sharing ? ` · ${formatBytes(sharing.cloneBytes)} in clones` : "")
            : (report.freeBytes !== null ? ` · ${formatBytes(report.freeBytes)} free now` : "")
              + (report.availableForImportantUsageBytes !== null
                ? ` · Finder “Available” ${formatBytes(report.availableForImportantUsageBytes)}`
                : "")}
        </span>
      </div>
      <button
        type="button"
        className="storage-card-link storage-card-toggle"
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
      >
        {collapsed ? "Details" : "Hide"}
      </button>
    </div>
  );

  if (collapsed) {
    return (
      <div className="storage-card collapsed" role="region" aria-label="Space macOS is holding back">
        {header}
      </div>
    );
  }

  return (
    <div className="storage-card" role="region" aria-label="Space macOS is holding back">
      {header}
      <div className="storage-card-cols">
        <section className={`storage-card-col ${snapshots.length > 0 ? "warn" : ""}`}>
          <div className="storage-card-label">Held by local snapshots</div>
          <div
            className="storage-card-value"
            title="Finder “Available” minus free space: blocks local snapshots still reference, plus caches macOS can clear on demand. macOS does not report how much each snapshot holds."
          >
            {purgeable > 0 ? `≈ ${formatBytes(purgeable)} purgeable` : "Nothing purgeable"}
          </div>
          <div className="storage-card-meta">
            {snapshotLabel}
            {newest?.createdAt ? ` · newest ${relativeTime(newest.createdAt)}` : ""}
            {oldest?.createdAt && oldest !== newest ? ` · oldest ${relativeTime(oldest.createdAt)}` : ""}
          </div>
          <p className="storage-card-guide">
            {snapshots.length > 0
              ? "Files deleted after a snapshot keep their space until the snapshot goes. Time Machine removes local snapshots after about 24 hours, or sooner when the disk runs low. To reclaim it now, thin them from Terminal — this removes local restore points only; backups on your Time Machine disk stay."
              : "Deleting files frees space right away. Purgeable space here is caches macOS clears when it needs room."}
          </p>
          {snapshots.length > 0 && (
            <div className="storage-card-command">
              <code>{THIN_SNAPSHOTS_COMMAND}</code>
              <button type="button" className="storage-card-link" onClick={copyThinCommand}>
                Copy
              </button>
            </div>
          )}
        </section>
        <section className={`storage-card-col ${sharing && sharing.sharedBytes > 0 ? "info" : ""}`}>
          <div className="storage-card-label">Shared (cloned) space</div>
          {sharing ? (
            <>
              <div
                className="storage-card-value"
                title="Allocated size of files APFS flags as sharing blocks with a clone (EF_MAY_SHARE_BLOCKS)."
              >
                {formatBytes(sharing.cloneBytes)} in {formatCount(sharing.cloneFiles)} cloned file{sharing.cloneFiles === 1 ? "" : "s"}
              </div>
              <div className="storage-card-meta">
                {sharing.duplicateBytes !== null && sharing.duplicateBytes > 0
                  ? `The ${formatBytes(snapshot.bytesSeen)} total counts ${sharing.approximate ? "at least " : ""}${formatBytes(sharing.duplicateBytes)} of it more than once`
                  : "No clone is counted twice in this scan"}
                {sharing.clonePrivateBytes > 0 ? ` · ${formatBytes(sharing.clonePrivateBytes)} no longer shared` : ""}
              </div>
              <p className="storage-card-guide">
                APFS clones — pnpm and bun installs, Finder duplicates, <code>cp -c</code> copies —
                share blocks. Deleting one copy frees almost nothing; the space comes back only
                when every copy is gone.
                {onViewDev && (
                  <>
                    {" "}
                    <button type="button" className="storage-card-link" onClick={onViewDev}>
                      Dev Artifacts
                    </button>
                    {" "}marks trees that share space.
                  </>
                )}
              </p>
            </>
          ) : (
            <>
              <div className="storage-card-value muted">Not measured</div>
              <p className="storage-card-guide">
                This scan has no clone data — it predates clone accounting or the volume is not
                APFS. Rescan to see how much of the total is shared between APFS clones.
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
