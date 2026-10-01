import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { DevArtifact } from "../contracts";
import { filterModifiedArtifacts, modificationEligible } from "../devArtifactRecency";
import { createDevAcc, noteDevFile, noteDirectoryRoot, sidecarFromAcc, reportFromSidecar, sidecarFromReport, rescanDevArtifactSidecar, dropSidecarRoots } from "../devArtifactSidecar";

const now = 1_800_000_000_000;
const hour = 3_600_000;
const artifact = (latestFileMtimeMs?: number | null) => ({ latestFileMtimeMs } as DevArtifact);

it("protects boundary, future, unknown and invalid timestamps for every window; defaults off", () => {
  for (const hours of [24, 48, 168] as const) {
    for (const value of [undefined, null, 0, -1, NaN, Infinity, now + hour, now - hours * hour]) {
      expect(modificationEligible(artifact(value), hours, now)).toBe(false);
      expect(modificationEligible(artifact(value), 0, now)).toBe(true);
    }
    expect(modificationEligible(artifact(now - hours * hour - 1), hours, now)).toBe(true);
  }
});

it("rolls nested file mtimes including hardlinks into the outer root and round-trips milliseconds", () => {
  const acc = createDevAcc();
  noteDevFile(acc, "/p/node_modules/old.js", 4096, false, now - 200 * hour);
  noteDevFile(acc, "/p/node_modules/nested/node_modules/new.js", 4096, true, now);
  const report = reportFromSidecar(sidecarFromAcc(acc, "/p"));
  expect(report.artifacts).toHaveLength(1);
  expect(report.artifacts[0].latestFileMtimeMs).toBe(now);
  expect(report.artifacts[0].size).toBe(4096);
  expect(reportFromSidecar(sidecarFromReport(report)).artifacts[0].latestFileMtimeMs).toBe(now);
  expect(filterModifiedArtifacts(report.artifacts, 24, now)).toHaveLength(0);
  noteDevFile(acc, "/p/node_modules/unknown.js", 4096, false);
  noteDevFile(acc, "/p/node_modules/known.js", 4096, false, now);
  expect(sidecarFromAcc(acc, "/p").roots[0].latestFileMtimeMs).toBeNull();
});

it("keeps folder rollups and legacy sidecars unknown", () => {
  const acc = createDevAcc();
  noteDirectoryRoot(acc, "/p/node_modules", 8192, 2);
  const report = reportFromSidecar(sidecarFromAcc(acc, "/p"));
  expect(filterModifiedArtifacts(report.artifacts, 24, now)).toEqual([]);
});

it("refresh recalculates after modification/deletion rather than retaining an obsolete maximum", async () => {
  const root = await mkdtemp(join(tmpdir(), "dev-recency-"));
  try {
    const dir = join(root, "node_modules");
    await mkdir(dir);
    const old = join(dir, "old.js"), recent = join(dir, "recent.js");
    await writeFile(old, Buffer.alloc(4096));
    await writeFile(recent, Buffer.alloc(4096));
    await utimes(old, new Date(now), new Date(now - 200 * hour));
    await utimes(recent, new Date(now), new Date(now));
    const acc = createDevAcc();
    noteDirectoryRoot(acc, dir, 8192, 2);
    let sidecar = await rescanDevArtifactSidecar(sidecarFromAcc(acc, root));
    expect(sidecar.roots[0].latestFileMtimeMs).toBe(now);
    await rm(recent);
    sidecar = await rescanDevArtifactSidecar(sidecar);
    expect(sidecar.roots[0].latestFileMtimeMs).toBe(now - 200 * hour);
    expect(filterModifiedArtifacts(reportFromSidecar(sidecar).artifacts, 168, now)).toHaveLength(1);
    expect(dropSidecarRoots(sidecar, [dir]).roots).toEqual([]);
    await rm(dir, { recursive: true });
    expect((await rescanDevArtifactSidecar(sidecar)).roots).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("reads one cached timestamp per artifact at N and 8N, independent of files per tree", () => {
  const count = (n: number) => {
    let reads = 0;
    const rows = Array.from({ length: n }, () => ({
      get latestFileMtimeMs() { reads++; return now - 200 * hour; },
      get fileCount(): number { throw new Error("filter must not process file collections"); },
    } as DevArtifact));
    expect(filterModifiedArtifacts(rows, 48, now)).toHaveLength(n);
    return reads;
  };
  const small = count(250), large = count(2000);
  expect(large).toBeLessThanOrEqual(small * 16);
  expect(large).toBeLessThanOrEqual(2000);
});


it("uses maximum descendant file mtime for a broad cache root", () => {
  const acc = createDevAcc();
  noteDevFile(acc, "/home/dev/.cache/pip/a/old.whl", 4096, false, now - 200 * hour);
  noteDevFile(acc, "/home/dev/.cache/pip/b/recent.whl", 4096, false, now);
  const report = reportFromSidecar(sidecarFromAcc(acc, "/home/dev"));
  expect(report.artifacts).toHaveLength(1);
  expect(report.artifacts[0].latestFileMtimeMs).toBe(now);
  expect(filterModifiedArtifacts(report.artifacts, 48, now)).toEqual([]);
});
