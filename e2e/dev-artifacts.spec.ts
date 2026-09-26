import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
