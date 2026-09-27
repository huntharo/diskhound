# Permanent deletion

Permanent folder deletion uses `@shutterstock/p-map-iterable` with
`concurrency: 4` and `maxUnread: 100`. There is one engine and no experimental
setting. The protected-path check and confirmation still happen before dispatch
to the deletion worker. Windows admin retries retain the existing elevated helper.

An async generator streams a depth-first traversal into a prefetch mapper
(`concurrency: 1`, `maxUnread: 100`), followed by the deletion mapper. This keeps
up to 100 pending jobs ready while separately buffering up to 100 completed
results. Enumeration does not occupy a deletion runner. `opendir`
uses a 32-entry buffer per active directory, so even a very wide directory is
never materialized as an array. Directories are checked with `lstat` before
opening; ordinary files need no separate metadata lookup. A parent becomes
eligible for removal only after its children settle. This dependency wait happens
in the generator, leaving mapper slots available to finish those children.
Each mapper removes one entry, keeping global removal concurrency at four.
The per-directory pending-child counter includes both queued and active children,
and is decremented only after their removal operation settles. The directory's
handle is closed before it is yielded. If any removal failed, parents are not
yielded for removal. Progress consumption and mapper completion order do not
control this dependency.

The dependency wait does pause the single prefetch runner at directory EOF.
Already-buffered children continue through the deletion workers, so the wait does
not deadlock them. However, enumeration cannot advance to later siblings until
the current directory's last child settles; a slow last child can leave deletion
workers idle. The input buffer overlaps reads and removals within a directory,
but does not remove this boundary between sibling directory traversals.
Retained traversal state and directory handles grow with depth, plus the bounded
input and result queues; there is no O(entries) removal list or counting pass.

The result loop counts successful completions. Dev Artifacts uses the prior scan's
file count for an explicitly approximate percentage, updated by tenths at most
once per 150 ms. Stale estimates are capped at 99.9%; only successful verification
that the root is gone produces 100%. With no valid scan count, updates report
completed items without a percentage. The total item count is unknown until
completion. The UI retains current path, batch size, batch position and elapsed
time. Progress is not persisted to disk.

On failure, dispatch stops, buffered jobs are skipped, and already-running
removals settle before the error returns. Both stages drain and open directory
handles close before returning. The original filesystem error code crosses the
worker boundary so Windows can offer an admin retry. `EBUSY`, `EMFILE`, `ENFILE`,
and `ENOTEMPTY` during removal receive up to two retries after 100 ms and 200 ms (three attempts total). `ENOENT` is success.
Windows `EPERM` checks the entry with `lstat`, avoids chmod on symlinks, and
retries after repairing ordinary file/directory permissions. Other errors,
including enumeration errors, stop dispatch without a retry loop. Directories
that acquire new children are not recursively expanded by the deletion phase; a persistent nonempty directory produces an error.

The worker caller rejects any exit without a result, including exit code zero.
Exceptions from its progress listener are held until the worker finishes, so they
do not escape the event emitter or interrupt active filesystem work. Tests cover
retry delays and exhaustion, permission-repair failures and disappearing entries,
worker exceptions, early exits, and listener failures. Windows permission branches
also run as mocked platform tests on other hosts; real Windows execution remains
a separate CI check.

## History and measurements

Commit `06721da2eea656617aeb7fb49fce1dbdb2445fe1` used recursive `fs.rm`.
Commit `329d71ff4ec563cbeda3e0b2c8484563c81999c6` replaced it with a serial
walker to provide per-file progress when large deletions appeared stuck at 0 B.
Its message does not cite a link-safety defect as the reason for the switch.

Two local trials on macOS/APFS using Electron 40.6.0 / Node 24.13.1 removed
20,000 empty files across 200 directories. Trial 2 reversed the engine order.
The concurrent measurement includes enumeration and a progress callback.

| Engine | Trial 1 | Trial 2 |
| --- | ---: | ---: |
| Original serial walker | 1.403 s | 1.367 s |
| Concurrent removal with prebuilt list | 0.447 s | 0.309 s |
| Streaming removal before input prefetch | 0.516 s | 0.469 s |
| Node `fs.rm` | 0.533 s | 0.477 s |

A follow-up comparison on the same fixture and runtime alternated engine order
across four trials, isolating the input-prefetch stage:

| Trial | Streaming without input prefetch | With 100-job input prefetch |
| --- | ---: | ---: |
| 1 | 0.392 s | 0.374 s |
| 2 | 0.505 s | 0.447 s |
| 3 | 0.493 s | 0.400 s |
| 4 | 0.622 s | 0.513 s |

Input prefetch reduced elapsed time by 5–19% in these local trials. These
synthetic results are not a speed guarantee for populated build trees or
Windows/Linux. Operation-count tests grow both file and folder counts eightfold,
check linear scaling, and assert a four-operation concurrency cap. Wide-tree
tests bound read-ahead, operation counts, and open handles while increasing
entries eightfold. A deep-tree test also grows depth and entries eightfold.
These checks count filesystem calls and entry inspections, with an absolute cap
of eight counted operations per entry. They guard against repeated scans over
entries; they do not count CPU instructions or the cost of constructing longer
paths in deeper trees.
A blocked-deletion test verifies that enumeration fills the pending-work buffer
without traversing the rest of the tree. Failure tests cover both a producer
waiting for children at EOF and a full input buffer.

## Safety boundaries

Tests cover ordinary root/nested directory links, dangling links, hard links,
read-only files, directory ordering, failures with active operations, and final
verification. Symlinks and Windows junctions are unlinked without traversing
their targets. Links to a different volume do not change this behavior.

The engine does not promise containment across mounted directories within the
selected tree or concurrent path replacement. Those are distinct from avoiding
ordinary symlinks and were not guaranteed by the previous implementations either.

## Ordering verification

The deterministic ordering test completes four sibling files in the order 4, 2,
3, 1, verifies that no directory removal is attempted while file 1 is pending,
then pauses removal of their directory and verifies that its parent is still not
attempted. It counts attempts so retries cannot mask an ordering defect. The
shared fixture also asserts that every directory is empty and its enumeration
handle is closed at the moment `rmdir` is called. This test and the real-filesystem
nested/wide-tree tests run in the Linux, Windows, and macOS Vitest CI jobs.

In [Node 24.13.1's recursive removal implementation](https://github.com/nodejs/node/blob/v24.13.1/lib/internal/fs/rimraf.js#L113-L144),
`_rmchildren` starts child removals and calls the parent's `rmdir` after the last
successful child callback. This dependency is handled above libuv.
[libuv's Windows implementation](https://github.com/nodejs/node/blob/v24.13.1/deps/uv/src/win/fs.c#L1025-L1143)
performs each requested unlink/rmdir independently; it does not schedule the
recursive tree's dependencies for its caller.
