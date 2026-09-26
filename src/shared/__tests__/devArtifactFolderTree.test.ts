import { createWriteStream } from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ARTIFACT_SEGMENT_NAMES } from "../devArtifacts";
import { sidecarFromFolderTreeFile, type FolderTreeClassifyStats } from "../devArtifactFolderTree";
import {
  compactDevArtifactSidecar,
  projectCanOwnArtifact,
  reportFromSidecar,
  type DevArtifactSidecar,
} from "../devArtifactSidecar";
import { legacySidecarFromFolderTreeFile } from "./legacyDevArtifactFolderTree";

let tempDir: string;
let treeCount = 0;

beforeEach(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-dev-folder-tree-"));
});

afterEach(async () => {
  await FSP.rm(tempDir, { recursive: true, force: true });
});

type Row = [string, number, number];

/** One line the way both writers emit it. */
function line(k: string, d: Row[], f: Row[] = []): string {
  return JSON.stringify({ k, d, f });
}

/** Gzip raw text (lines and their endings) into a folder-tree sidecar. */
async function writeTree(text: string | Iterable<string>): Promise<string> {
  const treePath = Path.join(tempDir, `tree-${treeCount++}.folder-tree.ndjson.gz`);
  const chunks = typeof text === "string" ? [text] : text;
  await pipeline(Readable.from(chunks), createGzip({ level: 1 }), createWriteStream(treePath));
  return treePath;
}

async function classify(treePath: string, root: string) {
  const stats = {} as FolderTreeClassifyStats;
  const sidecar = await sidecarFromFolderTreeFile(treePath, root, stats);
  return { sidecar, stats };
}

const unstamped = (sidecar: DevArtifactSidecar): DevArtifactSidecar => ({ ...sidecar, generatedAt: 0 });

/**
 * Classify with both readers and require the same roots, the same
 * compacted sidecar (what gets written) and the same report (what Dev
 * shows). The raw project list may only lose projects that sit inside an
 * artifact tree, which compaction drops anyway.
 */
async function expectSameAsLegacy(text: string, root: string): Promise<DevArtifactSidecar> {
  const treePath = await writeTree(text);
  const legacy = await legacySidecarFromFolderTreeFile(treePath, root);
  const { sidecar } = await classify(treePath, root);
  expect(legacy).not.toBeNull();
  expect(sidecar).not.toBeNull();
  const before = unstamped(legacy!);
  const after = unstamped(sidecar!);
  expect(after.roots).toEqual(before.roots);
  expect(compactDevArtifactSidecar(after)).toEqual(compactDevArtifactSidecar(before));
  expect(reportFromSidecar(after)).toEqual(reportFromSidecar(before));
  for (const project of before.projects) {
    if (!after.projects.includes(project)) expect(projectCanOwnArtifact(project), project).toBe(false);
  }
  expect(after.projects.filter((p) => !before.projects.includes(p))).toEqual([]);
  return after;
}

