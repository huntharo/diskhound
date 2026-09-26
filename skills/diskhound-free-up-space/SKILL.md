---
name: diskhound-free-up-space
description: Find what is using disk space and help the user reclaim it with the DiskHound app's MCP tools. Use when the user asks to free up space, clean up a full drive, or decide what to delete on macOS, Windows, or Linux. Covers space that deleting files does not release, such as APFS clones, Time Machine local snapshots, hardlinks, shadow copies, btrfs/ZFS snapshots, and deleted-but-open files.
license: MIT
compatibility: Requires the DiskHound desktop app with Settings > AI Agents enabled and its MCP server connected.
---

# Free up disk space with DiskHound

DiskHound keeps an index of every file on a scanned drive, so you can explore
sizes instantly without walking the disk yourself. Your job is to turn that
data into a short, trustworthy list of things the user can remove, and to make
sure removing them actually gives the space back.

## Ground rules

- **Never delete on your own.** The only delete path is
  `diskhound_move_to_trash`. DiskHound shows the user a confirmation dialog
  for every call, and items go to the Trash / Recycle Bin, not away forever.
- **Prefer the owning tool.** Package caches, containers, simulators, and
  snapshots have their own cleanup commands (`pnpm store prune`,
  `docker system prune`, `xcrun simctl delete unavailable`, `tmutil`, …).
  Those commands know what is still referenced. Suggest them. Run read-only
  diagnostics yourself if your host allows shell commands, but **ask before
  running anything that deletes**.
- **Leave system areas alone**: `/System`, `/usr`, `/private/var/db`,
  `C:\Windows`, `C:\Program Files`, `/boot`, `/var/lib/dpkg`, app bundles, and
  anything under a DiskHound protected folder. The OS has its own tools for
  those (see the platform references).
- **Let the user watch.** Pass `showInApp: true` on read tools, or call
  `diskhound_show`, so the DiskHound window follows what you are looking at.
- **Sizes are bytes on disk** (allocated blocks), not logical file length.
  Sparse files such as `Docker.raw` or VM disks show what they really occupy.

## Procedure

### 1. Measure the gap

Call `diskhound_status`. Note each drive's free space and total size, what the
user wants (a number such as "50 GB", or "whatever is safe"), and which roots
have been scanned and how long ago.

### 2. Get a fresh scan

