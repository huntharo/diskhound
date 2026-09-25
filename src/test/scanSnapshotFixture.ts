import { createIdleScanSnapshot, type ScanSnapshot } from "../shared/contracts";

/**
 * A finished scan at the scanner's default caps: 5,000 largest files
 * and 10,000 hottest directories (scanWorker.ts). That is the size a
 * real drive scan persists, so bytes recorded from it are the ones
 * that belong in a MB/day projection.
 */
export function completedScanSnapshot(rootPath: string, finishedAt: number): ScanSnapshot {
  const largestFiles = Array.from({ length: 5_000 }, (_, i) => {
    const parentPath = `${rootPath}/Users/someone/Projects/workspace-${i % 97}/node_modules/package-${i % 311}/dist`;
    const name = `bundle-${i}.min.js`;
    return {
      path: `${parentPath}/${name}`,
      name,
      parentPath,
      extension: ".js",
      size: 1_000_000_000 - i * 1_000,
      modifiedAt: finishedAt - i * 60_000,
    };
  });
  const hottestDirectories = Array.from({ length: 10_000 }, (_, i) => ({
    path: `${rootPath}/Users/someone/Projects/workspace-${i % 97}/node_modules/package-${i}`,
    size: 50_000_000_000 - i * 1_000,
    fileCount: 10_000 - i,
    depth: 6,
  }));
  const topExtensions = Array.from({ length: 12 }, (_, i) => ({
    extension: `.ext${i}`,
    size: 10_000_000_000 - i,
    count: 100_000 - i,
  }));
  return {
    ...createIdleScanSnapshot(),
    status: "done",
    engine: "native-sidecar",
    rootPath,
    startedAt: finishedAt - 90_000,
    finishedAt,
    elapsedMs: 90_000,
    filesVisited: 2_500_000,
    directoriesVisited: 400_000,
    bytesSeen: 900_000_000_000,
    largestFiles,
    hottestDirectories,
    topExtensions,
    lastUpdatedAt: finishedAt,
    scanPhase: "complete",
  };
}
