---
name: diskhound-investigate-growth
description: Explain why a drive lost free space by comparing DiskHound's scan history with its MCP tools. Use when the user asks what filled their disk, what grew this week, or why free space keeps dropping. Also covers growth no file scan can see, such as local snapshots, shadow copies, and deleted-but-open files.
license: MIT
compatibility: Requires the DiskHound desktop app with Settings > AI Agents enabled and its MCP server connected.
---

# Why did my disk fill up?

DiskHound keeps several past scans per drive (Settings > Storage sets how
many) and can diff any two of them. Use that history to name what grew,
when, and which app or project owns it.

## Procedure

1. **Establish the timeline.** Call `diskhound_status` for current free
   space, then `diskhound_scan_history` for the root. Ask the user roughly
   when space started disappearing, if they know.

2. **Make sure there is something to compare.**
   - With only one scan, start a new one (`diskhound_start_scan`,
     `showInApp: true`). The first diff will cover only the time since the
     old scan.
   - Suggest scheduled rescans (Settings > Drive Monitoring > full rescan
     interval) so future questions have history.
   - If the newest scan is stale, rescan first so the diff reaches today.

3. **Get the overview.** Call `diskhound_changes` with `detail: "summary"`
   and `showInApp: true`. Pick `since` to match the user's timeline (`1d`,
   `1w`, `1M`), or pass `baselineId` from the history. Read:
   - `net`: total growth between the scans.
   - `folders`: the directories that moved most. This is usually the answer.
   - `fileTypes`: e.g. `.log`, `.mov`, `.vhdx` growing points at the
     culprit.

4. **Drill in.** For each large growing folder:
   - Call `diskhound_list_folder` on it (`showInApp: true`) to see which
     child grew.
   - For exact files, call `diskhound_changes` with `detail: "files"`. It
     walks the full per-file index and can take a while on big drives.
   - Name the owner: an app's cache, a project's build output, a VM or
     container disk, a sync client, a log that never rotates.

5. **Compare with what the OS says.** If free space fell by much more than
   the diff's `net`, the growth is outside the files DiskHound indexed:
   - **macOS**: Time Machine local snapshots grow with every change since
     the last snapshot (`tmutil listlocalsnapshots /`), swap grows under
     memory pressure (`ls -lh /private/var/vm`), and other APFS volumes
     share the container (`diskutil apfs list`).
   - **Windows**: System Restore shadow copies (`vssadmin list shadowstorage`),
     and WSL/Docker `.vhdx` disks that grew and never shrink.
   - **Linux**: btrfs/ZFS snapshots, deleted-but-open files
     (`sudo lsof -nP +L1`), and a growing systemd journal
     (`journalctl --disk-usage`).

   Details for each are in the `diskhound-free-up-space` skill's platform
   references (`skill://diskhound-free-up-space/references/macos.md`,
   `…/windows.md`, `…/linux.md`).

6. **Report.** Give a short explanation first: "About 38 GB went into Docker's
   disk image and 12 GB into Xcode DerivedData since last Tuesday." Follow
   with a table of the top movers: path, change, owner, and whether it will
   keep growing. If the user wants to reclaim space, switch to the
   `diskhound-free-up-space` skill (`skill://diskhound-free-up-space/SKILL.md`).

## Reading the numbers

- Sizes are bytes on disk. Sparse files (VM disks, `Docker.raw`) count
  only their allocated blocks.
- If `sizeSemanticsChanged` is true, the two scans measured sizes
  differently (an older DiskHound build on Windows). Compare folders, not
  the total.
- Summary lists are the biggest movers DiskHound tracked for each scan.
  `detail: "files"` is exhaustive.
