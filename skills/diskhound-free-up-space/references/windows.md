# Windows: where space hides

Scan `C:\` (and any other drive the user cares about). When DiskHound runs
elevated it reads the NTFS Master File Table directly. That is much faster,
it sees folders a normal user cannot open, and it counts each hardlinked file
**once**. Settings > Performance in DiskHound sets this up.

## When "used" is much bigger than the scan total

| Cause | Check (read-only; some need an admin terminal) | How it gets freed |
| --- | --- | --- |
| System Restore / Volume Shadow Copies | `vssadmin list shadowstorage` | System Properties > System Protection > Configure (lower Max Usage, or Delete restore points). |
| Hibernation file | `Get-Item -Force C:\hiberfil.sys` (PowerShell) | `powercfg /hibernate off` (admin) if the user never hibernates. |
| Page file | `Get-Item -Force C:\pagefile.sys` (PowerShell) | Leave it to Windows unless the user knows why they're changing it. |
| Folders the scan could not read | `skippedEntries` in `diskhound_scan_summary` | Run DiskHound elevated (Settings > Performance) and rescan. |
| Recycle Bin on each drive | `C:\$Recycle.Bin` | Empty it in Explorer, or `Clear-RecycleBin -DriveLetter C` (PowerShell). |

## Things that look big but aren't (or won't shrink)

- **`C:\Windows\WinSxS`** is mostly hardlinks into `C:\Windows\System32`, so
  Explorer overstates it. Never delete inside it. Measure and clean it with
  `Dism.exe /Online /Cleanup-Image /AnalyzeComponentStore`, then
  `Dism.exe /Online /Cleanup-Image /StartComponentCleanup` (admin).
- **`C:\Windows\Installer`, `C:\ProgramData\Package Cache`**: deleting these
  breaks uninstall and repair. Leave them alone.
- **WSL 2 and Docker Desktop disks** (`ext4.vhdx`, `docker_data.vhdx`, under
  `%LOCALAPPDATA%`) grow but never shrink on their own. Deleting files
  inside the Linux distro does not return space to Windows until the disk is
  compacted:
  - Run `wsl --manage <Distro> --set-sparse true` once (recent WSL), or
  - Run `wsl --shutdown`, then `Optimize-VHD -Path <path.vhdx> -Mode Full`
    (Hyper-V PowerShell module), or use diskpart's `compact vdisk`.
  - For Docker: `docker system prune` first (it also removes stopped
    containers, so ask), then compact.
- **OneDrive placeholders.** Files On-Demand that are cloud-only use almost
  no space. Right-click > "Free up space" turns downloaded files back into
  placeholders.
- **Hardlinks elsewhere.** With the MFT scanner, DiskHound counts them once.
  Explorer and many tools count each link.

## Built-in cleanup

- **Settings > System > Storage > Temporary files** covers Windows Update
  cleanup, Delivery Optimization, previous Windows installations
  (`C:\Windows.old`), thumbnails, and the Recycle Bin. Storage Sense can
  automate it.
- **Disk Cleanup** (`cleanmgr`) > "Clean up system files" does the same on
  older builds.
- Delete `C:\Windows.old` only through those tools; the folder is protected.

## Usual hotspots

| Path | What it is | Cleanup |
| --- | --- | --- |
| `%LOCALAPPDATA%\Temp` | Per-user temp | Mostly safe; skip files in use. |
| `C:\Windows\SoftwareDistribution\Download` | Update downloads | Temporary files > Windows Update Cleanup. |
| `%LOCALAPPDATA%\Packages\<distro>\LocalState\ext4.vhdx` | WSL 2 disk | Clean inside the distro, then compact (above). |
| `%LOCALAPPDATA%\Docker\wsl` | Docker Desktop data | `docker system prune` (ask: it removes stopped containers), then compact. |
| `%USERPROFILE%\Downloads` | Installers, archives, ISOs | User data: ask. Installers (`.exe`, `.msi`) are usually safe once installed. |
| `%APPDATA%\Apple Computer\MobileSync\Backup` or `%USERPROFILE%\Apple\MobileSync\Backup` | iPhone backups | Manage in iTunes / Apple Devices. User data: ask. |
| `%LOCALAPPDATA%\NVIDIA\DXCache`, `%LOCALAPPDATA%\D3DSCache` | Shader caches | Regenerable. |
| `C:\Users\<user>\AppData\Local\Microsoft\Windows\INetCache`, browser profiles | Web caches | Clear from the browser's settings. |
| Game libraries (`Steam\steamapps`, `Epic Games`, `XboxGames`) | Installed games | Uninstall from the launcher, never by deleting folders. |

For developer caches (npm, pnpm, NuGet, cargo, Gradle, pip, Go, …) see
[developer-caches.md](developer-caches.md).
