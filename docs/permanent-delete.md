# Permanent deletion engines

Settings → Cleanup Detection → **Faster folder deletion (experimental)** selects
Node's `fs.promises.rm` for the next non-elevated folder deletion. It is off by
default. Both engines run in the deletion worker; the protected-path check and
confirmation still happen before dispatch. Windows admin retries continue to use
the existing elevated helper.

The default walker reports current paths and visited-file counts. The experimental
engine reports the tree only. Dev Artifacts already displays the known tree size,
batch position and elapsed time, so it stays informative without inventing a file
count or running a second traversal just to measure progress. Completion logs
include the engine and elapsed milliseconds for comparison.

## Why the walker exists

Commit `06721da2eea656617aeb7fb49fce1dbdb2445fe1` used recursive `fs.rm` for
permanent folder deletion, with missing-path handling, link handling and a final
existence check. Commit `329d71ff4ec563cbeda3e0b2c8484563c81999c6` replaced it
with the walker to provide progress: its message explains that silent `fs.rm`
left the banner at 0 B until a large tree finished. It does not cite a link-safety
problem as the reason for the switch.

On macOS/APFS with Electron 40.6.0 / Node 24.13.1, two local trials removing
20,000 empty files across 200 directories took 1.16–1.17 seconds with the current
walker and 0.34–0.36 seconds with `fs.rm`. These are synthetic results, not a
speed guarantee for populated build trees or Windows/Linux.

## Safety boundaries

Both engines remove ordinary symlinks and Windows directory junctions without
recursively deleting their targets. Tests cover root and nested directory links,
dangling links, and hard links. The recursive engine uses `force: true` for
missing paths and `maxRetries: 2` for transient errors; it still verifies that the
selected path is absent. Filesystem error codes cross the worker boundary so the
Windows elevation decision can recognize access-denied failures.

Neither engine has a same-filesystem restriction for mounted directories inside
the selected tree, nor guarantees containment against concurrent path replacement.
Avoiding ordinary symlinks is distinct from these guarantees. The experimental
toggle does not add or promise either one.
