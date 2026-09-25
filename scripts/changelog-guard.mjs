import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Feature pull requests must not edit CHANGELOG.md. A release cut may,
 * and its title starts with "Cut DiskHound" (or the branch is release/*).
 */
export function changelogEditAllowed({ files, title = "", branch = "" }) {
  const touchesChangelog = files.some((file) => file === "CHANGELOG.md" || file.endsWith("/CHANGELOG.md"));
  if (!touchesChangelog) return { ok: true, reason: "" };
  if (/^Cut DiskHound\b/.test(title) || /^release\//.test(branch)) {
    return { ok: true, reason: "" };
  }
  return {
    ok: false,
    reason: [
      "CHANGELOG.md changed on a feature pull request.",
      "Leave it alone. The release skill writes it from merged pull requests.",
      "A release cut is allowed when the pull request title starts with \"Cut DiskHound\".",
    ].join("\n"),
  };
}

function changedFiles(baseSha) {
  const out = execFileSync("git", ["diff", "--name-only", `${baseSha}...HEAD`], { encoding: "utf8" });
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

function main() {
  const baseSha = process.env.BASE_SHA;
  if (!baseSha) {
    console.error("BASE_SHA is not set.");
    process.exit(1);
  }
  const decision = changelogEditAllowed({
    files: changedFiles(baseSha),
    title: process.env.PR_TITLE ?? "",
    branch: process.env.HEAD_REF ?? "",
  });
  if (decision.ok) return;
  console.error(decision.reason);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