describe("sidecarFromFolderTreeFile", () => {
  it("classifies from a folder-tree sidecar without an index", async () => {
    const treePath = await writeTree([
      `${line("C:\\proj", [
        ["C:\\proj\\target", 80_000_000, 400],
        ["C:\\proj\\node_modules", 20_000_000, 100],
      ], [["package.json", 200, 1]])}\n`,
      `${line("C:\\proj\\target", [["C:\\proj\\target\\debug", 50_000_000, 300]])}\n`,
    ]);

    const { sidecar } = await classify(treePath, "C:\\");
    expect(sidecar).not.toBeNull();
    const report = reportFromSidecar(sidecar!);
    expect(report.totalBytes).toBe(100_000_000);
    expect(report.artifacts.map((a) => a.path).sort()).toEqual([
      "C:\\proj\\node_modules",
      "C:\\proj\\target",
    ]);
    expect(report.projectCount).toBe(1);
  });

  it("returns null when the folder-tree sidecar is missing", async () => {
    await expect(sidecarFromFolderTreeFile(Path.join(tempDir, "missing.ndjson.gz"), "C:\\")).resolves.toBeNull();
  });

  it("returns null for a sidecar with no folder entries or no gzip", async () => {
    expect((await classify(await writeTree("\n[1,2]\n{\"x\":1}\nnot json\n"), "/")).sidecar).toBeNull();
    const plain = Path.join(tempDir, "plain.folder-tree.ndjson.gz");
    await FSP.writeFile(plain, `${line("/p", [["/p/node_modules", 1, 1]])}\n`);
    await expect(sidecarFromFolderTreeFile(plain, "/")).resolves.toBeNull();
  });

  it("matches the old reader on a Windows tree", async () => {
    const after = await expectSameAsLegacy([
      line("C:\\", [["C:\\src", 900, 90], ["C:\\Users", 50, 5]]),
      line("C:\\src\\app", [
        ["C:\\src\\app\\node_modules", 400, 40],
        ["C:\\src\\app\\target", 300, 30],
        ["C:\\src\\app\\Build", 20, 2],
        ["C:\\src\\app\\src", 5, 1],
        ["C:\\src\\app\\empty\\node_modules", 0, 0],
      ], [["README.md", 1, 1], ["Package.JSON", 1, 1700000000000.25]]),
      line("C:\\src\\app\\target", [
        ["C:\\src\\app\\target\\debug", 250, 25],
        ["C:\\src\\app\\target\\Release", 40, 4],
      ]),
      line("C:\\src\\app\\node_modules", [
        ["C:\\src\\app\\node_modules\\preact", 100, 10],
        ["C:\\src\\app\\node_modules\\@scope", 50, 5],
      ]),
      line("C:\\src\\app\\node_modules\\preact", [["C:\\src\\app\\node_modules\\preact\\dist", 60, 6]], [
        ["package.json", 1, 1],
      ]),
      // The same root twice: the larger row wins.
      line("C:\\src\\app", [["C:\\src\\app\\node_modules", 420, 41]]),
      // Quotes, control characters and a lone surrogate take the decode path.
      line("C:\\src\\we\"ird", [
        ["C:\\src\\we\"ird\\node_modules", 70, 7],
        ["C:\\src\\tab\there\\.venv", 60, 6],
        ["C:\\src\\bell\u0007\\__pycache__", 50, 5],
        ["C:\\src\\half\ud800\\dist", 40, 4],
      ], [["cargo.TOML", 1, 1]]),
      line("C:\\src\\tab\there", [], [["pyproject.toml", 1, 1]]),
      // Non-ASCII, including a Kelvin sign that lowercases to "k".
      line("C:\\Users\\zoë\\app", [
        ["C:\\Users\\zoë\\app\\node_modules", 80, 8],
        ["C:\\Users\\zoë\\app\\.wor\u212Atrees", 30, 3],
        ["C:\\Users\\zoë\\app\\.wor\u212Atrees\\feat", 25, 2],
        ["C:\\Users\\zoë\\app\\ñ\\out", 9, 1],
      ], [["PAC\u212AAGE.JSON", 1, 1]]),
      line("C:\\Users\\me\\.cargo", [["C:\\Users\\me\\.cargo\\registry", 500, 50], ["C:\\Users\\me\\.cargo\\bin", 5, 1]]),
      line("C:\\Users\\me\\go\\pkg", [["C:\\Users\\me\\go\\pkg\\mod", 300, 30]]),
      line("C:\\Users\\me\\.cache", [["C:\\Users\\me\\.cache\\ccache", 200, 20], ["C:\\Users\\me\\.cache\\pip", 10, 1]]),
      line("C:\\Windows\\Temp", [["C:\\Windows\\Temp\\DiagOutputDir", 700, 70]]),
      line("C:\\src\\lib", [["C:\\src\\lib\\constructor", 90, 9], ["C:\\src\\lib\\toString", 80, 8]]),
    ].join("\n") + "\n", "C:\\");
    expect(after.roots.map((r) => r.path).sort()).toEqual([
      "C:\\Users\\me\\.cache\\ccache",
      "C:\\Users\\me\\.cargo\\registry",
      "C:\\Users\\me\\go\\pkg\\mod",
      "C:\\Users\\zoë\\app\\.wor\u212Atrees",
      "C:\\Users\\zoë\\app\\node_modules",
      "C:\\Users\\zoë\\app\\ñ\\out",
      "C:\\Windows\\Temp\\DiagOutputDir",
      "C:\\src\\app\\Build",
      "C:\\src\\app\\node_modules",
      "C:\\src\\app\\target",
      "C:\\src\\bell\u0007\\__pycache__",
      "C:\\src\\half\ud800\\dist",
      "C:\\src\\tab\there\\.venv",
      "C:\\src\\we\"ird\\node_modules",
    ]);
    expect(after.roots.find((r) => r.path === "C:\\src\\app\\node_modules")?.size).toBe(420);
    expect(after.projects).toEqual([
      "C:\\src\\app",
      "C:\\src\\we\"ird",
      "C:\\src\\tab\there",
      "C:\\Users\\zoë\\app",
    ]);
  });

  it("matches the old reader on a POSIX tree with odd lines", async () => {
    await expectSameAsLegacy([
      line("/", [["/Users", 900, 90]]),
      line("/Users/me/app", [
        ["/Users/me/app/node_modules", 400, 40],
        ["/Users/me/app/dist", 30, 3],
        ["/Users/me/app/back\\slash", 20, 2],
      ], [["package.json", 1, 1], ["Cargo.toml", 1, 1]]),
      // Another key order and whitespace: JSON.parse reads these.
      `{"d":[["/Users/me/other/target",90,9]],"k":"/Users/me/other","f":[["go.mod",1,1]]}`,
      `{ "k": "/Users/me/spaced", "d": [ ["/Users/me/spaced/.next", 70, 7] ], "f": [] }`,
      // A fourth row element, a negative and a string size.
      `{"k":"/Users/me/wide","d":[["/Users/me/wide/.turbo",60,6,"x"],["/Users/me/wide/build",-5,1],["/Users/me/wide/out","9",1]],"f":[]}`,
      // An escaped solidus, exponent and fraction numbers.
      `{"k":"\\/Users\\/me\\/esc","d":[["\\/Users\\/me\\/esc\\/node_modules",5e2,1.0]],"f":[["gemfile",1,1.5e12]]}`,
      // Lines JSON.parse rejects: skipped by both.
      `{"k":"/Users/me/bad","d":[["/Users/me/bad/node_modules",01,1]],"f":[]}`,
      `{"k":"/Users/me/bad","d":[["/Users/me/bad/node_modules",10,1]],"f":[]}}`,
      `{"k":"/Users/me/bad","d":[["/Users/me/bad/node_\\x","10",1]],"f":[]}`,
      `{"k":"/Users/me/bad","d":[["/Users/me/bad/node_modules",10,1]],"f":[`,
      "123",
      `"a string"`,
      "",
      // CRLF: the old reader dropped the \r, JSON.parse skips it as space.
      `${line("/Users/me/crlf", [["/Users/me/crlf/.gradle", 80, 8]])}\r`,
      line("/srv/mixed", [["/srv/mixed/a/node_modules", 10, 1], ["/srv/mixed/node_modules/", 11, 1]]),
    ].join("\n"), "/");
  });

  it("finds Terraform providers and names them after their lock file's folder", async () => {
    const after = await expectSameAsLegacy([
      line("/Users/me/infra/prod", [["/Users/me/infra/prod/.terraform", 800_003_000, 4]], [
        [".terraform.lock.hcl", 1_000, 1],
        ["main.tf", 500, 1],
      ]),
      line("/Users/me/infra/prod/.terraform", [
        ["/Users/me/infra/prod/.terraform/providers", 800_000_000, 1],
        ["/Users/me/infra/prod/.terraform/modules", 1_000, 1],
      ], [["terraform.tfstate", 2_000, 1]]),
      line("/Users/me/.terraform.d", [
        ["/Users/me/.terraform.d/plugin-cache", 600_000_000, 1],
        ["/Users/me/.terraform.d/plugins", 50_000_000, 1],
      ]),
    ].join("\n"), "/");
    expect(reportFromSidecar(after).artifacts).toEqual([
      expect.objectContaining({
        path: "/Users/me/infra/prod/.terraform/providers",
        kind: "terraform",
        projectName: "prod",
        size: 800_000_000,
      }),
      expect.objectContaining({
        path: "/Users/me/.terraform.d/plugin-cache",
        kind: "terraform",
        projectName: "Unscoped",
        size: 600_000_000,
      }),
    ]);
  });

  it("matches the old reader on random paths built from artifact names", async () => {
    // Guards the reader's shortcut: only rows whose last two segments
    // name an artifact are decoded. Any classifyArtifactPath rule whose
    // root reaches further would show up here as a missing root.
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const artifactNames = [...ARTIFACT_SEGMENT_NAMES, "Node_Modules", "TARGET"];
    // Names that only matter after an artifact name, and plain ones.
    const otherNames = [
      "debug", "release", "doc", "incremental", "registry", "mod", "ccache", "sccache", "yarn", "pnpm",
      "providers", "plugins", "plugin-cache",
      "src", "lib", "feat", "a", "b",
    ];
    const pickName = () => {
      const pool = random() < 0.3 ? artifactNames : otherNames;
      return pool[Math.floor(random() * pool.length)]!;
    };
    const lines: string[] = [];
    for (let i = 0; i < 1_000; i++) {
      const windows = random() < 0.5;
      const sep = windows ? "\\" : "/";
      const rows: Row[] = [];
      for (let r = 0; r < 8; r++) {
        const depth = 1 + Math.floor(random() * 5);
        const segments = Array.from({ length: depth }, pickName);
        rows.push([(windows ? "C:" : "") + sep + ["r", ...segments].join(sep), 1 + Math.floor(random() * 1_000), 1]);
      }
      const files: Row[] = random() < 0.3 ? [["package.json", 1, 1]] : [["x.txt", 1, 1]];
      lines.push(line(`${windows ? "C:" : ""}${sep}r${sep}p${i}`, rows, files));
    }
    const after = await expectSameAsLegacy(lines.join("\n"), "/");
    expect(after.roots.length).toBeGreaterThan(100);
  });

  it("skips a line longer than the cap and reads the rest", async () => {
    const files: Row[] = Array.from({ length: 40_000 }, (_, i) => [`file-${i}.txt`, i, 1]);
    const treePath = await writeTree([
      `${line("/huge", [["/huge/node_modules", 5, 1]], files)}\n`,
      `${line("/ok", [["/ok/node_modules", 7, 1]], [["package.json", 1, 1]])}\n`,
      `${line("/huge2", [["/huge2/target", 9, 1]], files)}`,
    ]);
    const stats = {} as FolderTreeClassifyStats;
    const sidecar = await sidecarFromFolderTreeFile(treePath, "/", stats, 1 << 20);
    expect(stats.skippedLines).toBe(2);
    expect(sidecar!.roots.map((r) => r.path)).toEqual(["/ok/node_modules"]);
    expect(sidecar!.projects).toEqual(["/ok"]);
  });

  it("reads a line longer than a gzip chunk", async () => {
    // 80k files puts the line well past the reader's 1 MB chunks, with
    // the project marker at the far end.
    const files: Row[] = Array.from({ length: 80_000 }, (_, i) => [`file-${i}.txt`, i, 1_700_000_000_000]);
    files.push(["package.json", 1, 1]);
    const text = [
      line("/data/big", [["/data/big/node_modules", 100, 10], ["/data/big/logs", 5, 1]], files),
      line("/data/big/node_modules", [["/data/big/node_modules/x", 90, 9]]),
    ].join("\n");
    expect(text.length).toBeGreaterThan(2 << 20);
    const after = await expectSameAsLegacy(text, "/");
    expect(after.roots.map((r) => r.path)).toEqual(["/data/big/node_modules"]);
    expect(after.projects).toEqual(["/data/big"]);
  });
});

