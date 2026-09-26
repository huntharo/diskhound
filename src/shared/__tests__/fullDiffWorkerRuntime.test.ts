import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FullFileChange } from "../contracts";
import type { FullDiffSortJob, FullDiffWorkerInput } from "../fullDiffWorkerProtocol";
import { computeFullDiffFromIndexFiles, sortIndexIntoRuns } from "../fullDiffWorkerRuntime";
import { indexFilePath, initScanIndex, openIndexWriter } from "../scanIndex";

let tempDir: string;

beforeEach(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-full-diff-worker-"));
  initScanIndex(tempDir);
});

afterEach(async () => {
  await FSP.rm(tempDir, { recursive: true, force: true });
});

async function writeIndex(
  id: string,
  lines: Array<Record<string, unknown> | string>,
): Promise<string> {
  const filePath = indexFilePath(id);
  const { stream, finalize } = openIndexWriter(filePath);

  for (const line of lines) {
    stream.write(typeof line === "string" ? line : `${JSON.stringify(line)}\n`);
  }

  await finalize();
  return filePath;
}

describe("computeFullDiffFromIndexFiles", () => {
  it("computes a full diff while keeping only the smaller side in memory", async () => {
    const baselinePath = await writeIndex("baseline", [
      { p: "C:\\alpha.bin", s: 100, m: 1 },
      { p: "C:\\beta.bin", s: 1000, m: 1 },
      { p: "C:\\gone.log", s: 500, m: 1 },
    ]);

    const currentPath = await writeIndex("current", [
      { p: "C:\\alpha.bin", s: 100, m: 2 },
      { p: "C:\\beta.bin", s: 3000, m: 2 },
      { p: "C:\\new.iso", s: 7000, m: 2 },
    ]);

    const result = await computeFullDiffFromIndexFiles({
      baselineId: "baseline",
      currentId: "current",
      baselinePath,
      currentPath,
      limit: 10,
      caseSensitive: false,
    });

    expect(result).not.toBeNull();
    expect(result?.totalChanges).toBe(3);
    expect(result?.totalAdded).toBe(1);
    expect(result?.totalRemoved).toBe(1);
    expect(result?.totalGrew).toBe(1);
    expect(result?.totalShrank).toBe(0);
    expect(result?.totalBytesAdded).toBe(9000);
    expect(result?.totalBytesRemoved).toBe(500);
    expect(result?.changes.map((change) => [change.path, change.kind])).toEqual([
      ["C:\\new.iso", "added"],
      ["C:\\beta.bin", "grew"],
      ["C:\\gone.log", "removed"],
    ]);
  });

  it("ignores extra hardlink records so occupancy is not double-counted", async () => {
    const baselinePath = await writeIndex("baseline-hardlink", [
      { p: "C:\\a\\file.bin", s: 1000, m: 1 },
      { p: "C:\\b\\file.bin", s: 1000, m: 1, h: 1 },
    ]);
    const currentPath = await writeIndex("current-hardlink", [
      { p: "C:\\a\\file.bin", s: 1000, m: 2 },
      { p: "C:\\b\\file.bin", s: 1000, m: 2, h: 1 },
    ]);
    const result = await computeFullDiffFromIndexFiles({
      baselineId: "baseline-hardlink",
      currentId: "current-hardlink",
      baselinePath,
      currentPath,
      caseSensitive: false,
    });
    expect(result?.totalChanges).toBe(0);
    expect(result?.totalBytesAdded).toBe(0);
    expect(result?.totalBytesRemoved).toBe(0);
  });

  it("ignores malformed lines and directory records", async () => {
    const baselinePath = await writeIndex("baseline-noisy", [
      { p: "C:\\folder", t: "d", m: 1 },
      { p: "C:\\same.txt", s: 100, m: 1 },
      "this is not json\n",
    ]);

    const currentPath = await writeIndex("current-noisy", [
      { p: "C:\\folder", t: "d", m: 2 },
      { p: "C:\\same.txt", s: 100, m: 2 },
      { p: "C:\\new.txt", s: 50, m: 2 },
    ]);

    const result = await computeFullDiffFromIndexFiles({
      baselineId: "baseline-noisy",
      currentId: "current-noisy",
      baselinePath,
      currentPath,
      caseSensitive: false,
    });

    expect(result?.totalChanges).toBe(1);
    expect(result?.changes[0]).toMatchObject({
      path: "C:\\new.txt",
      kind: "added",
      deltaBytes: 50,
    });
  });

  it("caps the returned changes while preserving totals", async () => {
    const baselinePath = await writeIndex("baseline-limit", []);
    const currentPath = await writeIndex(
      "current-limit",
      Array.from({ length: 8 }, (_, index) => ({
        p: `C:\\file-${index}.bin`,
        s: (index + 1) * 100,
        m: index + 1,
      })),
    );

    const result = await computeFullDiffFromIndexFiles({
      baselineId: "baseline-limit",
      currentId: "current-limit",
      baselinePath,
      currentPath,
      limit: 3,
      caseSensitive: false,
    });

    expect(result?.totalChanges).toBe(8);
    expect(result?.changes).toHaveLength(3);
    expect(result?.truncated).toBe(true);
    expect(result?.changes.map((change) => change.path)).toEqual([
      "C:\\file-7.bin",
      "C:\\file-6.bin",
      "C:\\file-5.bin",
    ]);
  });

  it("supports case-sensitive and case-insensitive diffing explicitly", async () => {
    const baselinePath = await writeIndex("baseline-case", [
      { p: "/tmp/Readme.md", s: 10, m: 1 },
    ]);
    const currentPath = await writeIndex("current-case", [
      { p: "/tmp/readme.md", s: 20, m: 2 },
    ]);

    const insensitive = await computeFullDiffFromIndexFiles({
      baselineId: "baseline-case",
      currentId: "current-case",
      baselinePath,
      currentPath,
      caseSensitive: false,
    });
    expect(insensitive?.totalChanges).toBe(1);
    expect(insensitive?.changes[0]).toMatchObject({
      kind: "grew",
      path: "/tmp/readme.md",
      previousSize: 10,
      size: 20,
    });

    const sensitive = await computeFullDiffFromIndexFiles({
      baselineId: "baseline-case",
      currentId: "current-case",
      baselinePath,
      currentPath,
      caseSensitive: true,
    });
    expect(sensitive?.totalChanges).toBe(2);
    expect(sensitive?.totalAdded).toBe(1);
    expect(sensitive?.totalRemoved).toBe(1);
  });

  it("treats a missing baseline index as empty", async () => {
    const currentPath = await writeIndex("current-only", [
      { p: "/data/a.bin", s: 10, m: 1 },
      { p: "/data/b.bin", s: 20, m: 1 },
    ]);
    const result = await computeFullDiffFromIndexFiles({
      baselineId: "missing-baseline",
      currentId: "current-only",
      baselinePath: Path.join(tempDir, "scan-indexes", "missing-baseline.ndjson.gz"),
      currentPath,
      caseSensitive: true,
    });
    expect(result).toMatchObject({ totalChanges: 2, totalAdded: 2, totalBytesAdded: 30 });
  });

  it.each([1, 120_000])("pairs a key that repeats on one side in index order (%i-record runs)", async (sortChunkRecords) => {
    // Case-insensitive keys collide: both baseline records sort under
    // "c:\\dup.txt", in index order, and the current record pairs with
    // the first of them.
    const baselinePath = await writeIndex(`baseline-dup-${sortChunkRecords}`, [
      { p: "C:\\Dup.txt", s: 10, m: 1 },
      { p: "C:\\other.txt", s: 5, m: 1 },
      { p: "C:\\dup.txt", s: 20, m: 1 },
    ]);
    const currentPath = await writeIndex(`current-dup-${sortChunkRecords}`, [
      { p: "C:\\other.txt", s: 5, m: 2 },
      { p: "C:\\DUP.TXT", s: 20, m: 2 },
    ]);
    const result = await computeFullDiffFromIndexFiles({
      baselineId: `baseline-dup-${sortChunkRecords}`,
      currentId: `current-dup-${sortChunkRecords}`,
      baselinePath,
      currentPath,
      caseSensitive: false,
      sortChunkRecords,
    });
    expect(result).toMatchObject({
      totalChanges: 2,
      totalGrew: 1,
      totalRemoved: 1,
      totalBytesAdded: 10,
      totalBytesRemoved: 20,
    });
    expect(result?.changes.map((change) => [change.path, change.kind, change.deltaBytes])).toEqual([
      ["C:\\dup.txt", "removed", -20],
      ["C:\\DUP.TXT", "grew", 10],
    ]);
  });

  it.each([
    { caseSensitive: true, windows: false },
    { caseSensitive: false, windows: true },
  ])("matches a Map-based diff of random indexes (caseSensitive $caseSensitive)", async ({ caseSensitive, windows }) => {
    const { baselineLines, currentLines, expected } = randomIndexPair(caseSensitive, windows, 7);
    const id = `random-${caseSensitive}`;
    const result = await computeFullDiffFromIndexFiles({
      baselineId: `${id}-a`,
      currentId: `${id}-b`,
      baselinePath: await writeIndex(`${id}-a`, baselineLines),
      currentPath: await writeIndex(`${id}-b`, currentLines),
      caseSensitive,
      limit: 1_000_000,
      // Hundreds of runs per side, so the merge sees many at once.
      sortChunkRecords: 7,
    });

    expect(result).not.toBeNull();
    const { changes, ...totals } = result!;
    expect(totals).toEqual({ ...expected.totals, baselineId: `${id}-a`, currentId: `${id}-b`, truncated: false });
    expect(canonical(changes)).toEqual(canonical(expected.changes));
    expect(expected.totals.totalChanges).toBeGreaterThan(300);
  });

  describe("with the baseline sorted elsewhere", () => {
    async function pair(id: string, files: number): Promise<FullDiffWorkerInput> {
      const lines = (seed: number) => Array.from({ length: files }, (_, i) => ({ p: `/data/f${i}.bin`, s: i % seed === 0 ? i + 1 : i, m: 1 }));
      return {
        baselineId: `${id}-a`,
        currentId: `${id}-b`,
        baselinePath: await writeIndex(`${id}-a`, lines(7)),
        currentPath: await writeIndex(`${id}-b`, lines(5)),
        caseSensitive: true,
        sortChunkRecords: 10,
      };
    }
    const tempDirOf = (input: FullDiffWorkerInput) =>
      Path.join(OS.tmpdir(), `diskhound-diff-${input.baselineId}-${input.currentId}-${process.pid}`);

    it("hands it the baseline and sorts the current index here", async () => {
      const input = await pair("elsewhere", 500);
      const jobs: FullDiffSortJob[] = [];
      const result = await computeFullDiffFromIndexFiles(input, {
        sortElsewhere: (job, signal) => {
          jobs.push(job);
          return sortIndexIntoRuns(job, signal);
        },
      });
      expect(jobs.map((job) => job.indexPath)).toEqual([input.baselinePath]);
      expect(result).toEqual(await computeFullDiffFromIndexFiles(input));
      expect(result?.totalChanges).toBeGreaterThan(0);
      expect(FS.existsSync(tempDirOf(input))).toBe(false);
    });

    it("stops sorting here and removes the runs when the other side fails", async () => {
      const input = await pair("elsewhere-fails", 5_000);
      let signal: AbortSignal | undefined;
      await expect(computeFullDiffFromIndexFiles(input, {
        sortElsewhere: async (_job, sortSignal) => {
          signal = sortSignal;
          throw new Error("Full diff worker out of memory");
        },
      })).rejects.toThrow("Full diff worker out of memory");
      expect(signal?.aborted).toBe(true);
      expect(FS.existsSync(tempDirOf(input))).toBe(false);
    });

    it("stops the other side when the current index is unreadable", async () => {
      const input = await pair("current-corrupt", 50);
      await FSP.writeFile(input.currentPath, "not gzip");
      let stopped = false;
      await expect(computeFullDiffFromIndexFiles(input, {
        sortElsewhere: (_job, signal) => new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            stopped = true;
            reject(signal.reason);
          });
        }),
      })).rejects.toThrow(/header/);
      expect(stopped).toBe(true);
      expect(FS.existsSync(tempDirOf(input))).toBe(false);
    });
  });

  it("returns null when neither index exists", async () => {
    const result = await computeFullDiffFromIndexFiles({
      baselineId: "missing-a",
      currentId: "missing-b",
      baselinePath: Path.join(tempDir, "scan-indexes", "missing-a.ndjson.gz"),
      currentPath: Path.join(tempDir, "scan-indexes", "missing-b.ndjson.gz"),
      caseSensitive: false,
    });

    expect(result).toBeNull();
  });
});

