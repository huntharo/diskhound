# Machine attribution audit

The same saved `/` scan completed on 2026-09-27 at 12:03 EDT was replayed
through the original rules (`5d45837`), the first strict rules (`54f2b47`),
and the expanded cache rules (`a805f3a`). It contains 9,268,856 file records
and 666.583 GiB of recorded allocated bytes. Neither scans nor user files
were modified. Each file is counted once, with extra hardlinks contributing
zero bytes. Category totals reconcile exactly to the index.

These are uncapped classifier totals, not the UI's largest-root list or
unique APFS reclaimable space. Nested cached dependencies can move from
node_modules to their enclosing tool cache without losing coverage.

| Category | Original GiB | First strict GiB | Expanded GiB |
|---|---:|---:|---:|
| unclassified | 470.787 | 475.687 | 451.711 |
| node-modules | 169.480 | 169.560 | 169.127 |
| package-cache | 6.916 | 5.955 | 17.195 |
| jvm | 2.981 | 4.419 | 5.912 |
| rust-target | 8.044 | 5.295 | 5.812 |
| compiler-cache | 0.046 | 0.000 | 5.601 |
| python | 3.278 | 3.278 | 5.033 |
| dotnet | 0.000 | 0.046 | 3.684 |
| js-build | 4.543 | 1.837 | 1.837 |
| cargo-registry | 0.380 | 0.380 | 0.380 |
| go-module | 0.127 | 0.127 | 0.291 |
| worktree | 0.000 | 0.000 | 0.000 |

The expansion classifies **23.975 GiB** previously unclassified by the first
strict rules. **Zero previously classified bytes become unclassified** in
this expansion. Unclassified falls from **475.687 to 451.711 GiB**.

## Accounting for the original increase in unclassified

The first strict rules removed 4.945 GiB of original attribution and added
0.046 GiB elsewhere (net increase 4.900 GiB). This expansion recovers
1.505 GiB of that removed attribution, including Yarn Berry's cache,
Cargo build-script units, and installed runtimes inside recognized tool caches.
Every byte of the remaining 3.440 GiB falls into the following disjoint
path-based reasons; none is an unexplained accounting discrepancy.

| Reason for keeping it excluded | GiB |
|---|---:|
| Installed extensions/application state (not project output) | 1.164 |
| Ambiguous build/dist/out: path alone cannot distinguish output, source, or published assets | 0.953 |
| Cargo profile files without a recognized disposable subtree; no whole-profile deletion | 0.751 |
| Installed application, SDK, or system files | 0.252 |
| Installed plugin/action runtime assets | 0.207 |
| Tool binaries/settings or undocumented legacy cache layout; keep whole tool home excluded | 0.075 |
| JVM tool-home settings, daemon state and other non-cache children | 0.038 |
| Environment executables/configuration outside installed-package subtree | 0.001 |
| Ambiguous obj/pkg/mod: insufficient tool-specific evidence | 0.000 |

The Cargo remainder is a deliberate coverage limit, not a claim that those
files are source. It includes real build executables and custom output
outside the recognized subtrees. Deleting their parent based only on
`target/debug` would recreate the original problem. Covering those safely
requires contextual evidence and a deletion scope that excludes unknown
siblings; this change does not invent that evidence. The hashed build-script
units are now covered independently.

Similarly, an arbitrary project's `dist`/`out` may hold published assets,
recordings or hand-maintained files. Installed extension/application `dist`
folders are necessary runtime files. Removing their blanket attribution
is intentional. Tool binaries/settings remain outside cache roots.

## What remains unclassified

These broad inventory groups are mutually exclusive and account for the
entire remaining total. They describe locations, not deletion recommendations.

| Inventory group | GiB |
|---|---:|
| VM/container disks and state: may contain unique work | 112.668 |
| Other user application data, caches and runtimes: needs tool-specific review | 106.365 |
| System, installed software, shared runtimes and system state | 95.911 |
| Personal documents/media/downloads: preserve | 53.854 |
| Other source, tools and user data: no deletion evidence | 41.397 |
| Agent workspaces, history, tools and state: preserve unless proven disposable | 28.291 |
| Git history/metadata: preserve | 13.225 |

The largest individual candidates are VM disk images. VM and Docker disks
can contain unique files, databases and volumes; they are not rebuildable
caches by filename. Git history, source worktrees, personal media and agent
history likewise stay outside this expansion. Other application caches and
runtimes still offer potential coverage, but need their own documented
cleanup boundaries. The evidence does not support calling the entire
unclassified total disposable developer artifacts.

## Validation

Shared positive/negative corpus: 279 cases across path/case/UNC variants,
plus 2,000 seeded adversarial paths in each implementation. Native and
folder-reader scaling tests exercise the new layouts at N and 8N with an
absolute operation cap. Electron integration checks native sidecars and
folder-tree reconstruction against the same generated/configuration fixture.
The full TypeScript suite, typecheck, native classification tests and four
Electron artifact E2E tests pass.

Machine-specific paths and full CSV/JSON data are kept in the local audit
report rather than committed to the repository.

## Common-language follow-up

The subsequent common-language expansion adds 16.754 MiB on this same
saved scan: one Bundler `vendor/bundle/ruby/3.2.0/cache` tree. No other
category total decreases. This is deliberately broader platform/ecosystem
support, not a claim that every supported language is installed on the
audited machine. The shared corpus grows from 279 to 350 fixtures; see the
language coverage matrix in `dev-artifact-classification.md` for layouts
and explicit exclusions. The full TypeScript suite (703 tests), typecheck,
16 native classification tests and four Electron artifact tests pass.
