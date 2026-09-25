import * as Path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeTempDir, writeIndexFixture } from "../../testing/indexFixture";
import { countReads, expectNearLinear, measureOps, measureOpsSync } from "../../testing/opCounter";
import type { CleanupSettings, DirectoryHotspot, ScanFileRecord } from "../contracts";
import { analyzeCleanupFromIndex, analyzeForCleanup } from "../suggestions";

// Operation-count scaling tests: each runs at N and 8N and requires every
// counted category to grow at most ~2× faster than linear, and caps the
// work per file so a large constant (a 250-path sample scan per file)
// fails too.

const SETTINGS: CleanupSettings = {
  autoDetectTempFiles: true,
  autoDetectCaches: true,
  autoDetectOldDownloads: true,
  oldFileThresholdDays: 30,
} as CleanupSettings;

const OLD = Date.now() - 365 * 24 * 60 * 60 * 1000;

/**
 * A path per cleanup rule, cycling: temp, log, cache, browser cache,
 * download, installer, media. Cache files share 200 node_modules roots
 * and 20 browser cache paths, so the cache bucket's 250-path sample never
 * fills and every cache file is checked against it: the case of a Mac or
 * Linux dev machine with a couple of hundred projects.
 */
function pathFor(i: number): { path: string; ext: string; size: number } {
  switch (i % 7) {
    case 0: return { path: `C:\\Users\\dev\\AppData\\Local\\Temp\\job-${i}\\scratch-${i}.tmp`, ext: ".tmp", size: 1_000 };
    case 1: return { path: `C:\\Program Files\\App\\logs\\run-${i}.log`, ext: ".log", size: 2_000 };
    case 2: return { path: `C:\\src\\app-${i % 200}\\node_modules\\pkg\\index-${i}.js`, ext: ".js", size: 3_000 };
    case 3: return { path: `C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\f_${i % 20}`, ext: "(no ext)", size: 4_000 };
    case 4: return { path: `C:\\Users\\dev\\Downloads\\report-${i}.pdf`, ext: ".pdf", size: 5_000 };
    case 5: return { path: `C:\\Users\\dev\\Downloads\\setup-${i}.exe`, ext: ".exe", size: 6_000 };
    default: return { path: `D:\\Video\\clip-${i}.mkv`, ext: ".mkv", size: 200 * 1024 * 1024 };
  }
}

describe("analyzeCleanupFromIndex scaling", () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeAll(async () => {
    tmp = await makeTempDir("suggestions-scaling");
  });

  afterAll(async () => {
    await tmp.cleanup();
  });

  it("buckets each file in a small, fixed amount of work", async () => {
    const run = async (count: number) => {
      const records = Array.from({ length: count }, (_, i) => {
        const { path, size } = pathFor(i);
        return { p: path, s: size, m: OLD };
      });
      const indexPath = writeIndexFixture(Path.join(tmp.dir, `suggest-${count}.ndjson.gz`), records);
      const { result, ops } = await measureOps(() => analyzeCleanupFromIndex("C:\\", indexPath, SETTINGS, ["E:\\Keep"]));
      expect(result.suggestions.length).toBeGreaterThanOrEqual(5);
      for (const suggestion of result.suggestions) {
        expect(suggestion.paths.length).toBeLessThanOrEqual(250);
        expect(new Set(suggestion.paths).size).toBe(suggestion.paths.length);
      }
      return ops;
    };
    const count = 3_500;
    // ~77 ops per file. Checking each cache file against the bucket's
    // sample made it ~225.
    expectNearLinear("analyzeCleanupFromIndex", await run(count), await run(count * 8), {
      maxTotal: count * 8 * 100,
    });
  });
});

describe("analyzeForCleanup scaling", () => {
  it("scans files and folders in linear work", () => {
    const run = (count: number) => {
      const files: ScanFileRecord[] = Array.from({ length: count }, (_, i) => {
        const { path, ext, size } = pathFor(i);
        return {
          path,
          name: Path.win32.basename(path),
          parentPath: Path.win32.dirname(path),
          extension: ext,
          size,
          modifiedAt: OLD,
        };
      });
      const directories: DirectoryHotspot[] = files.map((file, i) => ({
        path: i % 11 === 0 ? `C:\\Users\\u${i}\\AppData\\Local\\Temp\\DiagOutputDir` : file.parentPath,
        size: file.size * 3,
        fileCount: 3,
        depth: 4,
      }));
      const filesIn = countReads(files);
      const dirsIn = countReads(directories);
      return measureOpsSync(() => analyzeForCleanup("C:\\", filesIn, dirsIn, SETTINGS)).ops;
    };
    const count = 1_400;
    // ~190 ops per file and folder, mostly classifyArtifactPath.
    expectNearLinear("analyzeForCleanup", run(count), run(count * 8), { maxTotal: count * 8 * 250 });
  });
});
