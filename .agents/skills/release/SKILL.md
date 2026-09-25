---
name: release
description: >
  Cut a DiskHound release by writing CHANGELOG.md from merged pull
  requests and commits, then bumping the version and tagging. Use when
  cutting a release, shipping a version, writing the changelog, or
  running /release. Feature work must not edit CHANGELOG.md.
---

# Release

Feature branches do not edit `CHANGELOG.md`. The notes are written once, here, when a version ships. CI rejects a changelog edit unless the pull request title starts with `Cut DiskHound`.

## Collect

From a clean checkout of `main`:

```bash
bun run release:notes
```

That prints pull requests merged since the latest `## x.y.z` heading, then commit subjects on `main` since that tag. Read the pull request bodies before writing. Do not paste commit hashes into the changelog.

## Write

Insert the new section under the empty `## Unreleased` heading. If `## Unreleased` already has bullets, fold them into this section and leave the heading empty.

```markdown
## Unreleased

## 0.6.3 — YYYY-MM-DD

One sentence a user would recognize.

### Area

- What changed, in the voice of the sections already in CHANGELOG.md.
```

Group bullets by what the user sees. Skip merge commits and `Cut DiskHound` commits. Do not invent a change that is not in the notes or a pull request body.

Set `package.json` `"version"` to the same number.

## Ship

Commit `Cut DiskHound x.y.z.` Open the pull request with that same title so CI allows the changelog edit. Renaming the pull request re-runs that check, and so does a later edit of the description. After it merges, tag `vx.y.z` on that `main` commit and push the tag. The release workflow publishes from the tag and syncs `package.json` from it again.
