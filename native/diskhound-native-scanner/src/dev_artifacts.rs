//! Compact Dev Artifacts accumulator — same classification rules as
//! `src/shared/devArtifacts.ts`. Runs on the index-writer thread so
//! every emitted file (MFT, walker, inherit) is classified once.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::clone_attrs::{CloneAttrs, CloneGroups, RootCloneShare};

#[derive(Clone, Copy)]
enum Kind {
    Worktree,
    NodeModules,
    PackageCache,
    RustTarget,
    CargoRegistry,
    JsBuild,
    Python,
    GoModule,
    Jvm,
    Dotnet,
    CompilerCache,
    CmakeBuild,
    DiagLogs,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Worktree => "worktree",
            Kind::NodeModules => "node-modules",
            Kind::PackageCache => "package-cache",
            Kind::RustTarget => "rust-target",
            Kind::CargoRegistry => "cargo-registry",
            Kind::JsBuild => "js-build",
            Kind::Python => "python",
            Kind::GoModule => "go-module",
            Kind::Jvm => "jvm",
            Kind::Dotnet => "dotnet",
            Kind::CompilerCache => "compiler-cache",
            Kind::CmakeBuild => "cmake-build",
            Kind::DiagLogs => "diag-logs",
        }
    }
}

struct AccRec {
    kind: Kind,
    size: u64,
    files: u64,
    /// Stable index into `DevArtifactAcc::root_paths`; clone groups
    /// refer to roots by this id.
    id: u32,
    /// APFS clone accounting (macOS). `measured` stays false on other
    /// platforms / volumes, and the sidecar then omits the block.
    measured: bool,
    clone_size: u64,
    clone_private_size: u64,
    /// Each clone file's share of the blocks it shares: its shared bytes
    /// divided by the copies APFS counts for its full-clone group. See
    /// `SidecarClone::clone_shared_blocks`.
    clone_block_share: u64,
}

pub struct DevArtifactAcc {
    artifacts: HashMap<String, AccRec>,
    projects: HashSet<String>,
    root_paths: Vec<String>,
}

impl DevArtifactAcc {
    pub fn new() -> Self {
        Self {
            artifacts: HashMap::new(),
            projects: HashSet::new(),
            root_paths: Vec::new(),
        }
    }

    pub fn root_count(&self) -> usize {
        self.artifacts.values().filter(|rec| rec.size > 0).count()
    }

    /// Classify one file. Returns its root id when it belongs to a Dev
    /// Artifacts tree, so the caller can attribute clone groups.
    pub fn add(
        &mut self,
        path: &str,
        size: u64,
        extra_hardlink: bool,
        clone: Option<&CloneAttrs>,
    ) -> Option<u32> {
        if let Some(name) = file_name(path) {
            if is_project_marker(name) {
                if let Some(dir) = parent_path(path) {
                    self.projects.insert(dir);
                }
            }
        }
        let (root, kind) = classify(path)?;
        let occupancy = if extra_hardlink { 0 } else { size };
        let next_id = self.root_paths.len() as u32;
        let entry = self.artifacts.entry(root).or_insert_with_key(|root| {
            self.root_paths.push(root.clone());
            AccRec {
                kind,
                size: 0,
                files: 0,
                id: next_id,
                measured: false,
                clone_size: 0,
                clone_private_size: 0,
                clone_block_share: 0,
            }
        });
        entry.size = entry.size.saturating_add(occupancy);
        entry.files = entry.files.saturating_add(1);
        if let (Some(attrs), false) = (clone, extra_hardlink) {
            entry.measured = true;
            if attrs.may_share() {
                let private = attrs.clone_private_of(occupancy);
                entry.clone_size = entry.clone_size.saturating_add(occupancy);
                entry.clone_private_size = entry.clone_private_size.saturating_add(private);
                // A modified clone has no group, so its copies are
                // unknown: count its shared bytes whole.
                let copies = attrs.full_clone_group().map_or(1, |(_, refcnt)| u64::from(refcnt));
                entry.clone_block_share = entry
                    .clone_block_share
                    .saturating_add((occupancy - private) / copies);
            }
        }
        Some(entry.id)
    }

    pub fn root_id_count(&self) -> usize {
        self.root_paths.len()
    }
}

#[derive(Serialize)]
struct SidecarFile {
    version: u32,
    #[serde(rename = "rootPath")]
    root_path: String,
    #[serde(rename = "generatedAt")]
    generated_at: u64,
    roots: Vec<SidecarRoot>,
    projects: Vec<String>,
}

