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
| `target/[<triple>/]{debug,release}/build/<crate>-<16 hex digits>` | Rust: the hashed build-script unit, including its generated output |
| `target/scala-2.<version>` or `target/scala-3[.<version>]` | JVM / Scala: the versioned subtree only |
| `target/{maven-status,maven-archiver}` | JVM: the final subtree only |
| `build`, `dist`, `out` alone | Unclassified |
| `.venv` / `venv` + `lib/[pythonX.Y/]site-packages`, or `.tox/<env>/lib/[pythonX.Y/]site-packages` | Python: installed packages subtree only |
| `venv`, `.venv`, `.tox` alone; `bin` / `Scripts` | Unclassified |
| `.yarn/{cache,unplugged}`, `.yarn/berry/cache`, `.npm/_cacache`; `.bun/install/cache` | Package caches: not patches, releases, plugins, global tools or binaries |
| `.gradle/caches`, `.gradle/<numeric-version>`, `.gradle/wrapper/dists`, `.m2/repository` | JVM: not the tool home or its settings/init scripts |
| `.nuget/packages`; `obj/{Debug,Release}/<net TFM>` | .NET: package cache or framework-specific intermediates, not arbitrary `obj` folders |
| `pkg/mod/cache/download`; `pkg/mod/<host>/…/<module>@v<semver>` | Go: downloads or a versioned module subtree only |
| `.cache/{ccache,sccache}`, `Library/Caches/{ccache,sccache}`, `AppData/Local/{ccache,sccache}`, macOS `Library/Caches/Mozilla.sccache`, Windows `AppData/Local/Mozilla/sccache` | Compiler caches: not a source repository named ccache/sccache |
| `CMakeFiles` | CMake metadata/output subtree only, not the enclosing `cmake-build-*` directory |
| `.vercel/{cache,output}`, `.netlify/cache`, `.output/{server,public}` | Frontend output: not deployment linking/configuration files |
| Distinctive conventions such as `node_modules`, `.next`, `__pycache__`, `.pytest_cache` | Their existing tool bucket |

