import { useState } from "preact/hooks";
import type { MacSystemMetadataUsage, ScanSnapshot } from "../../shared/contracts";
import { MacSystemMetadataTracker } from "../../shared/macSystemMetadata";
import { formatBytes, relativeTime } from "../lib/format";
import { nativeApi } from "../nativeApi";

function usageLabel(row: MacSystemMetadataUsage): string {
  if (row.status === "outside-scan") return "Outside this scan";
  if (row.bytes === null) return "Size unavailable";
  return row.status === "complete" ? formatBytes(row.bytes)
    : `At least ${formatBytes(row.bytes)} · incomplete`;
}

/** Scan-backed visibility only. Expanding guidance performs no IPC or filesystem work. */
export function MacSystemMetadataCard({ snapshot }: { snapshot: ScanSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  if (nativeApi.platform !== "darwin" || snapshot.status !== "done" || !snapshot.rootPath) return null;
  // Old history has no coverage evidence. Never infer zero from a missing hotspot.
  const rows: MacSystemMetadataUsage[] = snapshot.macSystemMetadata
    ?? new MacSystemMetadataTracker(snapshot.rootPath).snapshot(false);
  const needsAccess = rows.some((r) => r.status === "unavailable" || r.status === "incomplete");

  return (
    <div className="storage-card" role="region" aria-label="macOS system metadata">
      <div className="storage-card-head">
        <div className="storage-card-kicker">
          macOS system metadata
          <span className="storage-card-kicker-meta">
            {snapshot.finishedAt ? ` · scanned ${relativeTime(snapshot.finishedAt)}` : ""}
          </span>
        </div>
        <button type="button" className="storage-card-link storage-card-toggle"
          aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Hide guidance" : "Guidance"}
        </button>
      </div>
      <div className="storage-card-cols">
        {rows.map((row) => (
          <section key={row.kind} className="storage-card-col">
            <div className="storage-card-label">
              {row.kind === "fsevents" ? "Filesystem event history (FSEvents)" : "Spotlight search index"}
            </div>
            <div className={`storage-card-value ${row.bytes === null ? "muted" : ""}`}>
              {usageLabel(row)}
            </div>
            <div className="storage-card-meta system-metadata-path"><code>{row.path}</code></div>
            {expanded && (
              <p className="storage-card-guide">
                {row.kind === "fsevents" ? (
                  <>
                    macOS keeps a history of filesystem changes for backup and sync apps.
                    At your discretion, an administrator can shorten old history using Apple’s
                    supported, root-only <code>FSEventsPurgeEventsForDeviceUpToEventId</code> API.
                    Choosing a cutoff retains newer events; apps that need older events may
                    have to rescan. This is separate from Time Machine snapshots.
                    DiskHound does not purge this history.
                  </>
                ) : (
                  <>
                    This index supports Spotlight and Finder search. Keep indexing for search,
                    or exclude selected locations in System Settings → Spotlight (or Siri &amp;
                    Spotlight) → Search Privacy. Excluded content will not appear in those searches.
                    To repair search, Apple recommends adding a location to that list then
                    removing it to rebuild its index; rebuilding takes time and space.
                    An administrator can disable indexing for a volume, trading search for less
                    indexing work. Removing an index alone does not disable indexing and it can
                    regrow. DiskHound does not change indexing.
                  </>
                )}
              </p>
            )}
          </section>
        ))}
      </div>
      <p className="storage-card-guide">
        Allocated file bytes from this scan, with hardlinks counted once across the scan,
        already included in scanned file bytes.
        These are not extra APFS volume or snapshot totals, or guaranteed reclaimable space;
        shared blocks and directory metadata can differ from physical disk usage.
      </p>
      {expanded && (
        <p className="storage-card-guide">
          {rows.some((r) => r.status === "outside-scan")
            ? "Scan the startup disk (/) or the relevant volume to include these directories. " : ""}
          {needsAccess ? (
            <>
              Unavailable or incomplete sizes do not mean an empty store or disabled indexing.
              For protected data, you can grant DiskHound Full Disk Access in System Settings →
              Privacy &amp; Security, quit and reopen DiskHound, then scan the volume again.
              Full Disk Access does not bypass root-only filesystem permissions. If access is
              still denied, an administrator must measure the displayed paths with a read-only
              size check outside DiskHound. Enumeration errors whose paths are unknown make
              both categories incomplete. Older scans need a new scan to measure these stores.
            </>
          ) : "Sizes reflect readable files at scan time; changing stores may have grown since."}
        </p>
      )}
    </div>
  );
}
