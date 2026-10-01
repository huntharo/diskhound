import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isSignAllowed } from "app-builder-lib/out/codeSign/macCodeSign.js";
import { personalizeMacExecutableFile, personalizeMacExecutableUuid } from "./macos-executable-uuid.mjs";

function stagedApp(context) {
  const { appInfo, info } = context.packager;
  const app = path.join(context.appOutDir, `${appInfo.productFilename}.app`);
  const identity = JSON.stringify([appInfo.id, appInfo.version, info.framework.version]);
  return { app, executable: path.join(app, "Contents", "MacOS", appInfo.productFilename), identity };
}

export async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  // afterSign is not called when builder skips signing. Fail before changing
  // signed bytes in that case, including PR builds and identity: null overrides.
  const identity = context.packager.platformSpecificBuildOptions.identity;
  if (!isSignAllowed(false) || !identity) {
    throw new Error("macOS UUID personalization requires signing: use mac.identity '-' (ad-hoc) or a certificate identity; signing must not be disabled.");
  }
  const staged = stagedApp(context);
  await personalizeMacExecutableFile(staged.executable, staged.identity);
}

export async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const staged = stagedApp(context);
  const binary = await readFile(staged.executable);
  if (!personalizeMacExecutableUuid(binary, staged.identity).equals(binary)) {
    throw new Error("Signed macOS launcher does not have the expected DiskHound UUIDs");
  }
  // Verifies every architecture and nested code after builder's final signing,
  // before creating the DMG. A stale stock/ad-hoc signature fails packaging.
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures", staged.app], { stdio: "pipe" });
}