The Cargo rules follow its [build cache layout](https://doc.rust-lang.org/cargo/reference/build-cache.html)
and [fingerprint layout](https://doc.rust-lang.org/stable/nightly-rustc/cargo/core/compiler/fingerprint/index.html).
Scala follows sbt's [cross-build layout](https://www.scala-sbt.org/1.x/docs/Cross-Build.html).

These are structural heuristics, not proof that a directory is safe to
delete. The remaining single-name tool conventions can still match a
user-created folder with that name. Ambiguous output is deliberately
omitted: standalone binaries, Cargo custom profiles/target directories,
Maven `target/classes`, sbt's unversioned auxiliary output, and generic
frontend `dist` directories need additional evidence before inclusion.
Python executables and activation scripts, CMake's enclosing build tree,
.NET custom configuration names, custom cache locations, and Go module
paths deeper than six components from `pkg` are also intentionally omitted.
The fixed lookback keeps folder-tree filtering and repeated ambiguous
segments bounded; extend it and its scaling tests together if adding layouts.
Do not promote an entire parent tree based on one matching child: it can
contain files belonging to other tools or the user.

All saved artifact roots are checked against current rules before display or
rescan. Old broad guesses and whole tool homes are hidden rather than relabeled with their
old byte totals. Run a new full scan to discover the narrower subtrees;
the Dev Artifacts rescan only refreshes known valid roots. The UI marks
these saved reports as incomplete, including after refreshing or deleting
known roots. A new full scan produces a report without this notice.

The shared bucket is labeled **Gradle / JVM**, with Java, Maven and Scala/sbt in
the full label. Gradle and Maven caches belong to this bucket;
they are not evidence that the project uses Scala.

Tests share `src/test/fixtures/devArtifactClassification.json` across
Rust and TypeScript, expand it across case/separator/UNC variants, and
fuzz ambiguous path segments with a fixed seed and shared vocabulary.
Reserved names use ASCII case folding, so Unicode lookalikes do not match.
Every positive fixture must also classify its returned root identically:
the directory-rollup reader needs that property. Integration tests cover
marker order, mixed Cargo/sbt projects, directory rollups, legacy reports,
Easy Mode suggestions, and native versus folder-tree results for mixed
tool homes. Folder-tree scaling tests grow input and
artifact counts 8x and assert operation counts, not elapsed time.

Tool-home boundaries follow the documented layouts for
[Yarn](https://yarnpkg.com/getting-started/qa#which-files-should-be-gitignored),
[Gradle](https://docs.gradle.org/current/userguide/directory_layout.html),
[NuGet](https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders),
[Python environments](https://docs.python.org/3/library/venv.html), and
[Go modules](https://go.dev/ref/mod#module-cache), and
[.NET target frameworks](https://learn.microsoft.com/en-us/dotnet/standard/frameworks). Naming evidence cannot
establish whether cached content has local edits; users still review deletion.

## Additional cache coverage from the machine audit

Under `.cache/` or `Library/Caches/`, only these explicit tool names are
accepted: pip, uv, go-build, Coursier, ccache, sccache, Mozilla.sccache,
vscode-cpptools, yarn, pnpm, electron, electron-builder, ms-playwright,
Cypress, Homebrew, puppeteer, node-gyp and org.swift.swiftpm. These names
outside cache namespaces do not classify. Unknown caches stay excluded.
NuGet `http-cache`, `v3-cache` and `plugins-cache` are recognized under
`.local/share/NuGet` and `AppData/Local/NuGet`.

The cache rules follow [npm's cache](https://docs.npmjs.com/cli/commands/npm-cache),
[Yarn's global folder](https://yarnpkg.com/configuration/yarnrc#globalFolder),
[pip caching](https://pip.pypa.io/en/stable/topics/caching/),
[uv cache management](https://docs.astral.sh/uv/concepts/cache/),
[Coursier cache locations](https://get-coursier.io/docs/cache),
[Electron downloads](https://www.electronjs.org/docs/latest/tutorial/installation),
[Playwright browsers](https://playwright.dev/docs/browsers),
[Puppeteer configuration](https://pptr.dev/guides/configuration),
[Homebrew cleanup](https://docs.brew.sh/Manpage#cleanup-options-formulacask-), and
[VS Code C++ cache settings](https://code.visualstudio.com/docs/cpp/faq-cpp).
Downloaded tool dependencies are rebuildable/redownloadable; deleting them
can require reinstalling those dependencies before the next build or test.

The six-component root bound still covers every new layout. Both the shared
corpus and native/folder-reader operation-count scaling tests include the
new cases. npm's unknown children fall through so existing nested
`node_modules` classification is preserved, without classifying `_npx`
or the whole `.npm` directory.

See [the machine audit](dev-artifact-machine-audit.md) for the measured gain,
the full accounting of attribution losses, and the limits of this expansion.

## Common language ecosystems

The classifier also recognizes these documented layouts. Downloads stay in
**Package caches**; compiled/intermediate trees use **Compiler & native build
caches**. No new per-file filesystem probes or unbounded ancestor searches
are required. All roots still fit the six-component folder-reader bound.

| Ecosystem | Added scope | Intentionally excluded |
| --- | --- | --- |
| Ruby / Bundler | `.gem/specs`, `.gem/ruby/<x.y.z>/cache`, `vendor/bundle/ruby/<x.y.z>/cache`, `.cache/gem/{specs,gems}` | Generic `vendor/cache` (can be checked-in vendored dependencies), installed gem sources, credentials, executables |
| PHP / Composer | `.composer/cache`, `.cache/composer`, `Library/Caches/composer`, `AppData/Local/Composer/{files,repo,vcs}` | Project `vendor`, `auth.json`, globally installed plugins |
| Dart / Flutter | `.pub-cache/hosted`, `.pub-cache/git/cache`, `AppData/Local/Pub/Cache/hosted`, `.dart_tool/flutter_build` | Global tools, direct Git checkouts, package configuration, generic `build` |
| Swift / Objective-C / Xcode | `Library/Developer/Xcode/DerivedData` (in addition to SwiftPM download caches) | Archives, simulator data, signing/user settings, generic `.build` and source checkouts |
| Elixir / Erlang | `.hex/packages`, `_build/{dev,test,prod,shared}/lib/<app>/ebin` | `deps`, source, `priv` data, Hex config, Mix-installed tools, custom environments |
| Haskell / Stack / Cabal | `.stack-work/dist`, `dist-newstyle/{build,cache}` | Generic `dist`, toolchains, source, global config |
| Zig | `.zig-cache`, `.cache/zig`, `Library/Caches/zig` | Installed `zig-out`, generic `zig-cache`, Zig SDK/source |

These complement existing JS/TypeScript, Python, Rust, Java/Kotlin/Scala,
Go, C#/.NET and C/C++ layouts above. Coverage is deliberately per layout,
not a promise that every output from a language can safely be deleted.
Custom paths and source-vendoring directories need stronger context.

Layout references:
[RubyGems/Bundler caches](https://guides.rubygems.org/caching-and-vendoring/),
[RubyGems environment](https://guides.rubygems.org/environment-variables/),
[Composer cache settings](https://getcomposer.org/doc/06-config.md#cache-dir),
[Dart's cache location](https://dart.dev/tools/pub/environment-variables),
[Flutter build system](https://github.com/flutter/flutter/blob/master/packages/flutter_tools/lib/src/build_system/build_system.dart),
[Mix build paths](https://hexdocs.pm/mix/Mix.Project.html),
[Hex package cache implementation](https://github.com/hexpm/hex/blob/main/lib/hex/scm.ex),
[Stack work directories](https://docs.haskellstack.org/en/stable/topics/stack_work/),
[Cabal build layout](https://cabal.readthedocs.io/en/2.0/nix-local-build.html), and
[Zig build system](https://ziglang.org/learn/build-system/).

The shared corpus now has 350 positive/negative fixtures, including
lookalikes, unrelated source and configuration siblings. The 2,000 seeded
ambiguous-path trials per implementation include the new tool names and
near misses. Integration and N/8N operation-count tests exercise the longest
new roots, including Ruby, Mix and Windows Pub layouts.
