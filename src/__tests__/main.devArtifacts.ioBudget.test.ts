import "node:fs";
import "node:fs/promises";

import { beforeAll, describe, expect, it, vi } from "vitest";

import type { DevArtifactReport } from "../shared/contracts";
import { expectIoBudget, measureFsIo } from "../test/ioBudget";
import { bootMainProcess, type MainProcess } from "../test/mainProcessHarness";
import { hostRoot, seedProfile } from "../test/mainProfileFixture";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentFsPromises(await importOriginal()));
vi.mock("node:child_process", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentChildProcess(await importOriginal()));
vi.mock("node:worker_threads", async (importOriginal) =>
  (await import("../test/ioBudget")).instrumentWorkerThreads(await importOriginal()));
vi.mock("electron", async () =>
  (await import("../test/mainProcessHarness")).fakeElectron());

const PROJECTS = hostRoot("/Volumes/Projects");
/** The scanner found no dev trees: its sidecar has no roots. */
const PHOTOS = hostRoot("/Volumes/Photos");
/** No Dev sidecar and no folder tree to classify from (a pre-sidecar scan). */
const OLD = hostRoot("/Volumes/Old");
/** No Dev sidecar; classifying the folder tree in a worker fails. */
const BROKEN = hostRoot("/Volumes/Broken");

let main: MainProcess;

beforeAll(async () => {
  main = await bootMainProcess({
    seed: (userData) => seedProfile(userData, {
      roots: [
        { rootPath: PROJECTS, scans: 2 },
        { rootPath: PHOTOS, scans: 2, devSidecar: "empty" },
        { rootPath: OLD, scans: 2, devSidecar: "missing", folderTree: false },
        { rootPath: BROKEN, scans: 2, devSidecar: "missing" },
      ],
    }).then(() => undefined),
  });
}, 60_000);

/**
 * Overview's Dev summary (sidecar only), then the Dev tab: sidecar
 * first, and the full load when the sidecar had nothing useful.
 */
async function mountOverviewAndDev(rootPath: string): Promise<DevArtifactReport | null> {
  await main.invoke("diskhound:get-dev-artifacts", rootPath, { sidecarOnly: true });
  const fast = await main.invoke<DevArtifactReport | null>("diskhound:get-dev-artifacts", rootPath, { sidecarOnly: true });
  if (fast && fast.artifacts.length > 0) return fast;
  return main.invoke<DevArtifactReport | null>("diskhound:get-dev-artifacts", rootPath);
}

describe.each([
  { rootPath: PROJECTS, label: "with-artifacts", what: "a drive with node_modules trees", firstNote: "reads the Dev sidecar and the previous scan's (for deltas) once; the pending-sidecar dir is listed only when a sidecar is missing" },
  { rootPath: PHOTOS, label: "empty", what: "a drive whose Dev sidecar lists no trees", firstNote: "reads the Dev sidecar and the previous scan's once" },
  { rootPath: OLD, label: "missing", what: "a scan with no Dev sidecar and no folder tree", firstNote: "finds no sidecar (1 failed read, 1 listing of the pending-sidecar dir) and no folder tree to classify from" },
  { rootPath: BROKEN, label: "classify-fails", what: "a scan with no Dev sidecar whose folder-tree classify fails", firstNote: "tries the folder-tree classify worker once (the bundled worker is not built under vitest, so it fails the way a crash does) and logs it" },
])("Overview and Dev on $what", ({ rootPath, label, firstNote }) => {
  it("reads once, then serves every later tab switch from memory", async () => {
    const first = await measureFsIo(() => mountOverviewAndDev(rootPath), { countProcesses: true });
    if (label === "with-artifacts") expect(first.result?.artifacts.length).toBeGreaterThan(0);
    expectIoBudget({
      scenario: `main-dev-artifacts-${label}-first`,
      note: `first Overview + Dev tab mount: ${firstNote}`,
      io: first.io,
    });

    const again = await measureFsIo(async () => {
      for (let i = 0; i < 10; i++) await mountOverviewAndDev(rootPath);
    }, { countProcesses: true });
    expectIoBudget({
      scenario: `main-dev-artifacts-${label}-remount`,
      note: "10 more Overview + Dev tab mounts for the same scan: 0 reads, 0 workers",
      io: again.io,
    });
  });
});
