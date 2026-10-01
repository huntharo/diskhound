//! Compact Dev Artifacts accumulator — same classification rules as
//! `src/shared/devArtifacts.ts`. Runs on the index-writer thread so
//! every emitted file (MFT, walker, inherit) is classified once.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{self, Read};
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
    Terraform,
    GitRepo,
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
            Kind::Terraform => "terraform",
            Kind::GitRepo => "git-repo",
            Kind::DiagLogs => "diag-logs",
        }
    }
}

/// APFS clone sums over a set of files (macOS).
#[derive(Clone, Copy, Default)]
struct CloneSums {
    size: u64,
    private_size: u64,
    /// Each clone file's share of the blocks it shares: its shared bytes
    /// divided by the copies APFS counts for its full-clone group. See
    /// `SidecarClone::clone_shared_blocks`.
    block_share: u64,
}

impl CloneSums {
    fn add(&mut self, occupancy: u64, attrs: &CloneAttrs) {
        if !attrs.may_share() {
            return;
        }
        let private = attrs.clone_private_of(occupancy);
        self.size = self.size.saturating_add(occupancy);
        self.private_size = self.private_size.saturating_add(private);
        // A modified clone has no group, so its copies are unknown:
        // count its shared bytes whole.
        let copies = attrs.full_clone_group().map_or(1, |(_, refcnt)| u64::from(refcnt));
        self.block_share = self.block_share.saturating_add((occupancy - private) / copies);
    }

    fn absorb(&mut self, other: &CloneSums) {
        self.size = self.size.saturating_add(other.size);
        self.private_size = self.private_size.saturating_add(other.private_size);
        self.block_share = self.block_share.saturating_add(other.block_share);
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
    clone: CloneSums,
    /// `Kind::Worktree` only: the main checkout the worktree's `.git`
    /// file points at, when one was read.
    project: Option<String>,
    /// `Kind::Worktree` only: bytes of the trees inside it by kind
    /// (node_modules, target, ...). They are part of `size`, not rows.
    nested: BTreeMap<&'static str, u64>,
}

impl AccRec {
    fn new(kind: Kind, id: u32) -> Self {
        AccRec {
            kind,
            size: 0,
            files: 0,
            id,
            measured: false,
            clone: CloneSums::default(),
            project: None,
            nested: BTreeMap::new(),
        }
    }
}

/// Reads a `.git` file. A field so tests can stand in for the disk.
type GitFileReader = fn(&str) -> Option<String>;

pub struct DevArtifactAcc {
    artifacts: HashMap<String, AccRec>,
    projects: HashSet<String>,
    root_paths: Vec<String>,
    /// Linked worktrees found by their `.git` file: folder → main checkout.
    /// They become roots in `resolve_worktrees`, once every file is in.
    worktrees: HashMap<String, String>,
    /// Clone sums of files outside every tree, by folder. A worktree
    /// takes the ones under it when it is resolved.
    loose_clones: HashMap<String, CloneSums>,
    /// Some file came with clone attributes: this volume is measured.
    saw_clone_attrs: bool,
    /// `.git` files read, for the scan log. One per linked worktree or
    /// submodule outside every tree.
    git_file_reads: u64,
    read_git_file: GitFileReader,
    /// Old root id → the id clone groups count it under. Folded trees map
    /// to their worktree. Empty until `resolve_worktrees`.
    root_remap: Vec<u32>,
}

impl DevArtifactAcc {
    pub fn new() -> Self {
        Self::with_git_reader(read_git_file)
    }

    fn with_git_reader(read_git_file: GitFileReader) -> Self {
        Self {
            artifacts: HashMap::new(),
            projects: HashSet::new(),
            root_paths: Vec::new(),
            worktrees: HashMap::new(),
            loose_clones: HashMap::new(),
            saw_clone_attrs: false,
            git_file_reads: 0,
            read_git_file,
            root_remap: Vec::new(),
        }
    }

    pub fn root_count(&self) -> usize {
        self.artifacts.values().filter(|rec| rec.size > 0).count()
    }

    pub fn git_file_reads(&self) -> u64 {
        self.git_file_reads
    }

    pub fn worktree_count(&self) -> usize {
        self.artifacts
            .values()
            .filter(|rec| matches!(rec.kind, Kind::Worktree) && rec.size > 0)
            .count()
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
        let name = file_name(path);
        if let Some(name) = name {
            if is_project_marker(name) {
                if let Some(dir) = parent_path(path) {
                    self.projects.insert(dir);
                }
            }
        }
        if clone.is_some() {
            self.saw_clone_attrs = true;
        }
        let occupancy = if extra_hardlink { 0 } else { size };
        let parts = split_segments(path);
        let classified = classify_parts(&parts, 0);
        if name == Some(".git") && !extra_hardlink {
            self.note_git_file(path, &parts, classified);
        }
        let Some((depth, kind)) = classified else {
            if let (Some(attrs), false) = (clone, extra_hardlink) {
                if attrs.may_share() {
                    self.add_loose_clone(path, occupancy, attrs);
                }
            }
            return None;
        };
        let root = join_segments(path, &parts, depth);
        let next_id = self.root_paths.len() as u32;
        let entry = self.artifacts.entry(root).or_insert_with_key(|root| {
            self.root_paths.push(root.clone());
            AccRec::new(kind, next_id)
        });
        entry.size = entry.size.saturating_add(occupancy);
        entry.files = entry.files.saturating_add(1);
        if matches!(kind, Kind::Worktree) {
            if let Some((_, inner)) = classify_parts(&parts, depth) {
                *entry.nested.entry(inner.as_str()).or_default() += occupancy;
            }
        }
        if let (Some(attrs), false) = (clone, extra_hardlink) {
            entry.measured = true;
            entry.clone.add(occupancy, attrs);
        }
        Some(entry.id)
    }

