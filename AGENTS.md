# DiskHound agent notes

## Changelog

Do not edit `CHANGELOG.md` on a feature branch. Those notes are written once, when a version ships, from the merged pull requests. Follow `.agents/skills/release/SKILL.md`. CI rejects any other changelog edit.

## SSD write budget

DiskHound keeps its state in JSON and gzipped NDJSON files under Electron's userData, and it runs for days in the tray. A small write on a timer adds up on the user's SSD.

- Any write that runs per event, per tick or on a timer needs a checked-in budget.
  - Wrap the feature, not its setup, in `measureFsIo`, and check it with `expectIoBudget`. Both are in `src/test/ioBudget.ts`, which shows the two `vi.mock` lines a test file needs.
  - Budgets live in `src/test/io-budgets.json`. Name the test `<module>.ioBudget.test.ts`.
- Budgets count calls, and they must match exactly. A lower count also fails, because the budget is stale.
- Bytes are recorded as `observedBytesWritten` but not asserted. Use fixtures at realistic sizes so the bytes mean something.
- Record or change a budget with `UPDATE_IO_BUDGETS=1 bun run test <file>`, and commit the JSON diff.
- In each scenario's note, project writes/day and MB/day at the default settings and at the most aggressive setting, such as the 1-minute monitoring interval.
- Write only when something changed. Compare against what is on disk, keep a dirty flag, debounce bursts, and flush at quit.
- If a design projects badly, report the numbers to the user and ask before shipping it. Thousands of writes a day, or tens of MB a day of rewritten content, projects badly.

## Read budgets for IPC and UI

The same harness budgets reads. A UI action on data the app already holds (sort, filter, group, hover, drill-in, a tab remount, a poll) should read nothing. Its budget locks that at 0.

- **IPC handlers.** `src/test/mainProcessHarness.ts` boots the real `src/main.ts` against a fake `electron` and a temp profile. `invoke()` calls the handlers the app ships, so there is no need to move a handler out of main.ts to test it.
  - `src/test/mainProfileFixture.ts` seeds the profile: scan history, indexes, folder-tree and Dev sidecars at realistic sizes.
  - Boot once per test file. main.ts keeps its caches in module state, so a scenario that needs a cold process needs its own file.
  - Bundled workers are not built under vitest, so a worker always fails there. Budget the failure path with that. The success path belongs in E2E.
  - See `src/__tests__/main.*.ioBudget.test.ts`.
- **Renderer views.** `src/test/rendererHarness.ts` loads the real preload on top of that main process and mounts views in happy-dom. Every `nativeApi` call runs the real handler.
  - Settle the mount, then budget the clicks.
  - Assert `takeIpc()` too, where the answer should be no IPC at all.
  - See `src/__tests__/renderer.views.ioBudget.test.ts`.
- **Polls.** Pass `{ countProcesses: true }` to `measureFsIo` to also count child processes and workers. A poll that runs `df`, PowerShell or a sampler per tick needs that.
  - Renderer pollers use `startVisiblePoll` or `useVisibleInterval` from `src/renderer/lib/visiblePoll.ts`, so they stop while the window is hidden to the tray. `e2e/tray.spec.ts` checks that no process starts while hidden.

## E2E

`bun run test:e2e` runs the Playwright suite in `e2e/` against the built app and the native scanner. CI runs it on Linux, Windows and macOS. Read `e2e/AGENTS.md` before adding a spec.

## Scaling tests

New code that loops over per-file or per-folder collections needs a scaling test that counts operations, not time: run it at N and 8N and assert the count grows at most about 16× (twice the linear 8×), plus an absolute cap. If the cost also grows with a list limit or a folder count, grow that 8× too, or an O(N·limit) loop looks linear. See `scaling_tests` in `native/diskhound-native-scanner/src/main.rs` (it counts `work::step()`) and `src/scan/__tests__/scanWorkerScaling.test.ts` (it counts reads through getters and proxies).
