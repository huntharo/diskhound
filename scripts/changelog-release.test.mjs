import { describe, expect, it } from "vitest";

import { changelogEditAllowed } from "./changelog-guard.mjs";
import {
  formatReleaseNotes,
  latestChangelogVersion,
  pullRequestInRange,
} from "./collect-release-notes.mjs";

describe("latestChangelogVersion", () => {
  it("skips Unreleased and reads the newest dated heading", () => {
    const markdown = "# Changelog\n\n## Unreleased\n\n- a note\n\n## 0.6.2 — 2026-09-23\n\n## 0.6.1 — 2026-09-22\n";
    expect(latestChangelogVersion(markdown)).toBe("0.6.2");
  });

  it("reads a prerelease heading", () => {
    expect(latestChangelogVersion("## 0.5.44-beta.1 — 2026-08-01\n")).toBe("0.5.44-beta.1");
  });
});

describe("formatReleaseNotes", () => {
  it("lists pull requests before commit subjects", () => {
    const notes = formatReleaseNotes({
      since: "v0.6.2",
      pullRequests: [{
        number: 12,
        title: "Use / in Dev Artifacts paths on macOS and Linux",
        body: "Tails used a backslash.\n\nMore detail.",
        author: "huntharo",
      }],
      commits: [{ subject: "Join Dev Artifacts tails with the source path's separator." }],
    });
    expect(notes).toContain("Since v0.6.2");
    expect(notes).toContain("#12 Use / in Dev Artifacts paths on macOS and Linux (huntharo)");
    expect(notes).toContain("Tails used a backslash.");
    expect(notes).not.toContain("More detail.");
    expect(notes.indexOf("Pull requests")).toBeLessThan(notes.indexOf("Commit subjects"));
  });

  it("says when nothing merged", () => {
    expect(formatReleaseNotes({ since: "v0.6.2", pullRequests: [], commits: [] }))
      .toContain("Nothing merged");
  });

  it("skips a summary heading and uses the next paragraph", () => {
    const notes = formatReleaseNotes({
      since: "v0.6.2",
      pullRequests: [{
        number: 1,
        title: "Example",
        body: "## Summary\n\nThe drive list stays up.\n\n## Test plan",
        author: "huntharo",
      }],
      commits: [],
    });
    expect(notes).toContain("The drive list stays up.");
    expect(notes).not.toContain("## Summary");
  });
});

describe("pullRequestInRange", () => {
  it("drops the release merge itself and keeps later pull requests", () => {
    expect(pullRequestInRange(
      { mergedAt: "2026-09-23T22:17:46Z", mergeCommit: "d393fe2" },
      "2026-09-23T22:17:46Z",
      "d393fe2",
    )).toBe(false);
    expect(pullRequestInRange(
      { mergedAt: "2026-09-23T22:17:46Z", mergeCommit: "other" },
      "2026-09-23T18:17:46-04:00",
      "d393fe2",
    )).toBe(false);
    expect(pullRequestInRange(
      { mergedAt: "2026-09-25T12:56:57Z", mergeCommit: "8ef4155" },
      "2026-09-23T22:17:46Z",
      "d393fe2",
    )).toBe(true);
  });
});

describe("changelogEditAllowed", () => {
  it("allows a feature pull request that leaves the changelog alone", () => {
    expect(changelogEditAllowed({ files: ["src/main.ts"], title: "Fix the header" }).ok).toBe(true);
  });

  it("rejects a feature pull request that edits the changelog", () => {
    const decision = changelogEditAllowed({
      files: ["CHANGELOG.md", "src/main.ts"],
      title: "Keep Linux scans on one filesystem",
      branch: "fix/scan",
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain("CHANGELOG.md");
  });

  it("allows a release cut", () => {
    expect(changelogEditAllowed({
      files: ["CHANGELOG.md", "package.json"],
      title: "Cut DiskHound 0.6.3.",
      branch: "release/0.6.3",
    }).ok).toBe(true);
    expect(changelogEditAllowed({
      files: ["CHANGELOG.md"],
      title: "notes",
      branch: "release/0.6.3",
    }).ok).toBe(true);
  });
});
