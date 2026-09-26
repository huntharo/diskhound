import "node:fs";
import "node:fs/promises";

import { beforeAll, describe, expect, it, vi } from "vitest";

import type { IndexSearchResult } from "../shared/scanIndex";
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

const ROOT = hostRoot("/Volumes/Data");

let main: MainProcess;

beforeAll(async () => {
  main = await bootMainProcess({
    seed: (userData) => seedProfile(userData, { roots: [{ rootPath: ROOT, scans: 2 }] }).then(() => undefined),
  });
}, 60_000);

/** App.tsx sends one search-index per pause in typing (220 ms debounce, 2+ characters). */
function search(query: string): Promise<IndexSearchResult> {
  return main.invoke<IndexSearchResult>("diskhound:search-index", ROOT, { query, limit: 400 });
}

describe("search box", () => {
  it("costs one pass over the scan index per query", async () => {
    const { result, io } = await measureFsIo(async () => {
      for (const query of ["re", "rep", "report", "report-1", "report", ".png"]) await search(query);
      return search("report");
    }, { countProcesses: true });

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((hit) => hit.path.toLowerCase().includes("report"))).toBe(true);
    expectIoBudget({
      scenario: "main-search-typing",
      note: "7 queries as a user types, refines, backs up and repeats one: each streams, gunzips and parses the whole index (~330 MB gz at 7M files)",
      io,
    });
  });
});
