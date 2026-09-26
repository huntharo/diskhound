# macOS: where space hides

Scan `/`. On modern Macs that is the read-only system volume plus the
`/System/Volumes/Data` volume where every user file lives. DiskHound shows
them as one startup disk.

## When "used" is much bigger than the scan total

The startup disk is an APFS container that several volumes share: System,
Data, Preboot, Recovery, VM, and sometimes others. Free space is shared across
all of them. Check these, in this order:

| Cause | Check (read-only) | How it gets freed |
| --- | --- | --- |
| Time Machine local snapshots | `tmutil listlocalsnapshots /` | Expire on their own (about 24 h), or thin or delete them (below). |
| Other APFS snapshots (backup apps) | `diskutil apfs listSnapshots /System/Volumes/Data` | Via the app that made them. `Purgeable: Yes` means macOS may drop it under pressure. |
| Swap and sleep image | `ls -lh /private/var/vm` | Managed by macOS; reboot to shrink swap. |
| Other volumes in the container | `diskutil apfs list` | Their owners (e.g. a second macOS install or a Docker volume). |
| Purgeable space | `diskutil info /` (the "Free Space" lines) | macOS reclaims it on demand (iCloud-evictable files, caches, snapshots). |
| Files the scan could not read | `skippedEntries` in `diskhound_scan_summary` | Grant DiskHound Full Disk Access in System Settings > Privacy & Security, then rescan. |

System Settings > General > Storage has the same breakdown with Apple's own
cleanup buttons (Documents, iCloud Drive, Messages, Photos, and so on). Point
the user there for app-managed data.

## APFS clones

A clone is a copy that shares data blocks with its source (`clonefile(2)`).
Only the blocks one copy changes get their own storage. Clones come from:

- **pnpm on APFS.** `package-import-method` defaults to `auto`, which clones
  from the content-addressable store into each project's `node_modules`.
  Check with `pnpm config get package-import-method` and `pnpm store path`.
- **Finder.** Duplicate (Cmd-D), and copy/paste within the same volume.
- **The command line:** `cp -c`, `ditto --clone`, and some backup, sync, and
  Xcode workflows.

What this means for cleanup:

- **Every clone that shares a block must be deleted before that block is
  freed.** Deleting one `node_modules` while five other projects and the
  pnpm store still hold clones frees almost nothing.
- Sizes over-count shared data. DiskHound, `du`, and Finder all report each
  clone at its full size, so adding up clones overstates what their removal
  returns.
- To actually free pnpm space, delete every `node_modules` you no longer need
  (Dev Artifacts lists them all) **and** run `pnpm store prune`, which drops
  store packages no project references.
- macOS has no standard command that shows how much of a file is shared.
  When it matters, measure: note free space with `diskhound_status`, remove
  the item, empty the Trash, and check again. Allow for local snapshots (next
  section), which also delay the change.

## Time Machine local snapshots

When Time Machine is on, macOS takes hourly local APFS snapshots of the Data
volume and keeps them for about 24 hours, or longer if a backup disk has not
been connected. A snapshot keeps every block that existed when it was taken.
**Files deleted after a snapshot keep using space until that snapshot is gone.**
This is the most common reason a big cleanup "didn't free anything".

Read-only checks:

```sh
tmutil listlocalsnapshots /                        # com.apple.TimeMachine.2026-09-24-101112.local …
tmutil listlocalsnapshotdates /                    # just the dates
diskutil apfs listSnapshots /System/Volumes/Data   # every snapshot of the Data volume, not only Time Machine's
```

To free the space sooner (tell the user what each command does, and run it
only if they ask; some need `sudo`):

```sh
tmutil thinlocalsnapshots / 999999999999 4   # ask macOS to reclaim up to ~1 TB, urgency 4 (highest)
tmutil deletelocalsnapshots 2026-09-24-101112 # delete one snapshot by date
tmutil deletelocalsnapshots /                # delete all local snapshots on the volume
```

Deleting local snapshots does **not** touch backups on the Time Machine disk.
It only removes the on-Mac restore points from the last day. Leave the
`com.apple.os.update-*` snapshot that `diskutil apfs listSnapshots /` shows
alone. It is the sealed system volume, not user data. macOS also thins
snapshots automatically when free space runs low, so "wait a day" is a valid
answer when the user isn't in a hurry.

## Usual hotspots

Look here with `diskhound_list_folder` (replace `~` with the user's home
path):

| Path | What it is | Cleanup |
| --- | --- | --- |
| `~/Library/Developer/Xcode/DerivedData` | Build intermediates | Safe to delete; Xcode rebuilds. |
| `~/Library/Developer/Xcode/iOS DeviceSupport` | Symbols per iOS version | Old versions are safe to delete. |
| `~/Library/Developer/CoreSimulator` | Simulator devices and runtimes | `xcrun simctl delete unavailable`; `xcrun simctl runtime list` then `xcrun simctl runtime delete <id>`. |
| `~/Library/Containers/com.docker.docker` | Docker Desktop disk image (`Docker.raw`) | `docker system df`, then `docker system prune` (it also removes stopped containers, so ask). Docker Desktop > Settings > Resources sets the image size. |
| `~/Library/Application Support/MobileSync/Backup` | iPhone/iPad backups | Finder > device > Manage Backups. User data: ask. |
| `~/Library/Caches` | App caches | Mostly regenerable. Quit the app first. |
| `~/Library/Mail`, `~/Pictures/Photos Library.photoslibrary` | App-managed libraries | Use the app (e.g. Photos > Settings > iCloud > Optimize Mac Storage). Never delete inside a library. |
| `~/Library/Mobile Documents` | iCloud Drive | Right-click > Remove Download keeps the file in iCloud. |
| `~/Downloads`, `~/Desktop` | Installers, archives, disk images | User data: ask. `.dmg`/`.pkg`/`.zip` installers are usually safe once installed. |
| `/Library/Updates`, `/private/var/folders` | OS update staging, per-user temp | Leave to macOS; a reboot clears much of it. |
| `$(brew --cache)`, `/opt/homebrew/Cellar` | Homebrew downloads and old versions | `brew cleanup --prune=all`, `brew autoremove`. |

For developer caches (npm, pnpm, cargo, Gradle, pip, Go, …) see
[developer-caches.md](developer-caches.md).
