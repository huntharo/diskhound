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
1. It runs Electron's own installer. `bun install` skips it, because
   `trustedDependencies` in package.json lists only blake2.
2. It builds the debug scanner.
3. It builds the renderer.
4. It builds main.

It skips `bun run build`, which rewrites `build/icon*.png`. On Linux
wrap the command in `xvfb-run --auto-servernum`.

- **Use Node 24.** On Node 26, `node_modules/electron/install.js`
  exits 0 without extracting anything. Every launch then fails with
  "Electron failed to install correctly".
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
- **Agent port.** Each launch sets `DISKHOUND_AGENT_PORT` to a free
  port, so the MCP server never takes 51733 from a DiskHound the
  developer runs with AI agents on. `handle.agentPort` is the port;
  pass `launch({ agentPort })` to keep it across a restart.
- **Agent Trash.** `stubTrash(handle, dir)` answers the agent's Trash
  confirmation with the button the spec picks, and moves items into
  `dir` rather than the developer's real Trash or Recycle Bin.
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
- A launch that throws attaches the same files as
  `app-N-failed-launch-*`. Its main output starts when
  `electron.launch()` returns, so anything the app printed before then
  is missing.
- `handle.close()` is bounded. If the app has not exited 10 s after
  `app.close()`, its process tree is killed and the close throws.
  Playwright's own close has no timeout. It also closes every app it
  launched when the worker exits, so one app that never exits fails
  worker teardown ("Worker teardown timeout"), and with it the whole
  run, even when the retry passes.
- `fixtures/steps.ts` has the shared UI steps: `scanFolderFromPicker`,
  `waitForScanComplete` and `openTab`.
- `fixtures/agent.ts` plays an MCP agent. `signIn` runs the login
  `claude mcp login` does: it registers, opens `/authorize`, answers the
  real approval window, and exchanges the code for a token.
  `connectAgent` returns an MCP SDK client for that token.
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
- **A relaunch on a slow macOS runner once waited 30 s for `ready`.**
  In `scan.spec.ts`'s restart test, crash.log had `acquiring
  single-instance lock` and then `whenReady fired` 31 s later, and
  `firstWindow` timed out. The lock was not the cause. Playwright's
  loader holds `app.whenReady()` back until the launch has attached,
  then until Electron's own `ready`. The launch took 1 s, and a main
  thread blocked at the lock holds the launch up for as long as it is
  blocked. So the wait was for Electron's `ready` itself. It ended as
  Playwright's close sent `app.quit()`, and the app never exited after
  that. The cause is unknown. If it comes back, read
  `app-N-failed-launch-main-output.txt`.

## Known gaps

Pin a known bug with `test.fail(condition, reason)`. The test must
assert the correct behavior. Playwright then reports it as passing while
the bug exists, and as failing once the bug is fixed, so whoever fixes
the bug has to remove the mark.

- `links.spec.ts`, APFS clones (macOS only): a file and its clone count
  twice toward the scan total.
