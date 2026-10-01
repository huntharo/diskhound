import { expect, it, vi } from "vitest";
import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { createDevAcc, noteDevFile, reportFromSidecar, sidecarFromAcc } from "../devArtifactSidecar";
import { filterModifiedArtifacts } from "../devArtifactRecency";
vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));
it("filters a full capped report without disk I/O", async () => {
  const acc = createDevAcc();
  for (let i = 0; i < 2500; i++) noteDevFile(acc, `/projects/p${i}/node_modules/index.js`, 1048576, false, 1700000000000);
  const report = reportFromSidecar(sidecarFromAcc(acc, "/projects"));
  const { io } = await measureFsIo(() => {
    for (const window of [24, 48, 168, 0] as const) expect(filterModifiedArtifacts(report.artifacts, window, 1800000000000)).toHaveLength(2500);
  });
  expectIoBudget({ scenario: "dev-artifact-modification-toggle", note: "Four window changes over 2,500 cached artifact roots: no reads or writes. Default off: 0 writes/day, 0 MB/day; even toggling every minute: 0 writes/day, 0 MB/day. Scan aggregates add bytes to the existing sidecar, no new persistence events.", io });
});