    /// Most loose clones share a folder with the last one, so look the
    /// folder up before allocating its key.
    fn add_loose_clone(&mut self, path: &str, occupancy: u64, attrs: &CloneAttrs) {
        let Some(idx) = path.rfind(['\\', '/']) else { return };
        let dir = if idx == 0 { &path[..1] } else { &path[..idx] };
        match self.loose_clones.get_mut(dir) {
            Some(sums) => sums.add(occupancy, attrs),
            None => self.loose_clones.entry(dir.to_string()).or_default().add(occupancy, attrs),
        }
    }

    /// A `.git` file is a linked worktree's or a submodule's pointer to its
    /// real git dir. Read it when its folder is outside every tree (or is
    /// a `.worktrees/<name>` tree), and remember the folder if it is a
    /// worktree. Inside another tree, that tree already holds its bytes.
    fn note_git_file(&mut self, path: &str, parts: &[&str], classified: Option<(usize, Kind)>) {
        let dir_depth = parts.len().saturating_sub(1);
        match classified {
            None => {}
            Some((depth, Kind::Worktree)) if depth == dir_depth => {}
            Some(_) => return,
        }
        let Some(dir) = parent_path(path) else { return };
        self.git_file_reads += 1;
        let Some(contents) = (self.read_git_file)(path) else { return };
        if let Some(project) = worktree_project(&dir, &contents) {
            self.worktrees.insert(dir, project);
        }
    }

    /// Make each linked worktree one root, now that every file is in.
    ///
    /// A worktree row is the whole checkout: what removing it frees. The
    /// trees inside it (node_modules, target, ...) fold into it and leave
    /// the list, so every byte is still in exactly one row. Their sizes by
    /// kind stay on the worktree as `nested`. That is how `.worktrees/`
    /// trees have always been counted.
    ///
    /// Files reach the index writer in the order parallel reads finish, so
    /// a worktree's `.git` can arrive after files under it. Its size and
    /// file count come from `tree_totals` (the scan's folder rollups), and
    /// its clone sums from the trees inside it plus `loose_clones`. Clone
    /// groups are re-attributed through `root_remap`; a group with a copy
    /// in the worktree's own (unclassified) files counts as shared.
    pub fn resolve_worktrees(&mut self, tree_totals: &dyn Fn(&str) -> Option<(u64, u64)>) {
        let mut found: Vec<(String, String)> = self.worktrees.drain().collect();
        if found.is_empty() {
            return;
        }
        let mut remap: Vec<u32> = (0..self.root_paths.len() as u32).collect();
        // Outermost first: a worktree inside another one is part of it.
        found.sort_by(|a, b| a.0.len().cmp(&b.0.len()).then_with(|| a.0.cmp(&b.0)));
        let mut owners: HashMap<String, u32> = HashMap::new();
        for (path, project) in found {
            crate::work::step();
            if ancestor_in(&path, &owners, false).is_some() {
                continue;
            }
            // A `.worktrees/<name>` tree already counts every file under it.
            if let Some(rec) = self.artifacts.get_mut(&path) {
                rec.project = Some(project);
                continue;
            }
            let id = self.root_paths.len() as u32;
            self.root_paths.push(path.clone());
            remap.push(id);
            let mut rec = AccRec::new(Kind::Worktree, id);
            rec.measured = self.saw_clone_attrs;
            rec.project = Some(project);
            self.artifacts.insert(path.clone(), rec);
            owners.insert(path, id);
        }
        if !owners.is_empty() {
            let inside: Vec<(String, u32)> = self
                .artifacts
                .keys()
                .filter_map(|path| {
                    crate::work::step();
                    ancestor_in(path, &owners, false).map(|owner| (path.clone(), owner))
                })
                .collect();
            for (path, owner) in inside {
                let Some(rec) = self.artifacts.remove(&path) else { continue };
                remap[rec.id as usize] = owner;
                let owner_path = &self.root_paths[owner as usize];
                let Some(worktree) = self.artifacts.get_mut(owner_path) else { continue };
                worktree.size = worktree.size.saturating_add(rec.size);
                worktree.files = worktree.files.saturating_add(rec.files);
                worktree.clone.absorb(&rec.clone);
                *worktree.nested.entry(rec.kind.as_str()).or_default() += rec.size;
            }
            for (dir, sums) in self.loose_clones.drain() {
                crate::work::step();
                if let Some(owner) = ancestor_in(&dir, &owners, true) {
                    let owner_path = &self.root_paths[owner as usize];
                    if let Some(worktree) = self.artifacts.get_mut(owner_path) {
                        worktree.clone.absorb(&sums);
                    }
                }
            }
            for (path, _) in owners.iter() {
                crate::work::step();
                let Some((size, files)) = tree_totals(path) else { continue };
                if let Some(worktree) = self.artifacts.get_mut(path) {
                    worktree.size = worktree.size.max(size);
                    worktree.files = worktree.files.max(files);
                }
            }
        }
        self.root_remap = remap;
    }