#[derive(Serialize)]
struct SidecarRoot {
    path: String,
    kind: String,
    size: u64,
    files: u64,
    /// Mirrors `DevArtifactCloneInfo` in src/shared/contracts.ts.
    #[serde(skip_serializing_if = "Option::is_none")]
    clone: Option<SidecarClone>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SidecarClone {
    clone_size: u64,
    clone_private_size: u64,
    clone_internal_size: u64,
    clone_shared_size: u64,
    /// The blocks behind `clone_shared_size`, each copy counted as 1/k of
    /// a group of k full clones (a modified clone counts whole). Summed
    /// over any set of trees, it is at least what deleting all of them
    /// frees beyond each tree's own blocks: a group whose every copy is
    /// in the set sums to its size, one with copies elsewhere frees 0.
    clone_shared_blocks: u64,
    shared_roots: u64,
    shared_with: Vec<String>,
}

const ROOT_CAP: usize = 2500;
const SHARED_WITH_CAP: usize = 3;

fn sidecar_clone(acc: &DevArtifactAcc, rec: &AccRec, share: Option<&RootCloneShare>) -> Option<SidecarClone> {
    if !rec.measured {
        return None;
    }
    let internal_files = share.map_or(0, |s| s.internal_file_bytes).min(rec.clone_size);
    let internal = share.map_or(0, |s| s.internal_bytes);
    // Clone bytes that are neither private nor inside a group this
    // tree fully owns: some other file still references them.
    let clone_shared_size = rec
        .clone_size
        .saturating_sub(rec.clone_private_size)
        .saturating_sub(internal_files);
    Some(SidecarClone {
        clone_size: rec.clone_size,
        clone_private_size: rec.clone_private_size,
        clone_internal_size: internal,
        clone_shared_size,
        // The copies of a group this tree owns outright share out to its
        // size, which `clone_internal_size` already holds.
        clone_shared_blocks: rec.clone_block_share.saturating_sub(internal).min(clone_shared_size),
        shared_roots: share.map_or(0, |s| s.neighbors.len() as u64),
        shared_with: share
            .map(|s| {
                s.neighbors
                    .iter()
                    .take(SHARED_WITH_CAP)
                    .filter_map(|(id, _)| acc.root_paths.get(*id as usize).cloned())
                    .collect()
            })
            .unwrap_or_default(),
    })
}

pub fn write_sidecar(
    output: &Path,
    scan_root: &str,
    acc: &DevArtifactAcc,
    groups: Option<&CloneGroups>,
) -> io::Result<()> {
    let shares = groups.map(|g| g.attribute(acc.root_id_count()));
    let mut roots: Vec<SidecarRoot> = acc
        .artifacts
        .iter()
        .filter(|(_, rec)| rec.size > 0)
        .map(|(path, rec)| SidecarRoot {
            path: path.clone(),
            kind: rec.kind.as_str().to_string(),
            size: rec.size,
            files: rec.files,
            clone: sidecar_clone(
                acc,
                rec,
                shares.as_ref().and_then(|s| s.get(rec.id as usize)),
            ),
        })
        .collect();
    roots.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));
    if roots.len() > ROOT_CAP {
        roots.truncate(ROOT_CAP);
    }
    let projects = projects_for_roots(&acc.projects, &roots);
    let generated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let sidecar = SidecarFile {
        version: 1,
        root_path: scan_root.to_string(),
        generated_at,
        roots,
        projects,
    };
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = output.with_extension("json.tmp");
    let file = File::create(&tmp)?;
    serde_json::to_writer(file, &sidecar).map_err(io::Error::other)?;
    std::fs::rename(tmp, output)?;
    Ok(())
}

fn is_project_marker(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "package.json"
            | "cargo.toml"
            | "go.mod"
            | "pyproject.toml"
            | "composer.json"
            | "gemfile"
            | "mix.exs"
            | "package.swift"
    )
}

