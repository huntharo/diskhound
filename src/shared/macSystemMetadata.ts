import type { MacSystemMetadataUsage } from "./contracts";

const under = (parent: string, path: string) => path === parent
  || path.startsWith(parent === "/" ? "/" : `${parent}/`);

/** Startup metadata has one canonical Data-volume path, never firmlink aliases. */
export function macSystemMetadataPaths(root: string): string[] {
  const external = /^\/Volumes\/[^/]+/.exec(root)?.[0];
  const direct = /^(.*)\/\.(?:fseventsd|Spotlight-V100)$/.exec(root)?.[1];
  const volume = external ?? direct ?? "/System/Volumes/Data";
  return [`${volume}/.fseventsd`, `${volume}/.Spotlight-V100`];
}

/** Two fixed counters; never walk collections or read the filesystem for display. */
export class MacSystemMetadataTracker {
  private rows;

  constructor(private root: string, paths = macSystemMetadataPaths(root)) {
    this.rows = paths.map((path, i) => ({
      kind: (i === 0 ? "fsevents" : "spotlight") as MacSystemMetadataUsage["kind"],
      path, bytes: 0, observed: false, issue: undefined as MacSystemMetadataUsage["issue"],
    }));
  }

  directory(path: string): void {
    for (const row of this.rows) if (path === row.path) row.observed = true;
  }

  /** Directory mtimes do not prove the contents of these changing stores are unchanged. */
  requiresWalk(path: string): boolean {
    return this.rows.some((row) => under(row.path, path) || under(path, row.path));
  }

  file(path: string, occupancy: number): void {
    for (const row of this.rows) if (under(row.path, path)) {
      row.observed = true;
      row.bytes += occupancy;
    }
  }

  uncertain(path: string | null): void {
    for (const row of this.rows) {
      if (path === null || under(row.path, path) || under(path, row.path)) row.issue = "scan-errors";
    }
  }

  snapshot(done: boolean): MacSystemMetadataUsage[] {
    return this.rows.map((row) => {
      const covered = under(this.root, row.path);
      const complete = covered && done && row.observed && !row.issue;
      // Failed / unobserved collection is unknown even when its accumulator is zero.
      const bytes = complete || row.bytes > 0 ? row.bytes : null;
      return {
        kind: row.kind, path: row.path, bytes,
        status: !covered ? "outside-scan" : complete ? "complete"
          : bytes !== null ? "incomplete" : "unavailable",
        ...(!complete && covered ? { issue: row.issue ?? "not-observed" as const } : {}),
      };
    });
  }
}
