# e2e: agent notes

Playwright drives the built Electron app (`dist-electron/main.cjs`)
and the native scanner, the same pair that ships. CI runs the suite
on Linux, Windows and macOS (the `E2E` jobs in
`.github/workflows/ci.yml`).

## Run

```bash
bun run test:e2e                      # builds, then runs every spec
bun run test:e2e -- --grep restart    # extra args go to playwright test
```

`build:e2e` does four things:
1. It runs Electron's own installer. Since Electron 42 the package has
   no postinstall and downloads its binary on first use; this fetches
   it before the first test starts.
2. It builds the debug scanner.
3. It builds the renderer.
4. It builds main.

It skips `bun run build`, which rewrites `build/icon*.png`. On Linux
wrap the command in `xvfb-run --auto-servernum`.

- **Use Node 22.12 or later.** Electron's installer requires it. Node 24
  and 26 both work.
- **The scanner is required.** The fixture pins
  `native/diskhound-native-scanner/target/debug/diskhound-native-scanner`,
  or `DISKHOUND_NATIVE_SCANNER_PATH` when set. It fails when the binary
  is missing. The JS worker fallback is not covered.

## How a test is isolated

- **Profile.** `--user-data-dir` points userData at a fresh temp dir
  per launch. Main keeps everything there: settings, scan history,
  indexes and crash.log. The single-instance lock is keyed on that
  dir, so a DiskHound the developer has open is left alone
  (`boot.spec.ts` checks both).
- **Linux HOME.** Every Linux startup writes a `.desktop` file and
  icons under `~/.local/share`. The fixture points HOME inside the temp
  dir so the developer's real ones survive.
- **Settings.** A fresh profile gets a `settings.json` with update
  checks and OS notifications off. Pass `launch({ settings })` to
  change more. Groups are merged one level deep, as `settingsStore`
  does.
- **Folder dialog.** `dialog.showOpenDialog` is stubbed in main.
  `handle.setPickDirectory(dir)` sets what "Browse for folder..."
  returns.
- **Scan tree.** The `scanTree` fixture writes five random-content
  files with known, distinct sizes under the test's output dir, not the
  OS temp dir. macOS temp resolves under `/private`, which is in
  DiskHound's default protected folders.

## Fixtures

- `launch(opts?)` returns `{ app, page, dataDir, userDataDir, ... }`.
  Pass `{ dataDir: earlier.dataDir }` to relaunch on the same profile.
  Every launch is closed after the test, and the profiles it created
  are removed. When a test fails, the window screenshot, crash.log,
  main-process output and renderer console are attached first.
- `fixtures/steps.ts` has the shared UI steps: `scanFolderFromPicker`,
  `waitForScanComplete` and `openTab`.
- The Playwright page is named `page`, not `window`. Inside
  `page.evaluate(() => window.diskhound...)`, a variable named `window`
  would shadow the browser global for TypeScript.

## Gotchas

- **On Windows, a local run can turn off an installed DiskHound's
  "Launch on startup".** Every launch calls `setLoginItemSettings`
  with the profile's `launchOnStartup`, which is false in a fresh
  profile. On Windows the entry is keyed by the AppUserModelId
  `com.diskhound.app`, the same one the installed app uses. `bun run
  dev` has the same effect. On macOS the unsigned Electron gets
  "Operation not permitted" in the main output, which is harmless.

## Known gaps

Pin a known bug with `test.fail(condition, reason)`. The test must
assert the correct behavior. Playwright then reports it as passing while
the bug exists, and as failing once the bug is fixed, so whoever fixes
the bug has to remove the mark.

- `links.spec.ts`, APFS clones (macOS only): a file and its clone count
  twice toward the scan total.
