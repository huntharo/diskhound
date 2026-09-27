import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultSettings } from "../contracts";
import { indexFilePath, initScanIndex, openIndexWriter } from "../scanIndex";
import { analyzeCleanupFromIndex, analyzeForCleanup } from "../suggestions";

let tempDir: string;

beforeEach(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-cleanup-"));
  initScanIndex(tempDir);
});

afterEach(async () => {
  await FSP.rm(tempDir, { recursive: true, force: true });
});

describe("analyzeCleanupFromIndex", () => {
  it("rolls nested node_modules files into the cache bucket", async () => {
    const filePath = indexFilePath("scan");
    const { stream, finalize } = openIndexWriter(filePath);
    stream.write(`${JSON.stringify({ p: "C:\\proj\\node_modules\\preact\\dist\\preact.js", s: 5_000_000, m: 1 })}\n`);
    stream.write(`${JSON.stringify({ p: "C:\\proj\\src\\index.ts", s: 100, m: 1 })}\n`);
    await finalize();

    const result = await analyzeCleanupFromIndex("C:\\proj", filePath, defaultSettings().cleanup);
    const caches = result.suggestions.find((s) => s.category === "build-cache");
    expect(caches).toBeTruthy();
    expect(caches!.totalSize).toBe(5_000_000);
    expect(caches!.paths.some((p) => p.includes("node_modules"))).toBe(true);
  });

  it("does not treat editor out/ or cargo bin/ as build caches", async () => {
    const filePath = indexFilePath("scan-broad");
    const { stream, finalize } = openIndexWriter(filePath);
    stream.write(`${JSON.stringify({ p: "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\resources\\app\\out\\vs.js", s: 8_000_000, m: 1 })}\n`);
    stream.write(`${JSON.stringify({ p: "C:\\Users\\me\\.cargo\\bin\\rg.exe", s: 4_000_000, m: 1 })}\n`);
    stream.write(`${JSON.stringify({ p: "C:\\proj\\dist\\bundle.js", s: 3_000_000, m: 1 })}\n`);
    await finalize();

    const result = await analyzeCleanupFromIndex("C:\\", filePath, defaultSettings().cleanup);
    const caches = result.suggestions.find((s) => s.category === "build-cache");
    expect(caches).toBeUndefined();
  });

  it("treats Next.js .next as a cache", async () => {
    const filePath = indexFilePath("scan-next");
    const { stream, finalize } = openIndexWriter(filePath);
    stream.write(`${JSON.stringify({ p: "C:\\proj\\app\\.next\\cache\\webpack\\chunk.js", s: 9_000_000, m: 1 })}\n`);
    await finalize();

    const result = await analyzeCleanupFromIndex("C:\\proj", filePath, defaultSettings().cleanup);
    const caches = result.suggestions.find((s) => s.category === "build-cache");
    expect(caches).toBeTruthy();
    expect(caches!.totalSize).toBe(9_000_000);
  });

  it("treats MSBuild obj/ and evidenced Cargo subtrees as caches", async () => {
    const filePath = indexFilePath("scan-obj");
    const { stream, finalize } = openIndexWriter(filePath);
    stream.write(`${JSON.stringify({ p: "C:\\proj\\App\\obj\\Debug\\net8.0\\App.dll", s: 2_000_000, m: 1 })}\n`);
    stream.write(`${JSON.stringify({ p: "C:\\proj\\native\\target\\release\\deps\\app.exe", s: 6_000_000, m: 1 })}\n`);
    await finalize();

    const result = await analyzeCleanupFromIndex("C:\\proj", filePath, defaultSettings().cleanup);
    const caches = result.suggestions.find((s) => s.category === "build-cache");
    expect(caches).toBeTruthy();
    expect(caches!.totalSize).toBe(8_000_000);
  });

  it("does not suggest ambiguous target trees for cleanup in a Rust monorepo", async () => {
    const filePath = indexFilePath("scan-mixed-targets");
    const { stream, finalize } = openIndexWriter(filePath);
    for (const p of [
      "/mono/Cargo.toml", "/mono/jvm/target/classes/App.class",
      "/mono/target/notes.txt", "/mono/target/release/app",
    ]) stream.write(`${JSON.stringify({ p, s: 1_000_000, m: 1 })}\n`);
    stream.write(`${JSON.stringify({ p: "/mono/jvm/target/scala-2.13/classes/App.class", s: 500, m: 1 })}\n`);
    await finalize();
    const result = await analyzeCleanupFromIndex("/mono", filePath, defaultSettings().cleanup);
    const caches = result.suggestions.find((s) => s.category === "build-cache");
    expect(caches?.totalSize).toBe(500);
    expect(caches?.paths).toEqual(["/mono/jvm/target/scala-2.13"]);
  });

  it("does not offer tool configuration, installed tools or arbitrary obj folders as caches", async () => {
    const filePath = indexFilePath("scan-tool-homes");
    const { stream, finalize } = openIndexWriter(filePath);
    const keep = [
      ".yarn/patches/pkg.patch", ".yarn/releases/yarn.cjs", ".bun/bin/bun",
      ".gradle/gradle.properties", ".gradle/init.d/init.gradle", ".m2/settings.xml",
      ".nuget/NuGet.Config", "obj/model.obj", "obj/Debug/notes.txt", "venv/app.py",
      "ccache/src/a.c", "cmake-build-debug/README.txt",
    ];
    const caches = [
      ".yarn/cache/pkg.zip", ".bun/install/cache/pkg/a.js", ".gradle/caches/modules/a.jar",
      ".m2/repository/org/a.jar", ".nuget/packages/pkg/a.dll", "obj/Debug/net8.0/App.dll",
      ".venv/lib/python3.12/site-packages/pkg/a.py", ".cache/ccache/a", "custom/CMakeFiles/a.o",
    ];
    for (const path of keep) stream.write(`${JSON.stringify({ p: `/mono/${path}`, s: 1000, m: 1 })}\n`);
    for (const path of caches) stream.write(`${JSON.stringify({ p: `/mono/${path}`, s: 100, m: 1 })}\n`);
    await finalize();
    const result = await analyzeCleanupFromIndex("/mono", filePath, defaultSettings().cleanup);
    const cache = result.suggestions.find((s) => s.category === "build-cache");
    expect(cache?.totalSize).toBe(caches.length * 100);
    expect(cache?.paths).toHaveLength(caches.length);
    expect(cache?.paths).not.toContain("/mono/obj");
  });

  it("splits DiagOutputDir ETL traces out of generic logs", async () => {
    const filePath = indexFilePath("scan-diag");
    const { stream, finalize } = openIndexWriter(filePath);
    stream.write(`${JSON.stringify({ p: "C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir\\RdClientAutoTrace\\a.etl", s: 4_000_000_000, m: 1 })}\n`);
    stream.write(`${JSON.stringify({ p: "C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir\\b.etl", s: 1_000_000_000, m: 1 })}\n`);
    stream.write(`${JSON.stringify({ p: "C:\\app\\debug.log", s: 20, m: 1 })}\n`);
    await finalize();

    const result = await analyzeCleanupFromIndex("C:\\", filePath, defaultSettings().cleanup);
    const diag = result.suggestions.find((s) => s.category === "diag-logs");
    const logs = result.suggestions.find((s) => s.category === "logs");
    expect(diag?.title).toBe("DiagOutputDir RDP trace logs");
    expect(diag?.totalSize).toBe(5_000_000_000);
    expect(diag?.paths).toEqual(["C:\\Users\\thoma\\AppData\\Local\\Temp\\DiagOutputDir"]);
    expect(logs?.totalSize).toBe(20);
  });
});