/** Deterministic pseudo-random numbers in [0, 1). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/**
 * Name parts that exercise the index reader: JSON escapes (quote,
 * backslash, newline, tab), non-ASCII, a surrogate pair, a lone
 * surrogate (which JSON writes as \ud800), and mixed case.
 */
const NAME_PARTS = ["alpha", "Beta", "gamma delta", "caf\u00e9", "\u65e5\u672c", "\ud83d\ude00", "lone\ud800", 'say "hi"', "back\\slash", "new\nline", "tab\there", "MiXeD", "x"];

function canonical(changes: FullFileChange[]): string[] {
  return changes
    .map((change) => JSON.stringify([change.path, change.kind, change.size, change.previousSize, change.deltaBytes]))
    .sort();
}

/**
 * Two indexes with unique keys per side, written in the shapes the
 * scanner and older builds produce, and the diff a Map lookup gives.
 */
function randomIndexPair(caseSensitive: boolean, windows: boolean, seed: number) {
  const rand = lcg(seed);
  const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!;
  const sep = windows ? "\\" : "/";
  const keyOf = (path: string) => {
    const trimmed = path.replace(/[\\/]+$/, "");
    return caseSensitive ? trimmed : trimmed.toLowerCase();
  };
  const randomPath = () => {
    const parts = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => `${pick(NAME_PARTS)}${Math.floor(rand() * 40)}`);
    const path = `${windows ? "C:" : ""}${sep}${parts.join(sep)}`;
    return rand() < 0.03 ? `${path}${sep}` : path;
  };
  const randomSize = () => pick([0, 1, 4096, 2 ** 53 - 1, 10 ** 15, Math.floor(rand() * 1e9)]);

  const baseline = new Map<string, { p: string; s: number }>();
  while (baseline.size < 1_500) {
    const p = randomPath();
    if (!baseline.has(keyOf(p))) baseline.set(keyOf(p), { p, s: randomSize() });
  }
  const current = new Map<string, { p: string; s: number }>();
  for (const [key, record] of baseline) {
    const roll = rand();
    if (roll < 0.1) continue;
    current.set(key, roll < 0.2 ? { p: record.p, s: randomSize() } : record);
  }
  while (current.size < baseline.size + 50) {
    const p = randomPath();
    if (!current.has(keyOf(p)) && !baseline.has(keyOf(p))) current.set(keyOf(p), { p, s: randomSize() });
  }

  const noise = () => {
    const roll = rand();
    if (roll < 0.3) return { p: randomPath(), t: "d", m: 1 };
    if (roll < 0.5) return { p: `${randomPath()}.link`, s: 7, m: 1, h: 1 };
    if (roll < 0.7) return "not json at all\n";
    if (roll < 0.85) return `{"p":"${sep}cut","s":12\n`;
    return { m: 1, t: "d", p: randomPath() };
  };
  const lines = (records: Map<string, { p: string; s: number }>) => {
    const out: Array<Record<string, unknown> | string> = [];
    for (const { p, s } of records.values()) {
      const roll = rand();
      if (roll < 0.1) out.push(noise());
      if (roll < 0.8) out.push({ p, s, m: 1_700_000_000_000 });
      else if (roll < 0.9) out.push({ p, s, m: 1, v: 0, k: 1 });
      else out.push({ m: 1, s, p });
    }
    return out;
  };

  const changes: FullFileChange[] = [];
  for (const [key, before] of baseline) {
    const after = current.get(key);
    if (!after) {
      changes.push({ path: before.p, kind: "removed", size: 0, previousSize: before.s, deltaBytes: -before.s });
    } else if (after.s !== before.s) {
      const deltaBytes = after.s - before.s;
      changes.push({ path: after.p, kind: deltaBytes > 0 ? "grew" : "shrank", size: after.s, previousSize: before.s, deltaBytes });
    }
  }
  for (const [key, after] of current) {
    if (!baseline.has(key)) changes.push({ path: after.p, kind: "added", size: after.s, previousSize: 0, deltaBytes: after.s });
  }
  // Byte totals pass 2^53 here, where a float sum depends on the order
  // of its terms. Sum in key order, the order the merge adds them.
  changes.sort((a, b) => (keyOf(a.path) < keyOf(b.path) ? -1 : keyOf(a.path) > keyOf(b.path) ? 1 : 0));
  const totals = {
    totalChanges: changes.length,
    totalAdded: 0,
    totalRemoved: 0,
    totalGrew: 0,
    totalShrank: 0,
    totalBytesAdded: 0,
    totalBytesRemoved: 0,
  };
  for (const change of changes) {
    if (change.kind === "added") {
      totals.totalAdded += 1;
      totals.totalBytesAdded += change.size;
    } else if (change.kind === "removed") {
      totals.totalRemoved += 1;
      totals.totalBytesRemoved += change.previousSize;
    } else if (change.kind === "grew") {
      totals.totalGrew += 1;
      totals.totalBytesAdded += change.deltaBytes;
    } else {
      totals.totalShrank += 1;
      totals.totalBytesRemoved += Math.abs(change.deltaBytes);
    }
  }
  return { baselineLines: lines(baseline), currentLines: lines(current), expected: { totals, changes } };
}