fn classify(path: &str) -> Option<(String, Kind)> {
    let parts = split_segments(path);
    for i in 0..parts.len() {
        let lower = parts[i].to_ascii_lowercase();
        if lower == "target" {
            if i + 1 < parts.len() {
                let next = parts[i + 1].to_ascii_lowercase();
                if matches!(next.as_str(), "debug" | "release" | "doc" | "incremental") {
                    return Some((join_segments(path, &parts, i + 2), Kind::RustTarget));
                }
            }
            return Some((join_segments(path, &parts, i + 1), Kind::RustTarget));
        }
        if lower == ".cargo" && i + 1 < parts.len() && parts[i + 1].eq_ignore_ascii_case("registry")
        {
            return Some((join_segments(path, &parts, i + 2), Kind::CargoRegistry));
        }
        if lower == "pkg" && i + 1 < parts.len() && parts[i + 1].eq_ignore_ascii_case("mod") {
            return Some((join_segments(path, &parts, i + 2), Kind::GoModule));
        }
        // pnpm's global store outside a `.pnpm-store` folder — keep in
        // sync with `pnpmStoreRootDepth` in src/shared/devArtifacts.ts.
        if let Some(depth) = pnpm_store_root_depth(&parts, i) {
            return Some((join_segments(path, &parts, depth), Kind::PackageCache));
        }
        if lower == ".cache" && i + 1 < parts.len() {
            let next = parts[i + 1].to_ascii_lowercase();
            if matches!(next.as_str(), "ccache" | "sccache" | "yarn" | "pnpm") {
                let kind = if next == "yarn" || next == "pnpm" {
                    Kind::PackageCache
                } else {
                    Kind::CompilerCache
                };
                return Some((join_segments(path, &parts, i + 2), kind));
            }
        }
        if let Some(kind) = mapped_kind(&lower) {
            let depth = if matches!(kind, Kind::Worktree) && i + 1 < parts.len() {
                i + 2
            } else {
                i + 1
            };
            return Some((join_segments(path, &parts, depth), kind));
        }
        if matches!(lower.as_str(), "dist" | "build" | "out") {
            return Some((join_segments(path, &parts, i + 1), Kind::JsBuild));
        }
    }
    None
}

const PNPM_STORE_PARENTS: &[&[&str]] = &[
    &["library", "pnpm", "store"],
    &[".local", "share", "pnpm", "store"],
    &["appdata", "local", "pnpm", "store"],
];

fn pnpm_store_root_depth(parts: &[&str], i: usize) -> Option<usize> {
    PNPM_STORE_PARENTS.iter().find_map(|seq| {
        let end = i + seq.len();
        if end > parts.len() {
            return None;
        }
        seq.iter()
            .zip(&parts[i..end])
            .all(|(want, got)| got.eq_ignore_ascii_case(want))
            .then_some(end)
    })
}

fn mapped_kind(lower: &str) -> Option<Kind> {
    Some(match lower {
        "node_modules" => Kind::NodeModules,
        ".pnpm-store" | ".yarn" | ".bun" => Kind::PackageCache,
        ".next" | ".nuxt" | ".output" | ".turbo" | ".parcel-cache" | ".svelte-kit"
        | ".vercel" | ".netlify" => Kind::JsBuild,
        "__pycache__" | ".venv" | "venv" | ".tox" | ".mypy_cache" | ".pytest_cache"
        | ".ruff_cache" => Kind::Python,
        ".gradle" | ".m2" => Kind::Jvm,
        ".nuget" => Kind::Dotnet,
        "cmakefiles" | "cmake-build-debug" | "cmake-build-release" => Kind::CmakeBuild,
        "ccache" | "sccache" => Kind::CompilerCache,
        ".worktrees" => Kind::Worktree,
        "diagoutputdir" | "rdclientautotrace" => Kind::DiagLogs,
        _ => return None,
    })
}

fn split_segments(path: &str) -> Vec<&str> {
    path.split(['\\', '/']).filter(|s| !s.is_empty()).collect()
}

fn join_segments(original: &str, parts: &[&str], count: usize) -> String {
    let take = parts.iter().take(count);
    if original.starts_with("\\\\") || original.starts_with("//") {
        return format!("\\\\{}", take.cloned().collect::<Vec<_>>().join("\\"));
    }
    let sep = if original.contains('\\') { "\\" } else { "/" };
    let joined = take.cloned().collect::<Vec<_>>().join(sep);
    if original.chars().nth(1) == Some(':') {
        return joined;
    }
    if original.starts_with('/') {
        return format!("/{joined}");
    }
    joined
}

fn file_name(path: &str) -> Option<&str> {
    path.rsplit(['\\', '/']).find(|s| !s.is_empty())
}

fn trim_slash(path: &str) -> &str {
    path.trim_end_matches(['\\', '/'])
}

