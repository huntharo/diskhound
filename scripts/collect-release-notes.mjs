import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Latest `## x.y.z — date` heading, ignoring `## Unreleased`.
 * The prerelease part matches scripts/sync-version-from-tag.mjs,
 * including a hyphen inside an identifier (`0.7.0-beta-1`).
 */
export function latestChangelogVersion(markdown) {
  const match = markdown.match(/^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?) — /m);
  return match?.[1] ?? null;
}

function firstParagraph(body) {
  if (!body) return "";
  const chunks = body.split(/\n\s*\n/).map((chunk) => chunk.replace(/\s+/g, " ").trim()).filter(Boolean);
  for (const chunk of chunks) {
    if (chunk.startsWith("<!--") || chunk.startsWith("|") || chunk.startsWith("![")) continue;
    // "## Summary" and "## Test plan" are headings, not the change.
    if (/^#{1,6}\s+/.test(chunk) && chunk.length < 40) continue;
    return chunk.length > 400 ? `${chunk.slice(0, 397)}...` : chunk;
  }
  return "";
}

/** A pull request is in range when it merged after the previous release commit. */
export function pullRequestInRange(pr, sinceIso, sinceSha) {
  if (sinceSha && pr.mergeCommit === sinceSha) return false;
  const merged = Date.parse(pr.mergedAt);
  const since = Date.parse(sinceIso);
  if (!Number.isFinite(merged) || !Number.isFinite(since)) return false;
  return merged > since;
}

/**
 * Notes an agent turns into a changelog section. Pull requests first.
 * Commit subjects are the detail a title left out, not a second list
 * of the same work.
 */
export function formatReleaseNotes({ since, pullRequests, commits }) {
  const lines = [`Since ${since}`, ""];
  if (pullRequests.length === 0 && commits.length === 0) {
    lines.push("Nothing merged since that version.");
    return `${lines.join("\n")}\n`;
  }
  if (pullRequests.length > 0) {
    lines.push("Pull requests", "");
    for (const pr of pullRequests) {
      lines.push(`- #${pr.number} ${pr.title}${pr.author ? ` (${pr.author})` : ""}`);
      const blurb = firstParagraph(pr.body);
      if (blurb) lines.push(`  ${blurb}`);
    }
    lines.push("");
  }
  if (commits.length > 0) {
    lines.push("Commit subjects", "");
    for (const commit of commits) {
      lines.push(`- ${commit.subject}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function mergedPullRequests(sinceIso, sinceSha) {
  const day = sinceIso.slice(0, 10);
  const raw = execFileSync(
    "gh",
    [
      "pr", "list",
      "--state", "merged",
      "--base", "main",
      "--limit", "100",
      "--search", `merged:>=${day}`,
      "--json", "number,title,body,mergedAt,author,mergeCommit",
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(raw)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      author: pr.author?.login ?? "",
      mergedAt: pr.mergedAt,
      mergeCommit: pr.mergeCommit?.oid ?? "",
    }))
    .filter((pr) => pullRequestInRange(pr, sinceIso, sinceSha))
    .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
}

function commitSubjects(sinceRef) {
  const log = git(["log", `${sinceRef}..HEAD`, "--no-merges", "--pretty=%s"]);
  if (!log) return [];
  return log
    .split("\n")
    .map((subject) => subject.trim())
    .filter((subject) => subject && !/^Cut DiskHound\b/.test(subject))
    .map((subject) => ({ subject }));
}

function main() {
  const sinceFlag = process.argv.indexOf("--since");
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const version = latestChangelogVersion(changelog);
  const since = sinceFlag >= 0 ? process.argv[sinceFlag + 1] : version ? `v${version}` : "";
  if (!since) {
    console.error("CHANGELOG.md has no version heading. Pass --since vX.Y.Z.");
    process.exit(1);
  }
  let sinceIso;
  try {
    sinceIso = git(["log", "-1", "--format=%cI", `${since}^{}`]);
  } catch {
    console.error(`Cannot resolve ${since}. Fetch tags and try again.`);
    process.exit(1);
  }
  let pullRequests = [];
  try {
    pullRequests = mergedPullRequests(sinceIso, git(["rev-parse", `${since}^{}`]));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Could not list pull requests (${message.split("\n")[0]}). Commit subjects only.`);
  }
  process.stdout.write(formatReleaseNotes({
    since,
    pullRequests,
    commits: commitSubjects(since),
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
