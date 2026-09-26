# Linux: where space hides

DiskHound scans stay on one filesystem. Scan `/`, and separately scan
`/home` or any other mount the user cares about if it is its own
filesystem. `diskhound_status` lists the mounts it sees.

## When "used" is much bigger than the scan total

| Cause | Check (read-only) | How it gets freed |
| --- | --- | --- |
| btrfs snapshots (Snapper, Timeshift) | `sudo btrfs subvolume list -s /`, `snapper list`, `sudo timeshift --list` | `snapper delete <n>`, `sudo timeshift --delete --snapshot '<name>'`, or the tool's retention settings. |
| ZFS snapshots | `zfs list -t snapshot -o name,used,refer` | `zfs destroy pool/fs@snap`. This is destructive; confirm with the user first. |
| Deleted files still held open | `sudo lsof -nP +L1` | Restart the process holding them (often a log writer or a database). |
| ext4 reserved blocks (usually 5 %, for root) | `sudo tune2fs -l <device>` (the "Reserved block count" line) | Normal. Explains a `df` gap; only change it on data-only disks. |
| Other mounts under the scan root | `findmnt`, `df -h` | Scan them as separate roots. |
| Files the scan could not read | `skippedEntries` in `diskhound_scan_summary` | Some root-owned directories need elevated rights; `sudo du -xsh <dir>` confirms their size. |

## Shared storage

- **Hardlinks.** DiskHound counts every hardlinked path at full size on
  Linux, so trees of hardlinks look bigger than the space they use. pnpm
  hardlinks `node_modules` to its store by default. Find multi-link files
  with `find <dir> -xdev -type f -links +1`. Space returns only when the
  last link is removed. For pnpm: remove the unneeded `node_modules`, then
  run `pnpm store prune`.
- **Reflinks.** `cp --reflink` copies on btrfs or XFS, and some package
  managers, share extents like APFS clones. Every copy must go before the
  extents are freed. On btrfs, `compsize <dir>` (package `btrfs-compsize`)
  shows real on-disk usage including shared and compressed extents.

## Built-in cleanup

| Area | Check | Cleanup |
| --- | --- | --- |
| systemd journal | `journalctl --disk-usage` | `sudo journalctl --vacuum-size=500M` |
| apt / dnf / pacman caches | `du -sh /var/cache/apt /var/cache/dnf /var/cache/pacman` | `sudo apt clean`, `sudo dnf clean all`, `paccache -r` |
| Old snap revisions | `snap list --all` (look for `disabled`) | `sudo snap remove <name> --revision <rev>`; `sudo snap set system refresh.retain=2` |
| Flatpak runtimes | `flatpak list --runtime` | `flatpak uninstall --unused` |
| Docker / Podman | `docker system df`, `podman system df` | `docker system prune` removes stopped containers too, so ask; add `-a` for unused images; `--volumes` deletes data |
| Old kernels | `dpkg -l 'linux-image-*'` | `sudo apt autoremove --purge` removes every package nothing depends on, not only kernels: show the user its list (`apt autoremove --dry-run`) first. |
| Trash | `~/.local/share/Trash` | Empty from the file manager, or `gio trash --empty`. |
| Thumbnails and caches | `~/.cache` | Mostly regenerable; quit apps first. |

For developer caches (npm, pnpm, cargo, Gradle, pip, Go, …) see
[developer-caches.md](developer-caches.md).
