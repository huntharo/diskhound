import { describe, expect, it } from "vitest";

import type { DevArtifact, StorageAccountingReport } from "../contracts";
import {
  ageLabel,
  cloneHintForPath,
  deleteSnapshotCommand,
  devArtifactSharing,
  explainFreedShortfall,
  isMeaningfullyShared,
  summarizeDevSharing,
  summarizeScanSharing,
  userDataSnapshots,
} from "../storageSharing";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function artifact(path: string, size: number, clone?: DevArtifact["clone"]): Pick<DevArtifact, "path" | "size" | "clone"> {
  return { path, size, clone };
}

const NOW = new Date(2026, 8, 24, 22, 0, 0).getTime();

function report(snapshotNames: string[]): StorageAccountingReport {
  return {
    platform: "darwin",
    volumePath: "/",
    supported: true,
    filesystem: "apfs",
    checkedAt: NOW,
    totalBytes: 2000 * GiB,
    freeBytes: 100 * GiB,
    availableForImportantUsageBytes: 160 * GiB,
    purgeableBytes: 60 * GiB,
    container: null,
    snapshots: snapshotNames.map((name) => ({
      name,
      kind: name.startsWith("com.apple.TimeMachine.")
        ? "time-machine"
        : name.startsWith("com.apple.os.update-") ? "os-update" : "other",
      createdAt: name.includes("2026-09-24-003521") ? new Date(2026, 8, 24, 0, 35, 21).getTime() : null,
      purgeable: true,
      limitsContainerShrink: true,
    })),
    notes: [],
  };
}

describe("cloneHintForPath", () => {
  it("recognises pnpm stores and virtual stores, bun caches", () => {
    expect(cloneHintForPath("/Users/me/Library/pnpm/store")?.kind).toBe("pnpm-store");
    expect(cloneHintForPath("/home/me/.local/share/pnpm/store")?.kind).toBe("pnpm-store");
    expect(cloneHintForPath("C:\\Users\\me\\AppData\\Local\\pnpm\\store")?.kind).toBe("pnpm-store");
    expect(cloneHintForPath("/Users/me/app/.pnpm-store")?.kind).toBe("pnpm-store");
    expect(cloneHintForPath("/Users/me/app/node_modules/.pnpm")?.kind).toBe("pnpm-virtual-store");
    expect(cloneHintForPath("/Users/me/.bun/install/cache")?.kind).toBe("bun-cache");
    expect(cloneHintForPath("/Users/me/.bun")?.kind).toBe("bun-cache");
  });

  it("does not guess for plain node_modules or build output", () => {
    expect(cloneHintForPath("/Users/me/app/node_modules")).toBeNull();
    expect(cloneHintForPath("/Users/me/app/target/debug")).toBeNull();
    // pnpm's metadata cache, not its content store: nothing links to it.
    expect(cloneHintForPath("/home/me/.cache/pnpm")).toBeNull();
  });
});

describe("devArtifactSharing", () => {
  it("a pnpm node_modules that is all clones of the store frees ~nothing", () => {
    // Numbers from a real scan: ClawKeeper/node_modules, 488 MB, every
    // file a clone of ~/Library/pnpm/store.
    const sharing = devArtifactSharing(artifact("/Users/me/ClawKeeper/node_modules", 488 * MiB, {
      cloneSize: 488 * MiB,
      clonePrivateSize: 0,
      cloneInternalSize: 0,
      cloneSharedSize: 488 * MiB,
      sharedRoots: 1,
      sharedWith: ["/Users/me/Library/pnpm/store"],
    }));
    expect(sharing).toMatchObject({
      measured: true,
      freesBytes: 0,
      sharedBytes: 488 * MiB,
      sharedRoots: 1,
      sharedWith: ["/Users/me/Library/pnpm/store"],
    });
    expect(isMeaningfullyShared(sharing, 488 * MiB)).toBe(true);
  });

  it("counts ordinary files, rewritten clone blocks and owned clone groups once", () => {
    // 10 GB tree: 6 GB ordinary files, 4 GB clone files of which 1 GB is
    // two copies of a 512 MB group living only here, 256 MB rewritten.
    const sharing = devArtifactSharing(artifact("/p/target", 10 * GiB, {
      cloneSize: 4 * GiB,
      clonePrivateSize: 256 * MiB,
      cloneInternalSize: 512 * MiB,
      cloneSharedSize: 4 * GiB - 256 * MiB - GiB,
      sharedRoots: 3,
      sharedWith: ["/q/target"],
    }));
    expect(sharing.freesBytes).toBe(6 * GiB + 256 * MiB + 512 * MiB);
  });

  it("clamps inconsistent sidecar numbers to the tree size", () => {
    const sharing = devArtifactSharing(artifact("/p", 100, {
      cloneSize: 500,
      clonePrivateSize: 900,
      cloneInternalSize: 900,
      cloneSharedSize: 700,
      sharedRoots: -1,
      sharedWith: [],
    }));
    expect(sharing.freesBytes).toBe(100);
    expect(sharing.sharedBytes).toBe(100);
    expect(sharing.sharedRoots).toBe(0);
  });

  it("falls back to the path hint for unmeasured trees", () => {
    const sharing = devArtifactSharing(artifact("/Users/me/Library/pnpm/store", 26 * GiB));
    expect(sharing).toMatchObject({ measured: false, freesBytes: null, hint: { kind: "pnpm-store" } });
    expect(isMeaningfullyShared(sharing, 26 * GiB)).toBe(true);
    expect(isMeaningfullyShared(devArtifactSharing(artifact("/a/node_modules", GiB)), GiB)).toBe(false);
  });

  it("ignores trivial sharing", () => {
    const sharing = devArtifactSharing(artifact("/p", GiB, {
      cloneSize: 64 * 1024,
      clonePrivateSize: 0,
      cloneInternalSize: 0,
      cloneSharedSize: 64 * 1024,
      sharedRoots: 1,
      sharedWith: [],
    }));
    expect(isMeaningfullyShared(sharing, GiB)).toBe(false);
  });
});

