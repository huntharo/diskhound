# Dev artifact classification evidence

The native scanner (`dev_artifacts.rs`) and TypeScript readers
(`devArtifacts.ts`) use the same path rules. Project markers name the
owning project; they do not provide language evidence to descendants.
A root Cargo.toml in a mixed monorepo cannot turn a JVM module into Rust.

| Evidence | Classification scope |
| --- | --- |
| `target` alone; `target/debug`, `target/release`, `target/doc` | Unclassified |
| `target/{debug,release}/{deps,incremental,.fingerprint}` | Rust: the final subtree only |
| Same Cargo layout with a target triple before the profile | Rust: the final subtree only |
| `target/scala-2.<version>` or `target/scala-3[.<version>]` | JVM / Scala: the versioned subtree only |
| `target/{maven-status,maven-archiver}` | JVM: the final subtree only |
| `build`, `dist`, `out` alone | Unclassified |
| Existing tool conventions such as `node_modules`, `.next`, `.gradle`, `.m2` | Their existing tool bucket |

The Cargo rules follow its [build cache layout](https://doc.rust-lang.org/cargo/reference/build-cache.html)
and [fingerprint layout](https://doc.rust-lang.org/stable/nightly-rustc/cargo/core/compiler/fingerprint/index.html).
Scala follows sbt's [cross-build layout](https://www.scala-sbt.org/1.x/docs/Cross-Build.html).

These are structural heuristics, not proof that a directory is safe to
delete. The unchanged single-name tool conventions can still match a
user-created folder with that name. Ambiguous output is deliberately
omitted: standalone binaries, Cargo custom profiles/target directories,
Maven `target/classes`, sbt's unversioned auxiliary output, and generic
frontend `dist` directories need additional evidence before inclusion.
Do not promote an entire parent tree based on one matching child: it can
contain files belonging to other tools or the user.

Saved Rust/JS roots are checked against current rules before display or
rescan. Old broad guesses are hidden rather than relabeled with their
old byte totals. Run a new full scan to discover the narrower subtrees;
the Dev Artifacts rescan only refreshes known valid roots. The UI marks
these saved reports as incomplete, including after refreshing or deleting
known roots. A new full scan produces a report without this notice.

The shared bucket is labeled **Gradle / JVM**, with Java, Maven and Scala/sbt in
the full label. `.gradle` and `.m2` have always belonged to this bucket;
they are not evidence that the project uses Scala.

Tests share `src/test/fixtures/devArtifactClassification.json` across
Rust and TypeScript, expand it across case/separator/UNC variants, and
fuzz ambiguous path segments with a fixed seed. Integration tests cover
marker order, mixed Cargo/sbt projects, directory rollups, legacy reports,
and Easy Mode suggestions. Folder-tree scaling tests grow input and
artifact counts 8x and assert operation counts, not elapsed time.