it("agrees across index and snapshot: ISO/DMG installers, no VM cleanup", async () => {
  const paths = [
    "/Downloads/linux.iso", "/Downloads/setup.dmg", "/Videos/movie.mp4",
    "/Downloads/Linux.utm/installer.iso", "/Downloads/Linux.utm/old.log",
    "/Downloads/Linux.utm/cache.tmp", "/Downloads/disk.vmdk",
    "/Users/me/.tart/vms/build/disk.img", "/Users/me/VirtualBox VMs/dev/Snapshots/uuid.sav",
  ];
  const files = paths.map((path) => ({
    path, name: Path.basename(path), parentPath: Path.dirname(path), extension: Path.extname(path),
    size: 200 * 1024 * 1024, modifiedAt: 1,
  }));
  const filePath = indexFilePath("vm-installers");
  const { stream, finalize } = openIndexWriter(filePath);
  for (const file of files) stream.write(JSON.stringify({ p: file.path, s: file.size, m: file.modifiedAt }) + "\n");
  await finalize();
  const settings = defaultSettings().cleanup;
  const results = [analyzeForCleanup("/", files, [], settings), await analyzeCleanupFromIndex("/", filePath, settings)];
  for (const result of results) {
    expect(result.suggestions.find((s) => s.category === "installer-leftovers")?.paths.sort()).toEqual(paths.slice(0, 2).sort());
    expect(result.suggestions.find((s) => s.category === "large-media")?.paths).toEqual([paths[2]]);
    expect(result.suggestions.flatMap((s) => s.paths).sort()).toEqual(paths.slice(0, 3).sort());
  }
});

it("bounds snapshot cleanup work as file and directory counts grow", () => {
  const count = (n: number) => {
    let reads = 0;
    const files = Array.from({ length: n }, (_, i) => ({
      get path() { reads++; return `/VM/Guest${i}.utm/file.tmp`; },
      name: "file.tmp", parentPath: "/VM", extension: ".tmp", size: 1, modifiedAt: 1,
    }));
    const dirs = Array.from({ length: n }, (_, i) => ({
      get path() { reads++; return `/VM/Guest${i}.utm/node_modules`; },
      size: 1, fileCount: 1, depth: 3,
    }));
    expect(analyzeForCleanup("/", files, dirs, defaultSettings().cleanup).suggestions).toEqual([]);
    return reads;
  };
  const small = count(100), large = count(800);
  expect(large).toBeLessThanOrEqual(small * 16);
  expect(large).toBeLessThanOrEqual(2_000);
});