fn projects_for_roots(projects: &HashSet<String>, roots: &[SidecarRoot]) -> Vec<String> {
    let by_lower: HashMap<String, String> = projects
        .iter()
        .map(|project| (trim_slash(project).to_ascii_lowercase(), project.clone()))
        .collect();
    let mut kept = HashSet::new();
    for root in roots {
        let mut cursor = trim_slash(&root.path).to_string();
        loop {
            if let Some(orig) = by_lower.get(&cursor.to_ascii_lowercase()) {
                kept.insert(orig.clone());
                break;
            }
            match parent_path(&cursor) {
                Some(parent) if parent != cursor => cursor = parent,
                _ => break,
            }
        }
    }
    kept.into_iter().collect()
}

fn parent_path(path: &str) -> Option<String> {
    let idx = path.rfind(['\\', '/'])?;
    if idx == 0 {
        return Some(path[..=0].to_string());
    }
    Some(path[..idx].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_node_modules() {
        let (root, kind) = classify(r"C:\proj\app\node_modules\preact\dist\preact.js").unwrap();
        assert_eq!(root, r"C:\proj\app\node_modules");
        assert!(matches!(kind, Kind::NodeModules));
    }

    #[test]
    fn classifies_rust_target() {
        let (root, kind) = classify("/home/dev/diskhound/target/debug/diskhound").unwrap();
        assert_eq!(root, "/home/dev/diskhound/target/debug");
        assert!(matches!(kind, Kind::RustTarget));
    }

    #[test]
    fn classifies_diag_output_dir_before_nested_rdp_trace() {
        let (root, kind) = classify(
            r"C:\Users\thoma\AppData\Local\Temp\DiagOutputDir\RdClientAutoTrace\a.etl",
        )
        .unwrap();
        assert_eq!(root, r"C:\Users\thoma\AppData\Local\Temp\DiagOutputDir");
        assert!(matches!(kind, Kind::DiagLogs));
    }

    #[test]
    fn classifies_standalone_rdclient_auto_trace() {
        let (root, kind) =
            classify(r"C:\Users\thoma\AppData\Local\Temp\RdClientAutoTrace\a.etl").unwrap();
        assert_eq!(root, r"C:\Users\thoma\AppData\Local\Temp\RdClientAutoTrace");
        assert!(matches!(kind, Kind::DiagLogs));
    }

    #[test]
    fn sidecar_reports_clone_sharing_between_store_and_project() {
        use crate::clone_attrs::{CloneAttrs, EF_MAY_SHARE_BLOCKS, EF_SHARES_ALL_BLOCKS, OUTSIDE_ROOTS};
        let shared = |id: u64| CloneAttrs {
            private_size: Some(0),
            clone_id: id,
            clone_refcnt: 2,
            ext_flags: EF_MAY_SHARE_BLOCKS | EF_SHARES_ALL_BLOCKS,
        };
        let mut acc = DevArtifactAcc::new();
        let mut groups = CloneGroups::new();
        let store = "/Users/dev/Library/pnpm/store/v10/files/aa/one";
        let project = "/Users/dev/app/node_modules/.pnpm/x@1/node_modules/x/one.js";
        for (path, attrs) in [(store, shared(1)), (project, shared(1))] {
            let root = acc.add(path, 4096, false, Some(&attrs)).unwrap();
            groups.add(&attrs, 4096, root);
        }
        // Ordinary (non-clone) file inside the project.
        acc.add("/Users/dev/app/node_modules/y/index.js", 8192, false, Some(&CloneAttrs::default()));
        // Two clones of one file both inside the project: internal.
        for _ in 0..2 {
            let internal = shared(5);
            let root = acc.add("/Users/dev/app/node_modules/z/a.js", 1000, false, Some(&internal)).unwrap();
            groups.add(&internal, 1000, root);
        }
        // Unrelated file outside Dev roots.
        groups.add(&shared(9), 10, OUTSIDE_ROOTS);

        let shares = groups.attribute(acc.root_id_count());
        let rec = &acc.artifacts["/Users/dev/app/node_modules"];
        let info = sidecar_clone(&acc, rec, shares.get(rec.id as usize)).unwrap();
        assert_eq!(
            info,
            SidecarClone {
                clone_size: 4096 + 2000,
                clone_private_size: 0,
                clone_internal_size: 1000,
                clone_shared_size: 4096,
                // Half of the store/project pair's 4096.
                clone_shared_blocks: 2048,
                shared_roots: 1,
                shared_with: vec!["/Users/dev/Library/pnpm/store".to_string()],
            }
        );
    }

    #[test]
    fn shared_blocks_count_each_copy_once_per_group() {
        use crate::clone_attrs::{CloneAttrs, EF_MAY_SHARE_BLOCKS, EF_SHARES_ALL_BLOCKS};
        const SIZE: u64 = 1_000_000;
        let copy_of = |id: u64, refcnt: u32, private: u64| CloneAttrs {
            private_size: Some(private),
            clone_id: id,
            clone_refcnt: refcnt,
            ext_flags: EF_MAY_SHARE_BLOCKS | EF_SHARES_ALL_BLOCKS,
        };
        let mut acc = DevArtifactAcc::new();
        let mut groups = CloneGroups::new();
        // One file cloned 50 ways: 5 copies in each of ten projects.
        for project in 0..10 {
            for copy in 0..5 {
                let attrs = copy_of(7, 50, 0);
                let path = format!("/Users/dev/p{project}/node_modules/pkg/{copy}.js");
                let root = acc.add(&path, SIZE, false, Some(&attrs)).unwrap();
                groups.add(&attrs, SIZE, root);
            }
        }
        // A modified clone: no group, so its 900 KB still shared count whole.
        acc.add("/Users/dev/p0/node_modules/pkg/edited.js", SIZE, false, Some(&copy_of(8, 1, 100_000)));

        let shares = groups.attribute(acc.root_id_count());
        let mut blocks = 0;
        for project in 0..10 {
            let rec = &acc.artifacts[&format!("/Users/dev/p{project}/node_modules")];
            let info = sidecar_clone(&acc, rec, shares.get(rec.id as usize)).unwrap();
            let edited = if project == 0 { 900_000 } else { 0 };
            assert_eq!(info.clone_shared_size, 5 * SIZE + edited);
            assert_eq!(info.clone_shared_blocks, 5 * SIZE / 50 + edited);
            blocks += info.clone_shared_blocks;
        }
        // 50 MB of listed copies, 1 MB of blocks (plus the edited clone).
        assert_eq!(blocks, SIZE + 900_000);
    }

    #[test]
    fn classifies_pnpm_global_stores() {
        let (root, kind) =
            classify("/Users/dev/Library/pnpm/store/v10/files/00/abc-index.json").unwrap();
        assert_eq!(root, "/Users/dev/Library/pnpm/store");
        assert!(matches!(kind, Kind::PackageCache));
        let (root, _) = classify("/home/dev/.local/share/pnpm/store/v3/files/ff/x").unwrap();
        assert_eq!(root, "/home/dev/.local/share/pnpm/store");
        let (root, _) = classify(r"C:\Users\dev\AppData\Local\pnpm\store\v10\x").unwrap();
        assert_eq!(root, r"C:\Users\dev\AppData\Local\pnpm\store");
        assert!(classify("/Users/dev/Library/pnpm/global/5/node_modules").is_some());
        assert!(classify("/Users/dev/Library/pnpm/pnpm").is_none());
    }

    #[test]
    fn writes_sidecar_json() {
        let mut acc = DevArtifactAcc::new();
        acc.add(r"C:\proj\node_modules\x.js", 1000, false, None);
        let dir = std::env::temp_dir().join(format!("dh-dev-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("scan.dev-artifacts.json");
        write_sidecar(&out, r"C:\", &acc, None).unwrap();
        let raw = std::fs::read_to_string(&out).unwrap();
        assert!(raw.contains("node-modules"));
        assert!(raw.contains("rootPath"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_sidecar_keeps_largest_roots_and_their_projects() {
        let mut acc = DevArtifactAcc::new();
        for i in 0..3_000 {
            let project = format!(r"C:\p{i}");
            acc.projects.insert(project.clone());
            acc.add(&format!(r"{project}\node_modules\x.js"), 1_000 + i as u64, false, None);
        }
        let dir = std::env::temp_dir().join(format!("dh-dev-cap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("scan.dev-artifacts.json");
        write_sidecar(&out, r"C:\", &acc, None).unwrap();
        let raw = std::fs::read_to_string(&out).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let roots = parsed["roots"].as_array().unwrap();
        assert_eq!(roots.len(), 2500);
        let projects = parsed["projects"].as_array().unwrap();
        assert!(projects.len() <= 2500);
        assert!(projects.len() > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