/**
 * `projects` app folders, each with node_modules (and `packages`
 * packages in it, each with a package.json) and target (with debug and
 * release), plus `plain` folders that hold nothing Dev cares about.
 */
function syntheticTree(projects: number, packages: number, plain: number): string[] {
  const lines: string[] = [];
  for (let p = 0; p < projects; p++) {
    const app = `/Users/me/src/app${p}`;
    lines.push(line(app, [
      [`${app}/node_modules`, 1_000 + p, 10],
      [`${app}/target`, 2_000 + p, 20],
      [`${app}/src`, 10, 1],
    ], [["package.json", 1, 1], ["README.md", 1, 1]]));
    lines.push(line(`${app}/target`, [[`${app}/target/debug`, 1_500, 15], [`${app}/target/release`, 400, 4]]));
    lines.push(line(
      `${app}/node_modules`,
      Array.from({ length: packages }, (_, j): Row => [`${app}/node_modules/pkg${j}`, 5, 2]),
    ));
    for (let j = 0; j < packages; j++) {
      lines.push(line(`${app}/node_modules/pkg${j}`, [], [["package.json", 1, 1], ["index.js", 4, 1]]));
    }
  }
  for (let i = 0; i < plain; i++) {
    const dir = `/Users/me/Documents/folder${i}`;
    lines.push(line(dir, [[`${dir}/photos`, 100, 10], [`${dir}/notes`, 5, 1]], [["a.txt", 1, 1], ["b.pdf", 2, 1]]));
  }
  return lines.map((text) => `${text}\n`);
}