    pub fn root_id_count(&self) -> usize {
        self.root_paths.len()
    }
}

/// The id of the folder in `owners` that holds `path`: one of its parent
/// folders, or `path` itself when `or_self`.
fn ancestor_in(path: &str, owners: &HashMap<String, u32>, or_self: bool) -> Option<u32> {
    if or_self {
        if let Some(id) = owners.get(path) {
            return Some(*id);
        }
    }
    let mut cursor = parent_path(path)?;
    loop {
        crate::work::step();
        if let Some(id) = owners.get(&cursor) {
            return Some(*id);
        }
        match parent_path(&cursor) {
            Some(parent) if parent != cursor => cursor = parent,
            _ => return None,
        }
    }
}

/// The first 4 KB of a `.git` file. A real one is a single line.
fn read_git_file(path: &str) -> Option<String> {
    let mut buf = Vec::with_capacity(256);
    File::open(path).ok()?.take(4096).read_to_end(&mut buf).ok()?;
    String::from_utf8(buf).ok()
}

/// The main checkout of the linked worktree at `dir`, from its `.git`
/// file: `gitdir: <common dir>/worktrees/<name>`. The common dir is the
/// main checkout's `.git` (the checkout is its parent) or a bare repo
/// (the project itself). A submodule's file points into
/// `<repo>/.git/modules/<name>` and gives None, as does anything else.
/// `gitdir` may be relative to `dir` (`git worktree add --relative-paths`).
fn worktree_project(dir: &str, contents: &str) -> Option<String> {
    let target = contents.lines().next()?.trim().strip_prefix("gitdir:")?.trim();
    if target.is_empty() {
        return None;
    }
    let windows_style = dir.contains('\\');
    let absolute = target.starts_with(['/', '\\']) || target.chars().nth(1) == Some(':');
    let base = if absolute { target } else { dir };
    let mut parts: Vec<&str> = if absolute { Vec::new() } else { split_segments(dir) };
    for seg in split_segments(target) {
        match seg {
            "." => {}
            ".." => {
                parts.pop();
            }
            seg => parts.push(seg),
        }
    }
    let n = parts.len();
    if n < 3 || !parts[n - 2].eq_ignore_ascii_case("worktrees") {
        return None;
    }
    let common = &parts[..n - 2];
    let project = if common.last()?.eq_ignore_ascii_case(".git") {
        &common[..common.len() - 1]
    } else {
        common
    };
    if project.is_empty() {
        return None;
    }
    Some(format_path(base, project, windows_style))
}

/// Join `parts` back into a path shaped like `like` (UNC, drive, or
/// POSIX root), with `\` when `backslash`.
fn format_path(like: &str, parts: &[&str], backslash: bool) -> String {
    let sep = if backslash { "\\" } else { "/" };
    let joined = parts.join(sep);
    if like.starts_with("\\\\") || like.starts_with("//") {
        return format!("\\\\{}", parts.join("\\"));
    }
    if like.chars().nth(1) == Some(':') {
        return joined;
    }
    if like.starts_with(['/', '\\']) {
        return format!("{sep}{joined}");
    }
    joined
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
    /// `worktree` roots only. Mirrors `DevWorktreeInfo` in contracts.ts.
    #[serde(skip_serializing_if = "Option::is_none")]
    worktree: Option<SidecarWorktree>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SidecarWorktree {
    /// The main checkout (or bare repo) its `.git` file points at.
    #[serde(skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    /// Bytes of the trees inside it, by kind. Already in its `size`.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    nested_size: BTreeMap<&'static str, u64>,
}

fn sidecar_worktree(rec: &AccRec) -> Option<SidecarWorktree> {
    if !matches!(rec.kind, Kind::Worktree) {
        return None;
    }
    Some(SidecarWorktree {
        project: rec.project.clone(),
        nested_size: rec.nested.clone(),
    })
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
    let sums = &rec.clone;
    let internal_files = share.map_or(0, |s| s.internal_file_bytes).min(sums.size);
    let internal = share.map_or(0, |s| s.internal_bytes);
    // Clone bytes that are neither private nor inside a group this
    // tree fully owns: some other file still references them.
    let clone_shared_size = sums
        .size
        .saturating_sub(sums.private_size)
        .saturating_sub(internal_files);
    Some(SidecarClone {
        clone_size: sums.size,
        clone_private_size: sums.private_size,
        clone_internal_size: internal,
        clone_shared_size,
        // The copies of a group this tree owns outright share out to its
        // size, which `clone_internal_size` already holds.
        clone_shared_blocks: sums.block_share.saturating_sub(internal).min(clone_shared_size),
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
    let shares = groups.map(|g| g.attribute_remapped(acc.root_id_count(), &acc.root_remap));
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
            worktree: sidecar_worktree(rec),
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
            | ".terraform.lock.hcl"
    )
}

#[cfg(test)]
fn classify(path: &str) -> Option<(String, Kind)> {
    let parts = split_segments(path);
    classify_parts(&parts, 0).map(|(depth, kind)| (join_segments(path, &parts, depth), kind))
}

/// The tree `parts` falls in, as (segments in its root path, kind),
/// looking only at segments from `start` on.
///
/// Linked worktrees outside `.worktrees/` are not path rules: their
/// `.git` file says what they are, and `DevArtifactAcc` reads it.
fn classify_parts(parts: &[&str], start: usize) -> Option<(usize, Kind)> {
    for i in start..parts.len() {
        let lower = parts[i].to_ascii_lowercase();
        if lower == "target" {
            if i + 1 < parts.len() {
                let next = parts[i + 1].to_ascii_lowercase();
                if matches!(next.as_str(), "debug" | "release" | "doc" | "incremental") {
                    return Some((i + 2, Kind::RustTarget));
                }
            }
            return Some((i + 1, Kind::RustTarget));
        }
        if lower == ".cargo" && i + 1 < parts.len() && parts[i + 1].eq_ignore_ascii_case("registry")
        {
            return Some((i + 2, Kind::CargoRegistry));
        }
        if lower == "pkg" && i + 1 < parts.len() && parts[i + 1].eq_ignore_ascii_case("mod") {
            return Some((i + 2, Kind::GoModule));
        }
        // pnpm's global store outside a `.pnpm-store` folder:
        // `$PNPM_HOME/store`. Same rule as `classifyArtifactPath` in
        // src/shared/devArtifacts.ts.
        if lower == "pnpm" && i + 1 < parts.len() && parts[i + 1].eq_ignore_ascii_case("store") {
            return Some((i + 2, Kind::PackageCache));
        }
        if lower == ".cache" && i + 1 < parts.len() {
            let next = parts[i + 1].to_ascii_lowercase();
            if matches!(next.as_str(), "ccache" | "sccache" | "yarn" | "pnpm") {
                let kind = if next == "yarn" || next == "pnpm" {
                    Kind::PackageCache
                } else {
                    Kind::CompilerCache
                };
                return Some((i + 2, kind));
            }
        }
        // Only the provider downloads, which `terraform init` puts back
        // from the lock file. The rest of .terraform records the selected
        // workspace and the last backend config, so it stays.
        if lower == ".terraform" && i + 1 < parts.len() {
            let next = parts[i + 1].to_ascii_lowercase();
            if matches!(next.as_str(), "providers" | "plugins") {
                return Some((i + 2, Kind::Terraform));
            }
        }
        // The documented plugin_cache_dir. `.terraform.d/plugins` holds
        // providers installed by hand, so it stays.
        if lower == ".terraform.d"
            && i + 1 < parts.len()
            && parts[i + 1].eq_ignore_ascii_case("plugin-cache")
        {
            return Some((i + 2, Kind::Terraform));
        }
        // The repo's history, not its working files. Every file here is
        // below a `.git` folder; a linked worktree's or submodule's `.git`
        // is a file and ends the path, so it never matches.
        if lower == ".git" && i + 1 < parts.len() {
            return Some((i + 1, Kind::GitRepo));
        }
        if let Some(kind) = mapped_kind(&lower) {
            let depth = if matches!(kind, Kind::Worktree) && i + 1 < parts.len() {
                i + 2
            } else {
                i + 1
            };
            return Some((depth, kind));
        }
        if matches!(lower.as_str(), "dist" | "build" | "out") {
            return Some((i + 1, Kind::JsBuild));
        }
    }
    None
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
    fn classifies_terraform_providers() {
        let (root, kind) = classify(
            "/Users/dev/infra/env/prod/.terraform/providers/registry.terraform.io/hashicorp/aws/6.54.0/darwin_arm64/terraform-provider-aws_v6.54.0_x5",
        )
        .unwrap();
        assert_eq!(root, "/Users/dev/infra/env/prod/.terraform/providers");
        assert!(matches!(kind, Kind::Terraform));

        let (root, kind) = classify(
            r"C:\infra\old\.terraform\plugins\windows_amd64\terraform-provider-aws_v2.70.0_x4.exe",
        )
        .unwrap();
        assert_eq!(root, r"C:\infra\old\.terraform\plugins");
        assert!(matches!(kind, Kind::Terraform));

        let (root, kind) = classify(
            "/home/dev/.terraform.d/plugin-cache/registry.terraform.io/hashicorp/aws/6.54.0/linux_amd64/terraform-provider-aws_v6.54.0_x5",
        )
        .unwrap();
        assert_eq!(root, "/home/dev/.terraform.d/plugin-cache");
        assert!(matches!(kind, Kind::Terraform));
    }

    #[test]
    fn leaves_terraform_state_and_hand_installed_plugins_alone() {
        for path in [
            "/Users/dev/infra/env/prod/.terraform/terraform.tfstate",
            "/Users/dev/infra/env/prod/.terraform/environment",
            "/Users/dev/infra/env/prod/.terraform/modules/modules.json",
            "/home/dev/.terraform.d/plugins/example.com/me/thing/1.0.0/linux_amd64/terraform-provider-thing",
        ] {
            assert!(classify(path).is_none(), "{path}");
        }
    }

    #[test]
    fn terraform_lock_file_marks_a_project() {
        let mut acc = DevArtifactAcc::new();
        acc.add("/Users/dev/infra/prod/.terraform.lock.hcl", 1_000, false, None);
        acc.add(
            "/Users/dev/infra/prod/.terraform/providers/registry.terraform.io/hashicorp/aws/6.54.0/darwin_arm64/terraform-provider-aws_v6.54.0_x5",
            800_000_000,
            false,
            None,
        );
        let roots = vec![SidecarRoot {
            path: "/Users/dev/infra/prod/.terraform/providers".to_string(),
            kind: "terraform".to_string(),
            size: 800_000_000,
            files: 1,
            clone: None,
            worktree: None,
        }];
        assert_eq!(
            projects_for_roots(&acc.projects, &roots),
            vec!["/Users/dev/infra/prod".to_string()]
        );
    }

    #[test]
    fn classifies_git_dir_as_one_repo() {
        let (root, kind) =
            classify("/Users/dev/github/openclaw/.git/objects/pack/pack-1234.pack").unwrap();
        assert_eq!(root, "/Users/dev/github/openclaw/.git");
        assert!(matches!(kind, Kind::GitRepo));

        // Submodules keep their history under the parent's .git/modules.
        let (root, kind) =
            classify(r"C:\src\app\.git\modules\vendor\lib\objects\pack\pack-1.pack").unwrap();
        assert_eq!(root, r"C:\src\app\.git");
        assert!(matches!(kind, Kind::GitRepo));

        // A branch named like a build folder is still history.
        let (root, _) = classify("/Users/dev/app/.git/refs/heads/build").unwrap();
        assert_eq!(root, "/Users/dev/app/.git");
    }

    #[test]
    fn leaves_worktree_and_submodule_git_files_alone() {
        for path in [
            "/Users/dev/app-feature/.git",
            "/Users/dev/app/vendor/lib/.git",
            r"C:\src\app\.worktrees\feat\.git",
        ] {
            let classified = classify(path);
            assert!(
                !matches!(classified, Some((_, Kind::GitRepo))),
                "{path}"
            );
        }
    }

    #[test]
    fn git_dir_inside_node_modules_stays_node_modules() {
        let (root, kind) =
            classify("/Users/dev/app/node_modules/dep/.git/objects/ab/cdef").unwrap();
        assert_eq!(root, "/Users/dev/app/node_modules");
        assert!(matches!(kind, Kind::NodeModules));
    }

    #[test]
    fn reads_the_main_checkout_from_a_worktree_git_file() {
        // `git worktree add` writes an absolute gitdir.
        assert_eq!(
            worktree_project(
                "/Users/dev/claude-worktrees/diskhound/fix-x",
                "gitdir: /Users/dev/github/diskhound/.git/worktrees/fix-x\n",
            ),
            Some("/Users/dev/github/diskhound".to_string()),
        );
        // `--relative-paths` (git 2.48+) writes one relative to the worktree.
        assert_eq!(
            worktree_project(
                "/Users/dev/.codex/worktrees/ab12/app",
                "gitdir: ../../../../github/app/.git/worktrees/app\n",
            ),
            Some("/Users/dev/github/app".to_string()),
        );
        // A bare repo is its own project.
        assert_eq!(
            worktree_project("/srv/wt/feat", "gitdir: /srv/repos/app.git/worktrees/feat"),
            Some("/srv/repos/app.git".to_string()),
        );
        // Git for Windows writes forward slashes; keep the scan's style.
        assert_eq!(
            worktree_project(
                r"C:\Users\dev\wt\app",
                "gitdir: C:/Users/dev/src/app/.git/worktrees/app\r\n",
            ),
            Some(r"C:\Users\dev\src\app".to_string()),
        );
    }

    #[test]
    fn submodule_and_other_git_files_are_not_worktrees() {
        for (dir, contents) in [
            // A submodule's history lives in the parent's .git/modules.
            ("/Users/dev/app/vendor/lib", "gitdir: ../../.git/modules/vendor/lib\n"),
            ("/Users/dev/app/vendor/lib", "gitdir: /Users/dev/app/.git/modules/vendor/lib"),
            // A submodule checked out inside a linked worktree.
            ("/wt/feat/vendor/lib", "gitdir: /main/.git/worktrees/feat/modules/vendor/lib"),
            // A nested submodule.
            ("/Users/dev/app/a/b", "gitdir: ../../.git/modules/a/modules/b"),
            ("/Users/dev/app", "ref: refs/heads/main\n"),
            ("/Users/dev/app", "gitdir:\n"),
            ("/Users/dev/app", ""),
            // `worktrees` must be the common dir's own folder.
            ("/x", "gitdir: worktrees"),
        ] {
            assert_eq!(worktree_project(dir, contents), None, "{dir}: {contents:?}");
        }
    }

    /// Stands in for the disk: a `.git` under `vendor/` is a submodule,
    /// any other one a worktree of /Users/dev/github/<leaf>.
    fn fake_git_file(path: &str) -> Option<String> {
        let dir = parent_path(path)?;
        if dir.contains("/vendor/") {
            return Some("gitdir: ../../.git/modules/vendor/lib\n".to_string());
        }
        let leaf = file_name(&dir)?;
        Some(format!("gitdir: /Users/dev/github/{leaf}/.git/worktrees/{leaf}\n"))
    }

    /// (path, size) → recursive folder totals, like the scan's
    /// `directory_totals`.
    fn tree_totals_of(files: &[(&str, u64)]) -> HashMap<String, (u64, u64)> {
        let mut totals: HashMap<String, (u64, u64)> = HashMap::new();
        for (path, size) in files {
            let mut cursor = parent_path(path);
            while let Some(dir) = cursor {
                let entry = totals.entry(dir.clone()).or_default();
                entry.0 += size;
                entry.1 += 1;
                cursor = parent_path(&dir).filter(|parent| *parent != dir);
            }
        }
        totals
    }

    fn resolve(acc: &mut DevArtifactAcc, files: &[(&str, u64)]) {
        let totals = tree_totals_of(files);
        acc.resolve_worktrees(&|path| totals.get(path).copied());
    }

    #[test]
    fn a_worktree_git_file_makes_the_whole_checkout_one_row_in_any_order() {
        let wt = "/Users/dev/claude-worktrees/app/feat";
        let files: Vec<(String, u64)> = vec![
            (format!("{wt}/src/main.ts"), 4_000),
            (format!("{wt}/node_modules/react/index.js"), 50_000),
            (format!("{wt}/packages/ui/node_modules/x/y.js"), 30_000),
            (format!("{wt}/target/debug/app"), 900_000),
            (format!("{wt}/.git"), 4_096),
            (format!("{wt}/package.json"), 1_000),
            // A submodule inside it: part of the worktree, not its own.
            (format!("{wt}/vendor/lib/.git"), 4_096),
            (format!("{wt}/vendor/lib/lib.c"), 2_000),
            // Elsewhere: a plain project with its own node_modules.
            ("/Users/dev/github/app/node_modules/a/b.js".to_string(), 7_000),
        ];
        let files: Vec<(&str, u64)> = files.iter().map(|(p, s)| (p.as_str(), *s)).collect();
        let tree_size: u64 = files.iter().filter(|(p, _)| p.starts_with(wt)).map(|(_, s)| s).sum();
        // The `.git` file first, last, and in the middle.
        for order in [vec![4, 0, 1, 2, 3, 5, 6, 7, 8], vec![0, 1, 2, 3, 5, 6, 7, 8, 4], (0..9).collect()] {
            let mut acc = DevArtifactAcc::with_git_reader(fake_git_file);
            for i in &order {
                let (path, size) = files[*i];
                acc.add(path, size, false, None);
            }
            resolve(&mut acc, &files);
            let rec = &acc.artifacts[wt];
            assert!(matches!(rec.kind, Kind::Worktree));
            assert_eq!(rec.size, tree_size);
            assert_eq!(rec.files, 8);
            assert_eq!(rec.project.as_deref(), Some("/Users/dev/github/feat"));
            assert_eq!(
                rec.nested,
                BTreeMap::from([("node-modules", 80_000), ("rust-target", 900_000)]),
            );
            // Folded in, so no byte is listed twice.
            assert!(!acc.artifacts.contains_key(&format!("{wt}/node_modules")));
            assert!(!acc.artifacts.contains_key(&format!("{wt}/target/debug")));
            assert!(!acc.artifacts.contains_key(&format!("{wt}/vendor/lib")));
            assert!(acc.artifacts.contains_key("/Users/dev/github/app/node_modules"));
            // The worktree's .git and the submodule's: both outside every tree.
            assert_eq!(acc.git_file_reads(), 2);
            assert_eq!(acc.worktree_count(), 1);
        }
    }

    #[test]
    fn a_submodule_git_file_alone_is_not_a_worktree() {
        let files = [
            ("/Users/dev/app/vendor/lib/.git", 4_096),
            ("/Users/dev/app/vendor/lib/node_modules/x.js", 1_000),
        ];
        let mut acc = DevArtifactAcc::with_git_reader(fake_git_file);
        for (path, size) in files {
            acc.add(path, size, false, None);
        }
        resolve(&mut acc, &files);
        assert_eq!(acc.worktree_count(), 0);
        assert!(acc.artifacts.contains_key("/Users/dev/app/vendor/lib/node_modules"));
        assert_eq!(acc.git_file_reads(), 1);
    }

    #[test]
    fn git_files_inside_another_tree_are_not_read() {
        let mut acc = DevArtifactAcc::with_git_reader(|_| panic!("read a .git inside a tree"));
        acc.add("/Users/dev/app/node_modules/dep/.git", 100, false, None);
        acc.add("/Users/dev/app/target/debug/build/x/.git", 100, false, None);
        acc.add("/Users/dev/app/.git/modules/lib/.git", 100, false, None);
        assert_eq!(acc.git_file_reads(), 0);
    }

    #[test]
    fn a_worktree_inside_another_worktree_is_part_of_it() {
        let outer = "/Users/dev/wt/app";
        let inner = "/Users/dev/wt/app/.claude/worktrees/app";
        let files = [
            ("/Users/dev/wt/app/.git", 4_096),
            ("/Users/dev/wt/app/.claude/worktrees/app/.git", 4_096),
            ("/Users/dev/wt/app/.claude/worktrees/app/node_modules/a.js", 10_000),
            ("/Users/dev/wt/app/README.md", 500),
        ];
        let mut acc = DevArtifactAcc::with_git_reader(fake_git_file);
        for (path, size) in files.iter().rev() {
            acc.add(path, *size, false, None);
        }
        resolve(&mut acc, &files);
        assert_eq!(acc.worktree_count(), 1);
        assert_eq!(acc.artifacts[outer].size, 4_096 * 2 + 10_000 + 500);
        assert!(!acc.artifacts.contains_key(inner));
    }

    #[test]
    fn dot_worktrees_trees_get_their_project_and_nested_sizes() {
        let files = [
            (r"C:\src\app\.worktrees\feat\.git", 4_096u64),
            (r"C:\src\app\.worktrees\feat\node_modules\x\i.js", 20_000),
            (r"C:\src\app\.worktrees\feat\src\a.rs", 1_000),
        ];
        fn windows_git_file(_: &str) -> Option<String> {
            Some("gitdir: C:/src/app/.git/worktrees/feat\n".to_string())
        }
        let mut acc = DevArtifactAcc::with_git_reader(windows_git_file);
        for (path, size) in files {
            acc.add(path, size, false, None);
        }
        // No folder rollups: the per-file sums already cover the tree.
        acc.resolve_worktrees(&|_| None);
        let rec = &acc.artifacts[r"C:\src\app\.worktrees\feat"];
        assert_eq!(rec.size, 25_096);
        assert_eq!(rec.project.as_deref(), Some(r"C:\src\app"));
        assert_eq!(rec.nested, BTreeMap::from([("node-modules", 20_000)]));
        assert_eq!(acc.git_file_reads(), 1);
    }

    #[test]
    #[cfg(unix)]
    fn reads_a_real_git_file() {
        let dir = std::env::temp_dir().join(format!("dh-dev-wt-{}", std::process::id()));
        let wt = dir.join("wt").join("app");
        std::fs::create_dir_all(&wt).unwrap();
        let git = wt.join(".git");
        std::fs::write(&git, "gitdir: /Users/dev/github/app/.git/worktrees/app\n").unwrap();
        let src = wt.join("main.c");
        let mut acc = DevArtifactAcc::new();
        acc.add(&src.to_string_lossy(), 2_000, false, None);
        acc.add(&git.to_string_lossy(), 100, false, None);
        acc.resolve_worktrees(&|_| None);
        let rec = &acc.artifacts[&*wt.to_string_lossy()];
        assert!(matches!(rec.kind, Kind::Worktree));
        assert_eq!(rec.project.as_deref(), Some("/Users/dev/github/app"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn worktree_clone_accounting_counts_the_whole_checkout() {
        use crate::clone_attrs::{CloneAttrs, EF_MAY_SHARE_BLOCKS, EF_SHARES_ALL_BLOCKS};
        const SIZE: u64 = 1_000_000;
        let copy_of = |id: u64, refcnt: u32| CloneAttrs {
            private_size: Some(0),
            clone_id: id,
            volume_id: 1,
            clone_refcnt: refcnt,
            ext_flags: EF_MAY_SHARE_BLOCKS | EF_SHARES_ALL_BLOCKS,
        };
        let plain = CloneAttrs::default();
        let wt = "/Users/dev/.codex/worktrees/ab12/app";
        let files: [(String, u64, CloneAttrs); 6] = [
            // Group 1: both copies in the worktree, in two node_modules.
            (format!("{wt}/node_modules/a/i.js"), SIZE, copy_of(1, 2)),
            (format!("{wt}/packages/ui/node_modules/a/i.js"), SIZE, copy_of(1, 2)),
            // Group 2: one of four copies here, the rest in the pnpm store.
            (format!("{wt}/node_modules/b/i.js"), SIZE, copy_of(2, 4)),
            // A clone among its own files: shared with a file elsewhere.
            (format!("{wt}/assets/logo.png"), SIZE, copy_of(3, 2)),
            (format!("{wt}/src/main.ts"), 10_000, plain),
            (format!("{wt}/.git"), 4_096, plain),
        ];
        let mut acc = DevArtifactAcc::with_git_reader(fake_git_file);
        let mut groups = CloneGroups::new();
        // The .git file arrives last, after every clone.
        for (path, size, attrs) in &files {
            let root = acc.add(path, *size, false, Some(attrs));
            groups.add(attrs, *size, root.unwrap_or(crate::clone_attrs::OUTSIDE_ROOTS));
        }
        for i in 0..3 {
            let store = format!("/Users/dev/Library/pnpm/store/v10/files/b{i}");
            let root = acc.add(&store, SIZE, false, Some(&copy_of(2, 4))).unwrap();
            groups.add(&copy_of(2, 4), SIZE, root);
        }
        let listed: Vec<(&str, u64)> = files.iter().map(|(p, s, _)| (p.as_str(), *s)).collect();
        resolve(&mut acc, &listed);

        let shares = groups.attribute_remapped(acc.root_id_count(), &acc.root_remap);
        let rec = &acc.artifacts[wt];
        assert_eq!(rec.size, 4 * SIZE + 10_000 + 4_096);
        let info = sidecar_clone(&acc, rec, shares.get(rec.id as usize)).unwrap();
        assert_eq!(info.clone_size, 4 * SIZE);
        assert_eq!(info.clone_private_size, 0);
        // Group 1 is the worktree's alone once its node_modules fold in.
        assert_eq!(info.clone_internal_size, SIZE);
        // Group 2's copy and the loose clone are shared with files elsewhere.
        assert_eq!(info.clone_shared_size, 2 * SIZE);
        assert_eq!(info.clone_shared_blocks, SIZE / 4 + SIZE / 2);
        assert_eq!(info.shared_with, vec!["/Users/dev/Library/pnpm/store".to_string()]);
        // What removing it alone frees: its plain files plus group 1.
        let sharing_frees = rec.size - info.clone_size + info.clone_private_size + info.clone_internal_size;
        assert_eq!(sharing_frees, 10_000 + 4_096 + SIZE);
    }

    #[test]
    fn sidecar_writes_worktree_project_and_nested_sizes() {
        let files = [
            ("/Users/dev/wt/app/.git", 4_096),
            ("/Users/dev/wt/app/node_modules/x.js", 10_000),
        ];
        let mut acc = DevArtifactAcc::with_git_reader(fake_git_file);
        for (path, size) in files {
            acc.add(path, size, false, None);
        }
        resolve(&mut acc, &files);
        let dir = std::env::temp_dir().join(format!("dh-dev-wt-sidecar-{}", std::process::id()));
        let out = dir.join("scan.dev-artifacts.json");
        write_sidecar(&out, "/", &acc, None).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        let roots = parsed["roots"].as_array().unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0]["kind"], "worktree");
        assert_eq!(roots[0]["size"], 14_096);
        assert_eq!(roots[0]["worktree"]["project"], "/Users/dev/github/app");
        assert_eq!(roots[0]["worktree"]["nestedSize"]["node-modules"], 10_000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// AGENTS.md scaling rule: count `work::step()`s at N and 8N.
    #[test]
    fn resolving_worktrees_is_linear_in_worktrees_trees_and_clone_folders() {
        use crate::clone_attrs::{CloneAttrs, EF_MAY_SHARE_BLOCKS};
        let loose = CloneAttrs {
            private_size: Some(0),
            ext_flags: EF_MAY_SHARE_BLOCKS,
            ..CloneAttrs::default()
        };
        let run = |worktrees: usize| -> u64 {
            let mut acc = DevArtifactAcc::with_git_reader(fake_git_file);
            let mut files: Vec<(String, u64)> = Vec::new();
            for w in 0..worktrees {
                let wt = format!("/Users/dev/wt/r{}/w{w}", w % 7);
                files.push((format!("{wt}/.git"), 4_096));
                for p in 0..3 {
                    files.push((format!("{wt}/packages/p{p}/node_modules/x/i.js"), 1_000));
                    files.push((format!("{wt}/packages/p{p}/src/logo.png"), 1_000));
                }
                files.push((format!("{wt}/target/debug/app"), 1_000));
                // Trees and clones outside every worktree.
                files.push((format!("/Users/dev/github/r{w}/node_modules/x/i.js"), 1_000));
                files.push((format!("/Users/dev/github/r{w}/src/logo.png"), 1_000));
            }
            for (path, size) in &files {
                let attrs = path.ends_with(".png").then_some(&loose);
                acc.add(path, *size, false, attrs);
            }
            let listed: Vec<(&str, u64)> = files.iter().map(|(p, s)| (p.as_str(), *s)).collect();
            let totals = tree_totals_of(&listed);
            crate::work::take();
            acc.resolve_worktrees(&|path| totals.get(path).copied());
            let steps = crate::work::take();
            assert_eq!(acc.worktree_count(), worktrees);
            steps
        };
        let small = run(250);
        let large = run(2_000);
        let growth = large as f64 / small as f64;
        eprintln!("resolve_worktrees: {small} -> {large} steps ({growth:.1}x)");
        assert!(growth <= 16.0, "grew {growth:.1}x from N to 8N");
        // ~12 trees and clone folders per worktree, each a few parent hops.
        assert!(large <= 2_000 * 150, "{large} steps at 8N");
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
            volume_id: 1,
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
            volume_id: 1,
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