If the drive the user cares about has no scan, or the newest one is more than
about a day old, call `diskhound_start_scan` on the drive root (`/` on macOS
and Linux, `C:\` on Windows; `/home` is fine on Linux if that is its own
filesystem). Repeat scans are incremental and fast. Poll `diskhound_status`
until the root leaves `activeScans`.

### 3. Account for the whole drive before hunting

Compare the drive's **used** space (from `diskhound_status`) with the scan's
total (from `diskhound_scan_summary`). A small difference is normal. A large
one (more than about 10 % of the drive, or tens of GB) means space is held
somewhere the file scan cannot see. Deleting files will not fix that part, so
explain it first. Read the platform reference for the causes and the
read-only commands that confirm each one:

- macOS: [references/macos.md](references/macos.md). Usual causes are Time
  Machine local snapshots, other APFS volumes in the same container,
  swap/sleepimage, and purgeable space.
- Windows: [references/windows.md](references/windows.md). Usual causes are
  System Restore shadow copies, `hiberfil.sys`/`pagefile.sys`, and folders
  the scan could not read.
- Linux: [references/linux.md](references/linux.md). Usual causes are
  btrfs/ZFS snapshots, reserved blocks, deleted-but-open files, and other
  mounts.

### 4. Walk the tree, biggest first

Start at the scan root with `diskhound_list_folder` (`showInApp: true`), then
follow the largest folders down a few levels. Stop descending when a folder
clearly belongs to one app or one project. At that point you know who owns
it. `diskhound_scan_summary` gives the heaviest folders and largest files in
one call when you want a shortcut.

### 5. Run the targeted sweeps

- `diskhound_dev_artifacts`: `node_modules`, Rust `target/`, build output,
  venvs, package caches, git worktrees. Developer machines often have tens
  of GB here. See [references/developer-caches.md](references/developer-caches.md)
  for the right cleanup command per ecosystem.
- `diskhound_cleanup_suggestions`: temp files, caches, old downloads,
  installers, logs, large media, each with a risk level.
- `diskhound_search_files` with `minSizeBytes: 1073741824` (1 GiB) and no
  query finds every huge file. Also try `.iso`, `.dmg`, `.vmdk`, `.vhdx`,
  `.qcow2`, `.zip`, `.mov`, `.mkv`, `.ipsw`.
- Duplicates are slow on a whole drive. Run `diskhound_find_duplicates` on
  specific folders (Downloads, Desktop, media libraries), then
  `diskhound_duplicates`.

### 6. Classify every candidate

Put each finding in exactly one bucket:

| Bucket | Examples | What to do |
| --- | --- | --- |
| **Regenerable** | build output, `node_modules`, DerivedData, caches | Safe to remove; it comes back when needed. |
| **Owned by a tool** | Docker images, pnpm/npm/cargo stores, simulators, Homebrew, WSL disks, snapshots | Use the tool's own cleanup command. |
| **User data** | videos, photos, archives, downloads, VM images, iOS backups | Ask. Offer to reveal it (`diskhound_reveal_path`) or move it to another drive (DiskHound's Easy Move tab). |
| **System / hands off** | OS folders, app bundles, mail/photos library internals | Point to the OS or app setting instead. |

### 7. Check that removal will free the space

Before promising a number, check each candidate against this list. When one
applies, say so plainly and give the realistic amount.

- **Trash / Recycle Bin.** Nothing is freed until the Trash is emptied.
  DiskHound only moves items to the Trash.
- **APFS clones (macOS).** Files copied with `clonefile` share blocks until
  one copy changes. This includes pnpm's `node_modules` on APFS, copies made
  in Finder on the same volume, and `cp -c`. **The blocks are freed only when
  every clone that shares them is deleted.** Deleting one project's
  `node_modules` often frees very little while the pnpm store and other
  projects still hold clones. Details and how to test:
  [references/macos.md#apfs-clones](references/macos.md#apfs-clones).
- **Time Machine local snapshots (macOS).** Anything deleted since the last
  local snapshot stays allocated until that snapshot expires (usually within
  24 hours) or is thinned. Free space may not move right away, even after
  emptying the Trash. See
  [references/macos.md#time-machine-local-snapshots](references/macos.md#time-machine-local-snapshots).
- **Hardlinks.** One file can appear at several paths. On macOS and Linux,
  DiskHound counts every path at full size, so hardlinked trees look bigger
  than they are. Examples are pnpm stores on Linux and old HFS+ Time Machine
  backups. Space returns only when the last link is gone. Windows scans made
  with the native MFT reader count each file once.
- **Snapshots elsewhere.** Windows System Restore / Volume Shadow Copies,
  btrfs subvolume snapshots (Snapper, Timeshift), and ZFS snapshots all pin
  deleted data.
- **Reflinks (Linux).** `cp --reflink` copies on btrfs or XFS share extents
  the same way APFS clones do.
- **Deleted but open (Linux/macOS).** A process holding a deleted file keeps
  its space until the process exits. Find these with `lsof +L1`.
- **Growable disk images.** WSL/Docker `.vhdx` files, `Docker.raw`, and VM
  disks do not shrink when you delete inside them. Compact them with the
  platform tool.

### 8. Act, then verify

1. Present a table: path, size, bucket, how confident you are that removal
   frees it, and how to remove it. Order by size. Keep it short; the user
   can ask for more.
2. For items the user approves:
   - Run the owning tool's command, if they asked you to.
   - Otherwise call `diskhound_move_to_trash` with a one-line `reason`,
     batching related paths into one call.
3. Remind the user to empty the Trash. On macOS, mention that Time Machine
   snapshots may hold the space for up to a day.
4. Call `diskhound_status` again and report the change in free space. If it
   is much smaller than expected, go back to step 7. Snapshots and clones are
   the usual reasons.
5. Offer a follow-up `diskhound_start_scan`. The Changes tab
   (`diskhound_changes`) then shows exactly what went away.

## When the user asks "what filled my disk?"

That is a different question. Load the `diskhound-investigate-growth` skill
(`skill://diskhound-investigate-growth/SKILL.md`), which compares scans over
time.