describe("summarizeDevSharing", () => {
  it("assumes unmeasured trees free their full size", () => {
    const summary = summarizeDevSharing([
      artifact("/a/node_modules", 100, {
        cloneSize: 80,
        clonePrivateSize: 0,
        cloneInternalSize: 0,
        cloneSharedSize: 80,
        sharedRoots: 1,
        sharedWith: [],
      }),
      artifact("/b/target", 50),
    ]);
    expect(summary).toEqual({
      measuredTrees: 1,
      totalBytes: 150,
      freesBytes: 20 + 50,
      // No cloneSharedBlocks (older sidecar): the shared bytes stand in.
      freesAtMostBytes: 150,
      sharedBytes: 80,
      sharedBlocks: 80,
    });
  });

  it("bounds deleting every tree by each copy's share of the blocks", () => {
    // A 1 GB file cloned 50 ways, 5 copies in each of ten node_modules:
    // 50 GB listed, 0 freed by any one tree, 1 GB freed by all of them.
    const GB = 1_000_000_000;
    const trees = Array.from({ length: 10 }, (_, i) => artifact(`/p${i}/node_modules`, 5 * GB, {
      cloneSize: 5 * GB,
      clonePrivateSize: 0,
      cloneInternalSize: 0,
      cloneSharedSize: 5 * GB,
      cloneSharedBlocks: (5 * GB) / 50,
      sharedRoots: 9,
      sharedWith: [],
    }));
    expect(summarizeDevSharing(trees)).toMatchObject({
      totalBytes: 50 * GB,
      freesBytes: 0,
      freesAtMostBytes: GB,
      sharedBytes: 50 * GB,
      sharedBlocks: GB,
    });
    // Half the list: at most 0.5 GB, and in fact nothing comes back
    // until the other half goes too.
    expect(summarizeDevSharing(trees.slice(0, 5)).freesAtMostBytes).toBe(GB / 2);
  });
});

describe("summarizeScanSharing", () => {
  it("returns null without measurements and clamps the rest", () => {
    expect(summarizeScanSharing(undefined)).toBeNull();
    expect(summarizeScanSharing({
      measuredFiles: 0, measuredBytes: 0, cloneFiles: 0, cloneBytes: 0, clonePrivateBytes: 0, cloneDuplicateBytes: null,
    })).toBeNull();
    // Real ~/github scan numbers.
    expect(summarizeScanSharing({
      measuredFiles: 623248,
      measuredBytes: 235394420736,
      cloneFiles: 26066,
      cloneBytes: 11298471936,
      clonePrivateBytes: 0,
      cloneDuplicateBytes: 3631394816,
    })).toEqual({
      measuredBytes: 235394420736,
      cloneBytes: 11298471936,
      cloneFiles: 26066,
      clonePrivateBytes: 0,
      duplicateBytes: 3631394816,
      sharedBytes: 11298471936,
      approximate: false,
    });
  });
});

