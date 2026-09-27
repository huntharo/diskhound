import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect, test, type AppHandle } from "./fixtures/electron-app";
import { openTab, scanFolderFromPicker, waitForScanComplete } from "./fixtures/steps";

// A Terraform working directory as `terraform init` leaves it. Only the
// provider download is a Dev Artifact: the rest of .terraform holds the
// backend config and selected workspace, which init can't put back.
const WORKDIR = ["infra", "prod"];
const PROVIDER = [
  ".terraform", "providers", "registry.terraform.io", "hashicorp", "aws", "6.54.0", "darwin_arm64",
  "terraform-provider-aws_v6.54.0_x5",
];
// Whole multiples of 4 KiB, so the allocated size the scanner reports
// equals the logical size.
const PROVIDER_BYTES = 1024 * 1024;
const SMALL_BYTES = 4 * 1024;

// Keep the tree out of the uploaded CI artifacts.
test.afterEach(({}, testInfo) => {
  rmSync(testInfo.outputPath("dev"), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function writeFile(root: string, parts: string[], bytes: number): void {
  const target = join(root, ...parts);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, randomBytes(bytes));
}

function writeTree(root: string): void {
  writeFile(root, [...WORKDIR, ".terraform.lock.hcl"], SMALL_BYTES);
  writeFile(root, [...WORKDIR, "main.tf"], SMALL_BYTES);
  writeFile(root, [...WORKDIR, ".terraform", "terraform.tfstate"], SMALL_BYTES);
  writeFile(root, [...WORKDIR, ...PROVIDER], PROVIDER_BYTES);
}

async function expectTerraformRow({ page }: AppHandle, rootPath: string, sidecarOnly: boolean): Promise<void> {
  const workdir = join(rootPath, ...WORKDIR);
  const report = await page.evaluate(
    ([root, only]) => window.diskhound.getDevArtifacts(root, { sidecarOnly: only }),
    [rootPath, sidecarOnly] as const,
  );
  // The folder-tree sidecar keys Windows paths in lowercase (the
  // scanner's normalize_tree_key), so the fallback's paths come back
  // lowercased there. The native sidecar keeps their case.
  const foldCase = !sidecarOnly && process.platform === "win32";
  const key = (path: string | null) => (foldCase ? path?.toLowerCase() ?? null : path);
  const artifacts = report?.artifacts.map((a) => ({ ...a, path: key(a.path), projectPath: key(a.projectPath) }));
  expect(artifacts).toEqual([expect.objectContaining({
    path: key(join(workdir, ".terraform", "providers")),
    kind: "terraform",
    projectPath: key(workdir),
    projectName: "prod",
    size: PROVIDER_BYTES,
    fileCount: 1,
  })]);

  await openTab(page, "Dev Artifacts");
  await expect(page.locator('.dev-kind-cell[title="Terraform providers"] .dev-kind-cell-label')).toHaveText("Terraform");
  const row = page.locator(".dev-row");
  await expect(row).toHaveCount(1);
  await expect(row.locator(".dev-row-name")).toHaveText("prod");
  await expect(row.locator(".dev-row-tail")).toHaveText(join(".terraform", "providers"));
}

test("lists Terraform providers under their working directory", async ({ launch }, testInfo) => {
  const root = testInfo.outputPath("dev");
  writeTree(root);
  const handle = await launch();
  const snapshot = await scanFolderFromPicker(handle, root);
  if (snapshot.rootPath === null) throw new Error("scan has no root path");
  // The native scanner's own sidecar, with no fallback.
  await expectTerraformRow(handle, snapshot.rootPath, true);
});

test("finds Terraform providers from the folder tree when the scan has no Dev sidecar", async ({ launch }, testInfo) => {
  const root = testInfo.outputPath("dev");
  writeTree(root);
  const first = await launch();
  const scanned = await scanFolderFromPicker(first, root);
  await first.close();

  const indexDir = join(first.userDataDir, "scan-indexes");
  const sidecars = readdirSync(indexDir).filter((name) => name.endsWith(".dev-artifacts.json"));
  expect(sidecars.length).toBeGreaterThan(0);
  for (const name of sidecars) rmSync(join(indexDir, name));

  const second = await launch({ dataDir: first.dataDir });
  const restored = await waitForScanComplete(second.page);
  if (restored.rootPath === null) throw new Error("scan has no root path");
  expect(restored.rootPath).toBe(scanned.rootPath);
  await expectTerraformRow(second, restored.rootPath, false);
});


test("marks old build classifications incomplete without relabeling Gradle as Scala", async ({ launch }, testInfo) => {
  const root = testInfo.outputPath("dev");
  writeFile(root, ["Cargo.toml"], SMALL_BYTES);
  writeFile(root, ["target", "debug", "deps", "libapp.rlib"], PROVIDER_BYTES);
  writeFile(root, [".gradle", "caches", "example.bin"], SMALL_BYTES);
  const first = await launch();
  await scanFolderFromPicker(first, root);
  await openTab(first.page, "Dev Artifacts");
  await expect(first.page.locator('.dev-kind-cell-label', { hasText: /^Rust target$/ })).toBeVisible();
  await expect(first.page.getByText("Build artifact totals are incomplete.", { exact: true })).toHaveCount(0);
  await first.close();

  // Emulate a saved sidecar from before the evidence-based rules.
  const indexDir = join(first.userDataDir, "scan-indexes");
  const sidecars = readdirSync(indexDir).filter((name) => name.endsWith(".dev-artifacts.json"));
  expect(sidecars.length).toBeGreaterThan(0);
  for (const name of sidecars) {
    const path = join(indexDir, name);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    for (const row of saved.roots) {
      if (row.kind === "rust-target") row.path = join(root, "target");
    }
    writeFileSync(path, JSON.stringify(saved));
  }
  const second = await launch({ dataDir: first.dataDir });
  await waitForScanComplete(second.page);
  await openTab(second.page, "Dev Artifacts");
  await expect(second.page.getByText("Build artifact totals are incomplete.", { exact: true })).toBeVisible();
  await expect(second.page.locator('.dev-kind-cell-label', { hasText: /^Gradle \/ JVM$/ })).toBeVisible();
  await expect(second.page.locator('.dev-kind-cell-label', { hasText: /^Rust target$/ })).toHaveCount(0);
});


test("keeps tool configuration out of native and folder-tree cache reports", async ({ launch }, testInfo) => {
  const root = testInfo.outputPath("dev");
  const generated: Array<[string, string, string]> = [
    [".yarn/cache/pkg.zip", ".yarn/cache", "package-cache"],
    [".yarn/berry/cache/pkg.zip", ".yarn/berry/cache", "package-cache"],
    ["target/aarch64-apple-darwin/release/build/crate-0123456789abcdef/out/lib.a", "target/aarch64-apple-darwin/release/build/crate-0123456789abcdef", "rust-target"],
    ["Library/Caches/electron/download.zip", "Library/Caches/electron", "package-cache"],
    ["Library/Caches/vscode-cpptools/ipch/a", "Library/Caches/vscode-cpptools", "compiler-cache"],
    [".local/share/NuGet/http-cache/a.dat", ".local/share/NuGet/http-cache", "dotnet"],
    [".cache/pip/http-v2/a", ".cache/pip", "python"],
    [".npm/_cacache/content-v2/a", ".npm/_cacache", "package-cache"],
    [".bun/install/cache/pkg/a.js", ".bun/install/cache", "package-cache"],
    [".gradle/caches/modules/a.jar", ".gradle/caches", "jvm"],
    [".m2/repository/org/a.jar", ".m2/repository", "jvm"],
    [".nuget/packages/pkg/a.dll", ".nuget/packages", "dotnet"],
    ["obj/Debug/net8.0/App.dll", "obj/Debug/net8.0", "dotnet"],
    [".tox/py312/lib/python3.12/site-packages/pkg/a.py", ".tox/py312/lib/python3.12/site-packages", "python"],
    [".cache/ccache/a.o", ".cache/ccache", "compiler-cache"],
    ["custom-build/CMakeFiles/a.o", "custom-build/CMakeFiles", "cmake-build"],
    ["go/pkg/mod/example.com/team/module/v2@v2.0.0/a.go", "go/pkg/mod/example.com/team/module/v2@v2.0.0", "go-module"],
  ];
  for (const [file] of generated) writeFile(root, file.split("/"), SMALL_BYTES);
  for (const file of [
    ".yarn/patches/pkg.patch", ".yarn/releases/yarn.cjs", ".bun/bin/bun",
    ".gradle/gradle.properties", ".gradle/init.d/init.gradle", ".m2/settings.xml",
    ".nuget/NuGet.Config", "obj/mesh.obj", "venv/app.py", "ccache/src/a.c",
    "cmake-build-debug/README.txt", "go/pkg/mod/helpers.go",
    "target/debug/build/source/main.rs", ".yarn/berry/metadata/state.json",
    "Library/Caches/unknown-tool/my-data", ".npm/_npx/user-script.js",
    ".tart/vms/work/disk.img", ".codex/worktrees/branch/src/main.ts",
    ".vscode/extensions/tool/dist/main.js", "Library/Application Support/electron/settings.json",
  ]) writeFile(root, file.split("/"), SMALL_BYTES);

  const first = await launch();
  const scanned = await scanFolderFromPicker(first, root);
  if (!scanned.rootPath) throw new Error("scan has no root path");
  const check = async (handle: AppHandle, sidecarOnly: boolean) => {
    const report = await handle.page.evaluate(
      ([scanRoot, only]) => window.diskhound.getDevArtifacts(scanRoot, { sidecarOnly: only }),
      [scanned.rootPath!, sidecarOnly] as const,
    );
    expect(report?.classificationNeedsFullScan).toBeUndefined();
    expect(report?.totalBytes).toBe(generated.length * SMALL_BYTES);
    expect(report?.artifacts).toHaveLength(generated.length);
    const actual = report!.artifacts.map((r) => [r.path.toLowerCase(), r.kind]);
    expect(actual).toEqual(expect.arrayContaining(generated.map(([, path, kind]) => [join(root, ...path.split("/")).toLowerCase(), kind])));
  };
  await check(first, true);
  await first.close();
  const indexDir = join(first.userDataDir, "scan-indexes");
  for (const name of readdirSync(indexDir).filter((name) => name.endsWith(".dev-artifacts.json"))) {
    rmSync(join(indexDir, name));
  }
  const second = await launch({ dataDir: first.dataDir });
  await waitForScanComplete(second.page);
  await check(second, false);
});
