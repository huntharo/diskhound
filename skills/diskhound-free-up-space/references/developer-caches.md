# Developer caches and build output

`diskhound_dev_artifacts` finds these trees and names the project that owns
each one. Almost everything here is regenerable, but "regenerable" can still
mean a long rebuild or a big download. Say so when a tree is large.

Before removing anything inside a project:

- **Git worktrees.** Check `git -C <worktree> status` and
  `git -C <worktree> log @{u}..` for uncommitted or unpushed work. Then
  remove with `git worktree remove <path>` from the main checkout, not by
  deleting the folder, and run `git worktree prune` afterwards.
- **Shared storage.** pnpm uses APFS clones on macOS and hardlinks on Linux.
  Removing one `node_modules` frees little while other projects or the store
  still share it. See [macos.md](macos.md#apfs-clones) and
  [linux.md](linux.md#shared-storage).

| Ecosystem | Where it lives | Cleanup |
| --- | --- | --- |
| Node: project deps | `<project>/node_modules` | Delete the folder; `npm install` / `pnpm install` / `bun install` restores it. |
| npm | `~/.npm/_cacache` (`%LOCALAPPDATA%\npm-cache` on Windows) | `npm cache clean --force` |
| pnpm | `pnpm store path` | `pnpm store prune` (removes packages no project references) |
| Yarn | `yarn cache dir` | `yarn cache clean` (Berry: `yarn cache clean --all`) |
| Bun | `~/.bun/install/cache` | `bun pm cache rm` |
| JS build output | `dist/`, `build/`, `.next/`, `.turbo/`, `.nuxt/`, `.parcel-cache/` | Delete; the next build recreates it. |
| Rust | `<project>/target` | `cargo clean` in the project. |
| Cargo registry | `~/.cargo/registry` | Deleting `~/.cargo/registry/cache` and `src` is safe; Cargo re-downloads. |
| Go | `go env GOCACHE`, `go env GOMODCACHE` | `go clean -cache`, `go clean -modcache` |
| Python venvs | `<project>/.venv`, `venv/` | Delete; recreate from `requirements.txt` / `pyproject.toml`. |
| pip / uv / conda | `pip cache dir`, `uv cache dir`, `conda info` | `pip cache purge`, `uv cache clean`, `conda clean --all` |
| Hugging Face / model caches | `~/.cache/huggingface`, `~/.ollama/models`, LM Studio model folders | User-downloaded models; ask. `huggingface-cli delete-cache` helps choose. |
| Gradle | `~/.gradle/caches`, `<project>/.gradle`, `<project>/build` | Stop daemons (`./gradlew --stop`), then delete `~/.gradle/caches`. |
| Maven | `~/.m2/repository` | Safe to delete; re-downloads on next build. |
| .NET | `~/.nuget/packages`, `<project>/bin`, `<project>/obj` | `dotnet nuget locals all --clear`; delete `bin`/`obj`. |
| Xcode | DerivedData, Archives, DeviceSupport, simulators | See [macos.md](macos.md#usual-hotspots). Archives hold the dSYMs for shipped builds, so ask first. |
| Android | `~/.android/avd`, `$ANDROID_HOME/system-images`, `$ANDROID_HOME/ndk` | Delete unused emulators in Android Studio's Device Manager; uninstall old SDK parts with the SDK Manager. |
| Docker | Images, build cache, volumes | `docker system df`; `docker builder prune`; `docker image prune -a`; `docker volume prune` deletes data, so ask. |
| Homebrew | `brew --cache`, old kegs | `brew cleanup --prune=all`, `brew autoremove` |
| ccache / sccache | `ccache -s`, `sccache --show-stats` | `ccache -C`; stop sccache and delete its cache directory. |
| CMake builds | `build/`, `cmake-build-*` | Delete; reconfigure to rebuild. |
| IDE caches | JetBrains `caches`/`index`, VS Code `CachedData`, `CachedExtensionVSIXs` | Quit the IDE first. JetBrains: File > Invalidate Caches. |