describe("snapshots", () => {
  it("drops OS-update snapshots, which never hold user files", () => {
    const r = report(["com.apple.os.update-AAAA", "com.apple.TimeMachine.2026-09-24-003521.local"]);
    expect(userDataSnapshots(r).map((s) => s.kind)).toEqual(["time-machine"]);
    expect(userDataSnapshots(null)).toEqual([]);
  });

  it("builds a delete command only for Time Machine snapshots", () => {
    const [tm] = report(["com.apple.TimeMachine.2026-09-24-003521.local"]).snapshots;
    expect(deleteSnapshotCommand(tm!)).toBe("tmutil deletelocalsnapshots 2026-09-24-003521");
    const [other] = report(["com.bombich.ccc.1"]).snapshots;
    expect(deleteSnapshotCommand(other!)).toBeNull();
  });

  it("labels ages coarsely", () => {
    expect(ageLabel(20_000)).toBe("just now");
    expect(ageLabel(5 * 60_000)).toBe("5 min ago");
    expect(ageLabel(21.4 * 3_600_000)).toBe("21 h ago");
    expect(ageLabel(72 * 3_600_000)).toBe("3 d ago");
  });
});

describe("explainFreedShortfall", () => {
  const fmt = (n: number) => `${Math.round(n / MiB)}M`;

  it("stays quiet when the delete freed about what was expected", () => {
    expect(explainFreedShortfall({
      expectedBytes: GiB, freeBefore: 10 * GiB, freeAfter: 10 * GiB + 900 * MiB, report: null,
    })).toBeNull();
  });

  it("stays quiet for small deletes and unknown free space", () => {
    expect(explainFreedShortfall({ expectedBytes: 64 * MiB, freeBefore: 0, freeAfter: 0, report: null })).toBeNull();
    expect(explainFreedShortfall({ expectedBytes: GiB, freeBefore: null, freeAfter: 0, report: null })).toBeNull();
  });

  it("blames a local Time Machine snapshot when one exists", () => {
    const out = explainFreedShortfall({
      expectedBytes: 2 * GiB,
      freeBefore: 10 * GiB,
      freeAfter: 10 * GiB,
      report: report(["com.apple.TimeMachine.2026-09-24-003521.local", "com.apple.os.update-AAAA"]),
      now: NOW,
    }, fmt)!;
    expect(out.freedBytes).toBe(0);
    expect(out.title).toBe("Free space didn't go up after deleting 2048M");
    expect(out.body).toMatch(/^A local Time Machine snapshot \(newest 21 h ago\) may still reference/);
    expect(out.body).toMatch(/about 24 hours/);
    // Clone sharing unknown for these paths → named as the other cause.
    expect(out.body).toMatch(/Or the files were APFS clones/);
  });

  it("does not hedge about clones when the Dev view measured none", () => {
    const out = explainFreedShortfall({
      expectedBytes: 2 * GiB,
      freeBefore: 10 * GiB,
      freeAfter: 10 * GiB,
      report: report(["com.apple.TimeMachine.2026-09-24-003521.local"]),
      sharedBytes: 0,
      now: NOW,
    }, fmt)!;
    expect(out.body).not.toMatch(/APFS clones/);
  });

  it("names clone sharing alongside snapshots and reports partial frees", () => {
    // 1 GiB should have come back; only 100 MiB did.
    const out = explainFreedShortfall({
      expectedBytes: 4 * GiB,
      freeBefore: 10 * GiB,
      freeAfter: 10 * GiB + 100 * MiB,
      report: report(["com.bombich.ccc.1", "com.apple.TimeMachine.2026-09-24-003521.local"]),
      sharedBytes: 3 * GiB,
      now: NOW,
    }, fmt)!;
    expect(out.title).toBe("Only 100M of 4096M came back as free space");
    expect(out.body).toMatch(/^2 local snapshots/);
    expect(out.body).toMatch(/3072M of it was APFS clone copies/);
  });

  it("stays quiet when measured clone sharing already predicted the shortfall", () => {
    // Dev confirm said "Frees ≈ 248 KB" for a 466 MB pnpm node_modules.
    expect(explainFreedShortfall({
      expectedBytes: 466 * MiB,
      freeBefore: 10 * GiB,
      freeAfter: 10 * GiB + 248 * 1024,
      report: report(["com.apple.TimeMachine.2026-09-24-003521.local"]),
      sharedBytes: 466 * MiB - 248 * 1024,
      now: NOW,
    })).toBeNull();
    // Half of what should have come back did: also quiet.
    expect(explainFreedShortfall({
      expectedBytes: 4 * GiB,
      freeBefore: 10 * GiB,
      freeAfter: 10 * GiB + 512 * MiB,
      report: null,
      sharedBytes: 3 * GiB,
    })).toBeNull();
  });

  it("falls back to a generic reason with nothing to point at", () => {
    const out = explainFreedShortfall({
      expectedBytes: GiB, freeBefore: 10 * GiB, freeAfter: 10 * GiB - MiB, report: report([]),
    }, fmt)!;
    expect(out.title).toMatch(/didn't go up/);
    expect(out.body).toMatch(/APFS clone of the deleted files/);
  });
});
