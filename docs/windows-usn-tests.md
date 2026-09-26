# Windows USN regression tests

Run the native tests from a Windows terminal:

```powershell
cargo test --manifest-path native/diskhound-native-scanner/Cargo.toml usn_journal -- --nocapture
```

Run the real scanner-to-JS-index integration tests:

```powershell
bun run test:usn:windows
```

The second command builds the debug scanner, then runs the Windows Vitest
integration suite without starting Electron. `bun run test` also includes
that suite when the debug scanner is already built. An optional
`DISKHOUND_NATIVE_SCANNER_PATH` selects another scanner executable.

## Local access and CI

Real journal tests need an existing NTFS journal on the temp directory's
volume and a process allowed to read it, normally an elevated terminal.
Local tests report a skip when these prerequisites are unavailable; they
never request elevation or create/enable/resize/delete a journal. Use
`--nocapture` with Cargo to see the skip reason.

To make missing access an error, set:

```powershell
$env:DISKHOUND_REQUIRE_USN_TESTS = "1"
```

Windows CI sets this flag for both Cargo and Vitest, and builds the debug
scanner before Vitest. It cannot pass by returning early when the scanner
or journal is unavailable. Once preflight succeeds, subsequent failures
always fail the test, including on developer machines.

## Isolation and cleanup

Every test exclusively creates a unique directory under the OS temp
directory. Files, indexes, and fixture subdirectories stay inside it.
Cleanup uses Rust drop guards or JavaScript `finally`, including failures
and local prerequisite skips. Concurrent runs do not reuse directories.

The permission test creates a new file containing synthetic bytes and
saves its original DACL. It denies `FILE_READ_ATTRIBUTES` on that file
only, verifies that the real `OpenFileById` path fails, then restores the
DACL and verifies the file can still be read. A separate test verifies
restoration during panic unwinding. It changes no parent ACLs, inherited
policies, account privileges, or pre-existing files. A forcibly terminated
process can leave its own synthetic temp fixture behind; it cannot affect
an existing developer file.

The integration suite calls the scanner and `runIncrementalScan` directly.
Baseline and comparison scans pass `DISKHOUND_NO_MFT=1` only to those child
processes so they walk the tiny fixture instead of enumerating the entire
volume's MFT. The incremental step still reads the real USN journal.
The suite does not launch Electron, use an installed DiskHound profile, or
touch startup registration. The volume handle is read-only. Like any filesystem
test, creating fixture files generates ordinary journal entries; the tests
do not alter journal configuration or other volume data.

## Coverage and limits

- Real journal records for creation, deletion, Unicode renames, and repeated
  renames across parents.
- Real access denial with an accessible parent, plus deterministic resolver
  failure coverage for create, modify and rename records.
- A deleted parent leaves the unresolvable child counted as dropped; this
  test documents uncertainty, not complete deleted-subtree reconstruction.
- The native executable's real journal output feeds the JS updater and a
  gzipped index. Tests cover moves into/out of the root, create-then-delete,
  rename-back, and reusing an old path with a new file reference.
- The updated index's paths and allocated sizes match a fresh native scan.
  The baseline remains byte-for-byte intact, and a second tick from the
  returned cursor does not replay the changes.
- Operation-count scaling and exact write budgets remain covered by the
  portable aggregate and fake-journal suites.

These tests do not exhaust hardlink-name changes, parent-directory renames,
or concurrent modification races. They do not simulate journal recreation
or wraparound by changing a developer's volume.
