import "node:fs";
import "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DevArtifactReport } from "../shared/contracts";
import type { DevArtifactRootRec } from "../shared/devArtifactSidecar";
import { expectIoBudget, measureFsIo } from "../test/ioBudget";
import { bootMainProcess, type MainProcess } from "../test/mainProcessHarness";
import { seedProfile } from "../test/mainProfileFixture";

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
vi.mock("../shared/crashLog", async (importOriginal) =>
  (await import("../test/mainProcessHarness")).settledCrashLog(await importOriginal()));

/** A developer's clone folder: 40 repos, the last 8 made with `git init` and never pushed. */
const REPOS = 40;
const LOCAL_ONLY = 8;

let main: MainProcess;
let root: string;
let repoGitDirs: string[];

/** A `.git/config` the size `git clone` writes, with a branch or two tracked. */
function configFor(i: number): string {
  const core = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n\tignorecase = true\n\tprecomposeunicode = true\n";
  if (i >= REPOS - LOCAL_ONLY) return core;
  return core
    + `[remote "origin"]\n\turl = git@github.com:someone/project-${i}.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
    + "[branch \"main\"]\n\tremote = origin\n\tmerge = refs/heads/main\n"
    + (i % 3 === 0 ? `[remote "upstream"]\n\turl = https://github.com/upstream/project-${i}.git\n\tfetch = +refs/heads/*:refs/remotes/upstream/*\n` : "");
}

beforeAll(async () => {
  // Real files for the repos, written with the host fs before the
  // measured fs is in play for main.
  const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  root = realFs.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-git-budget-"));
  repoGitDirs = [];
  const devRoots: DevArtifactRootRec[] = [];
  for (let i = 0; i < REPOS; i++) {
    const gitDir = Path.join(root, "github", `project-${i}`, ".git");
    realFs.mkdirSync(gitDir, { recursive: true });
    realFs.writeFileSync(Path.join(gitDir, "config"), configFor(i));
    realFs.writeFileSync(Path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    repoGitDirs.push(gitDir);
    devRoots.push({ path: gitDir, kind: "git-repo", size: 50_000_000 + i * 10_000_000, files: 2_000 + i });
  }
  main = await bootMainProcess({
    seed: (userData) => seedProfile(userData, {
      roots: [{ rootPath: root, scans: 2, devRoots }],
    }).then(() => undefined),
  });
}, 60_000);

afterAll(async () => {
  const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  realFs.rmSync(root, { recursive: true, force: true });
});

async function mountOverviewAndDev(): Promise<DevArtifactReport | null> {
  await main.invoke("diskhound:get-dev-artifacts", root, { sidecarOnly: true });
  return main.invoke<DevArtifactReport | null>("diskhound:get-dev-artifacts", root, { sidecarOnly: true });
}

describe("Dev Artifacts with Git repos", () => {
  it("reads each repo's .git/config once, then nothing on remount or after a delete", async () => {
    const first = await measureFsIo(() => mountOverviewAndDev(), { countProcesses: true });
    const repos = first.result?.artifacts.filter((a) => a.kind === "git-repo") ?? [];
    expect(repos).toHaveLength(REPOS);
    expect(repos.filter((a) => a.git?.remotes.length === 0)).toHaveLength(LOCAL_ONLY);
    expect(repos.find((a) => a.path === repoGitDirs[0])?.git).toEqual({
      remotes: ["origin", "upstream"],
      remoteUrl: "github.com/someone/project-0",
      readable: true,
    });
    expectIoBudget({
      scenario: "main-dev-git-repos-first",
      note: `first Overview + Dev tab mount with ${REPOS} repos: the Dev sidecar and the previous scan's, `
        + `plus one .git/config read per repo and no git process. A user with 500 clones reads 500 small `
        + `files once per app run, not per tab switch.`,
      io: first.io,
    });

    const again = await measureFsIo(async () => {
      for (let i = 0; i < 10; i++) await mountOverviewAndDev();
    }, { countProcesses: true });
    expectIoBudget({
      scenario: "main-dev-git-repos-remount",
      note: "10 more Overview + Dev tab mounts: 0 reads, 0 processes",
      io: again.io,
    });

    const forget = await measureFsIo(
      () => main.invoke<DevArtifactReport | null>("diskhound:forget-dev-artifact-paths", root, [repoGitDirs[0]]),
      { countProcesses: true },
    );
    expect(forget.result?.artifacts.some((a) => a.path === repoGitDirs[0])).toBe(false);
    expect(forget.result?.artifacts.find((a) => a.path === repoGitDirs[1])?.git?.remotes).toEqual(["origin"]);
    expectIoBudget({
      scenario: "main-dev-git-repos-forget",
      note: "after a repo is moved to the Trash: read this scan's Dev sidecar and the previous scan's, rewrite this one "
        + "once, and log it; the other repos' remotes come from memory, no .git/config read. One per removal, by hand.",
      io: forget.io,
    });
  });
});