describe("sidecarFromFolderTreeFile memory", () => {
  it("holds only artifact roots and the projects that could own them", async () => {
    // The old reader held every folder row (over 2 per plain folder) and
    // every package.json folder until the file ended.
    const runs = [];
    for (const plain of [2_000, 16_000]) {
      const treePath = await writeTree(syntheticTree(10, 50, plain));
      runs.push({ plain, ...(await classify(treePath, "/")) });
    }
    for (const { plain, sidecar, stats } of runs) {
      expect(stats.rows, `rows at ${plain}`).toBeGreaterThan(plain * 4);
      // node_modules, target, target/debug, target/release per app.
      expect(stats.retainedRoots, `roots at ${plain}`).toBe(40);
      // The app folders. The 500 package.json folders in node_modules can't own a root.
      expect(stats.retainedProjects, `projects at ${plain}`).toBe(10);
      // Rows whose last two segments name an artifact: 4 + 50 packages per app.
      expect(stats.decodedRows, `decoded at ${plain}`).toBe(540);
      expect(stats.parsedLines).toBe(0);
      expect(sidecar!.roots).toHaveLength(20);
    }
  });
});

describe("sidecarFromFolderTreeFile scaling", () => {
  // Counts lines, rows and nesting lookups at N and 8N, with apps (and
  // so artifact roots) growing 8x too. Linear work grows 8x; the bound
  // allows 2x that. The old nesting pass compared each root with every
  // root kept so far: 38,000 -> 1,984,000 steps (52.2x).
  const MAX_GROWTH = 16;

  it("stays linear in rows and artifact roots", async () => {
    const run = async (projects: number, plain: number) => {
      const { stats } = await classify(await writeTree(syntheticTree(projects, 5, plain)), "/");
      return stats.steps;
    };
    const small = await run(100, 1_000);
    const large = await run(800, 8_000);
    if (process.env.SCAN_SCALING_REPORT === "1") {
      process.stdout.write(`dev artifacts classify: ${small} -> ${large} steps (${(large / small).toFixed(1)}x)\n`);
    }
    expect(large / small).toBeLessThanOrEqual(MAX_GROWTH);
    expect(large).toBeLessThanOrEqual(120_000);
  });
});
