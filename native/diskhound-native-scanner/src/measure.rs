//! `--mode=measure-removal`: what removing a set of files and folders
//! together would free, measured on disk now rather than read from a scan.
//!
//! A scan adds up each file's allocated blocks and counts a hardlinked file
//! once. Removing files gives back less than that when blocks are shared:
//!
//! - **APFS full clones** share every block. The blocks come back only when
//!   every clone is gone. APFS reports how many clones a group has
//!   (`CLONE_REFCNT`), so clones outside the set, and outside any scan,
//!   still count.
//! - **A rewritten clone** owns the blocks it rewrote (`PRIVATESIZE`) and
//!   shares the rest with clones nothing identifies. Those shared bytes
//!   are reported as uncertain, never as freed.
//! - **A hardlinked file** comes back only when every name is gone.
//!
//! Every byte is counted against the set together and against each path
//! alone. Time Machine local snapshots and the Trash hold freed blocks
//! for a while longer; the app explains those.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

#[cfg(all(unix, not(target_os = "macos")))]
use std::os::unix::fs::MetadataExt;

use serde::Serialize;

use crate::clone_attrs::CloneAttrs;
use crate::walk_prune;
use crate::work;

/// Holders of one shared member: each input path holding a name of it,
/// and whether removing that path alone removes the member.
type Holders = Vec<(u32, bool)>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathTotals {
    pub files: u64,
    /// Allocated bytes, each hardlinked file once.
    pub size_bytes: u64,
    /// Removing only this path frees this much.
    pub frees_alone_bytes: u64,
    /// Blocks in this path that files outside it also hold.
    pub shared_bytes: u64,
    /// Rewritten clones' blocks shared with clones DiskHound can't identify.
    pub uncertain_bytes: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetTotals {
    pub files: u64,
    pub size_bytes: u64,
    /// Removing every path together frees this much.
    pub frees_bytes: u64,
    /// Blocks that stay because files outside the set hold them too.
    pub held_elsewhere_bytes: u64,
    pub uncertain_bytes: u64,
}

struct InodeRec {
    nlink: u64,
    occupancy: u64,
    attrs: CloneAttrs,
    names: u64,
}

struct GroupRec {
    refcnt: u32,
    /// Blocks the group's clones share, counted once.
    bytes: u64,
    /// Members the whole set removes.
    removed: u32,
}

/// The accounting, apart from the walk, so tests can feed it files.
#[derive(Default)]
pub struct Tally {
    paths: Vec<PathTotals>,
    total: SetTotals,
    inode_ids: HashMap<(u64, u64), u32>,
    inodes: Vec<InodeRec>,
    /// (inode, path) → names of that inode inside the path.
    inode_names: HashMap<(u32, u32), u64>,
    group_ids: HashMap<(u64, u64), u32>,
    groups: Vec<GroupRec>,
    /// (group, path) → members that removing the path alone removes. An
    /// entry with 0 still marks the path as holding the group.
    group_alone: HashMap<(u32, u32), u32>,
}

impl Tally {
    pub fn new(paths: usize) -> Self {
        Self {
            paths: vec![PathTotals::default(); paths],
            ..Self::default()
        }
    }

    /// One name of a regular file under input path `path`.
    pub fn add_file(
        &mut self,
        path: u32,
        occupancy: u64,
        nlink: u64,
        inode: (u64, u64),
        attrs: CloneAttrs,
    ) {
        work::step();
        self.total.files += 1;
        self.paths[path as usize].files += 1;
        if nlink > 1 {
            let next = self.inodes.len() as u32;
            let id = *self.inode_ids.entry(inode).or_insert(next);
            if id == next {
                self.inodes.push(InodeRec {
                    nlink,
                    occupancy,
                    attrs,
                    names: 0,
                });
            }
            self.inodes[id as usize].names += 1;
            *self.inode_names.entry((id, path)).or_insert(0) += 1;
            return;
        }
        self.total.size_bytes += occupancy;
        self.paths[path as usize].size_bytes += occupancy;
        self.member(true, &[(path, true)], occupancy, attrs);
    }

    /// Something whose blocks come back when `together` (the whole set
    /// removes it) or when a holder that removes it alone goes.
    fn member(
        &mut self,
        together: bool,
        holders: &[(u32, bool)],
        occupancy: u64,
        attrs: CloneAttrs,
    ) {
        work::step();
        if !attrs.may_share() {
            self.own(together, holders, occupancy, 0);
            return;
        }
        let private = attrs.clone_private_of(occupancy);
        let shared = occupancy - private;
        let Some((clone_id, refcnt)) = attrs.full_clone_group() else {
            // A rewritten clone: what it rewrote is its own, the rest is
            // shared with clones nothing here identifies.
            self.own(together, holders, private, shared);
            return;
        };
        self.own(together, holders, private, 0);
        let next = self.groups.len() as u32;
        let id = *self
            .group_ids
            .entry((attrs.volume_id, clone_id))
            .or_insert(next);
        if id == next {
            self.groups.push(GroupRec {
                refcnt,
                bytes: 0,
                removed: 0,
            });
        }
        let group = &mut self.groups[id as usize];
        group.refcnt = group.refcnt.max(refcnt);
        group.bytes = group.bytes.max(shared);
        group.removed += u32::from(together);
        for &(path, alone) in holders {
            work::step();
            *self.group_alone.entry((id, path)).or_insert(0) += u32::from(alone);
        }
    }

    /// Bytes that only these holders hold, plus `uncertain` bytes that
    /// come back only if clones elsewhere go too.
    fn own(&mut self, together: bool, holders: &[(u32, bool)], bytes: u64, uncertain: u64) {
        if together {
            self.total.frees_bytes += bytes;
            self.total.uncertain_bytes += uncertain;
        } else {
            self.total.held_elsewhere_bytes += bytes + uncertain;
        }
        for &(path, alone) in holders {
            work::step();
            let totals = &mut self.paths[path as usize];
            if alone {
                totals.frees_alone_bytes += bytes;
                totals.uncertain_bytes += uncertain;
            } else {
                totals.shared_bytes += bytes + uncertain;
            }
        }
    }

    pub fn finish(mut self) -> (Vec<PathTotals>, SetTotals) {
        // Hardlinked files: each inode once, removed when every name is in.
        let mut holders: Vec<Holders> = (0..self.inodes.len()).map(|_| Vec::new()).collect();
        for (&(inode, path), &names) in &self.inode_names {
            work::step();
            let nlink = self.inodes[inode as usize].nlink;
            holders[inode as usize].push((path, names >= nlink));
        }
        let inodes = std::mem::take(&mut self.inodes);
        for (inode, held) in inodes.into_iter().zip(holders) {
            work::step();
            self.total.size_bytes += inode.occupancy;
            for &(path, _) in &held {
                self.paths[path as usize].size_bytes += inode.occupancy;
            }
            let together = inode.names >= inode.nlink;
            self.member(together, &held, inode.occupancy, inode.attrs);
        }
        // Clone groups: freed once every clone APFS counts is removed.
        for group in &self.groups {
            work::step();
            if group.removed >= group.refcnt {
                self.total.frees_bytes += group.bytes;
            } else {
                self.total.held_elsewhere_bytes += group.bytes;
            }
        }
        for (&(group, path), &alone) in &self.group_alone {
            work::step();
            let group = &self.groups[group as usize];
            let totals = &mut self.paths[path as usize];
            if alone >= group.refcnt {
                totals.frees_alone_bytes += group.bytes;
            } else {
                totals.shared_bytes += group.bytes;
            }
        }
        (self.paths, self.total)
    }
}

// ── The walk ────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathReport {
    pub path: String,
    pub kind: &'static str,
    #[serde(flatten)]
    pub totals: PathTotals,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NestedPath {
    pub path: String,
    pub within: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureReport {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub paths: Vec<PathReport>,
    pub total: SetTotals,
    /// Paths that don't exist.
    pub missing: Vec<String>,
    /// Paths inside another listed path, measured as part of it.
    pub nested: Vec<NestedPath>,
    /// Entries that couldn't be read.
    pub skipped_entries: u64,
    /// Whether APFS clones were read; false off APFS or when turned off.
    pub clone_metadata: bool,
    pub elapsed_ms: u64,
}

enum Root {
    /// A listed folder: input index.
    Folder(u32),
    /// The parent folder of listed files: their names and input indices.
    Parent(HashMap<OsString, u32>),
}

/// Drop exact repeats and paths inside another listed path.
fn outermost(paths: &[PathBuf]) -> (Vec<PathBuf>, Vec<NestedPath>) {
    let mut sorted: Vec<&PathBuf> = paths.iter().collect();
    sorted.sort();
    sorted.dedup();
    let mut kept: Vec<PathBuf> = Vec::new();
    let mut nested = Vec::new();
    for path in sorted {
        work::step();
        // Sorted, so an ancestor is the last kept path if any is.
        match kept.last() {
            Some(parent) if path.starts_with(parent) => nested.push(NestedPath {
                path: path.to_string_lossy().into_owned(),
                within: parent.to_string_lossy().into_owned(),
            }),
            _ => kept.push(path.clone()),
        }
    }
    (kept, nested)
}

pub fn measure(
    paths: &[PathBuf],
    workers: usize,
    cancelled: &AtomicBool,
) -> Result<MeasureReport, String> {
    let started = Instant::now();
    let (kept, nested) = outermost(paths);
    let mut missing = Vec::new();
    let mut listed: Vec<(PathBuf, &'static str)> = Vec::new();
    let mut roots: Vec<(PathBuf, Root)> = Vec::new();
    let mut parents: HashMap<PathBuf, usize> = HashMap::new();
    for path in kept {
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            missing.push(path.to_string_lossy().into_owned());
            continue;
        };
        let index = listed.len() as u32;
        if metadata.is_dir() {
            listed.push((path.clone(), "folder"));
            roots.push((path, Root::Folder(index)));
            continue;
        }
        // A file: read it with the rest of its folder, which is where
        // the bulk read returns its clone id.
        let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
            missing.push(path.to_string_lossy().into_owned());
            continue;
        };
        listed.push((path.clone(), "file"));
        let slot = *parents.entry(parent.to_path_buf()).or_insert_with(|| {
            roots.push((parent.to_path_buf(), Root::Parent(HashMap::new())));
            roots.len() - 1
        });
        if let Root::Parent(names) = &mut roots[slot].1 {
            names.insert(name.to_owned(), index);
        }
    }

    let plans: Arc<Vec<Option<walk_prune::PrunePlan>>> = Arc::new(
        roots
            .iter()
            .map(|(path, root)| matches!(root, Root::Folder(_)).then(|| walk_prune::plan_for(path)))
            .collect(),
    );
    #[cfg(target_os = "macos")]
    let clone_metadata = roots
        .iter()
        .any(|(path, _)| crate::clone_attrs::enable_for_root(path));
    #[cfg(not(target_os = "macos"))]
    let clone_metadata = false;
    #[cfg(target_os = "macos")]
    let options = dua_core::Options {
        apfs_clone_metadata: clone_metadata,
        ..dua_core::Options::default()
    };
    #[cfg(not(target_os = "macos"))]
    let options = dua_core::Options::default();

    let walk_plans = Arc::clone(&plans);
    let walker = dua_core::walk_roots(
        roots
            .iter()
            .enumerate()
            .map(|(index, (path, _))| (index, path.clone())),
        workers.max(1),
        dua_core::Order::Completion,
        options,
        move |root, entry| match &walk_plans[root] {
            // A listed file's folder: read it, nothing below it.
            None => entry.depth == 0,
            Some(plan) => {
                entry.depth == 0
                    || plan
                        .skip_reason(&entry.path().to_string_lossy(), true)
                        .is_none()
            }
        },
    );

    let mut tally = Tally::new(listed.len());
    let mut skipped_entries = 0u64;
    #[cfg(target_os = "macos")]
    let mut clone_cache = crate::clone_attrs::CloneAttrCache::default();
    let mut last_progress = Instant::now();
    for (root, event) in walker {
        if cancelled.load(Ordering::Relaxed) {
            return Err("Measurement cancelled".into());
        }
        let entry = match event {
            dua_core::RootEvent::Finished => continue,
            dua_core::RootEvent::Entry(Ok(entry)) => entry,
            dua_core::RootEvent::Entry(Err(_)) => {
                skipped_entries += 1;
                continue;
            }
        };
        if !entry.file_type.is_file() {
            continue;
        }
        let index = match &roots[root].1 {
            Root::Folder(index) => *index,
            Root::Parent(names) => match (entry.depth, names.get(&entry.file_name)) {
                (1, Some(index)) => *index,
                _ => continue,
            },
        };
        let Some(metadata) = entry.metadata.as_ref().and_then(|meta| meta.as_ref().ok()) else {
            skipped_entries += 1;
            continue;
        };
        let occupancy = metadata.blocks().saturating_mul(512);
        let nlink = metadata.nlink();
        let inode = (metadata.dev(), metadata.ino());
        #[cfg(target_os = "macos")]
        let attrs = if clone_metadata {
            clone_cache.get(
                &entry.path(),
                metadata.clone_id(),
                metadata.real_dev(),
                (nlink > 1).then_some(inode),
            )
        } else {
            CloneAttrs::default()
        };
        #[cfg(not(target_os = "macos"))]
        let attrs = CloneAttrs::default();
        tally.add_file(index, occupancy, nlink, inode, attrs);
        if last_progress.elapsed().as_secs() >= 1 {
            last_progress = Instant::now();
            emit(&serde_json::json!({ "type": "progress", "files": tally.total.files }));
        }
    }

    let (totals, total) = tally.finish();
    Ok(MeasureReport {
        kind: "removal-measurement",
        paths: listed
            .into_iter()
            .zip(totals)
            .map(|((path, kind), totals)| PathReport {
                path: path.to_string_lossy().into_owned(),
                kind,
                totals,
            })
            .collect(),
        total,
        missing,
        nested,
        skipped_entries,
        clone_metadata,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn emit(value: &impl Serialize) {
    let mut out = std::io::stdout().lock();
    let _ = serde_json::to_writer(&mut out, value);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

/// `--mode=measure-removal --path <abs> [--path <abs>…] [--workers N]`.
/// Prints progress lines, then one `removal-measurement` line.
pub fn run(args: &[String], cancelled: &AtomicBool) -> Result<(), String> {
    let mut paths = Vec::new();
    let mut workers = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--mode=measure-removal" => {}
            "--mode" => {
                iter.next();
            }
            "--path" => {
                let path = PathBuf::from(iter.next().ok_or("Expected a path after --path")?);
                if !path.is_absolute() {
                    return Err(format!("--path must be absolute: {}", path.display()));
                }
                paths.push(path);
            }
            "--workers" => {
                let value = iter.next().ok_or("Expected a number after --workers")?;
                workers = Some(
                    value
                        .parse::<usize>()
                        .map_err(|_| format!("Invalid --workers: {value}"))?,
                );
            }
            other => return Err(format!("Unknown measure-removal arg: {other}")),
        }
    }
    if paths.is_empty() {
        return Err("measure-removal needs at least one --path".into());
    }
    let workers = crate::walk_workers(workers, num_cpus::get().clamp(1, 8));
    let report = measure(&paths, workers, cancelled)?;
    emit(&report);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clone_attrs::{EF_MAY_SHARE_BLOCKS, EF_SHARES_ALL_BLOCKS};

    fn clone(id: u64, refcnt: u32) -> CloneAttrs {
        CloneAttrs {
            private_size: Some(0),
            clone_id: id,
            volume_id: 7,
            clone_refcnt: refcnt,
            ext_flags: EF_MAY_SHARE_BLOCKS | EF_SHARES_ALL_BLOCKS,
        }
    }

    fn rewritten(private: u64) -> CloneAttrs {
        CloneAttrs {
            private_size: Some(private),
            clone_id: 99,
            volume_id: 7,
            clone_refcnt: 1,
            ext_flags: EF_MAY_SHARE_BLOCKS,
        }
    }

    const PLAIN: CloneAttrs = CloneAttrs {
        private_size: None,
        clone_id: 0,
        volume_id: 0,
        clone_refcnt: 0,
        ext_flags: 0,
    };

    #[test]
    fn ordinary_files_free_their_blocks_alone_and_together() {
        let mut tally = Tally::new(2);
        tally.add_file(0, 4096, 1, (1, 1), PLAIN);
        tally.add_file(1, 8192, 1, (1, 2), PLAIN);
        let (paths, total) = tally.finish();
        assert_eq!(paths[0].frees_alone_bytes, 4096);
        assert_eq!(paths[1].frees_alone_bytes, 8192);
        assert_eq!(
            total,
            SetTotals {
                files: 2,
                size_bytes: 12288,
                frees_bytes: 12288,
                held_elsewhere_bytes: 0,
                uncertain_bytes: 0
            }
        );
    }

    #[test]
    fn a_clone_group_comes_back_only_when_every_clone_is_in_the_set() {
        // Group 1: one copy in each path, 2 clones in all → freed together only.
        // Group 2: 3 clones, the third outside the set → never freed.
        let mut tally = Tally::new(2);
        tally.add_file(0, 1000, 1, (1, 1), clone(1, 2));
        tally.add_file(1, 1000, 1, (1, 2), clone(1, 2));
        tally.add_file(0, 500, 1, (1, 3), clone(2, 3));
        tally.add_file(1, 500, 1, (1, 4), clone(2, 3));
        let (paths, total) = tally.finish();
        assert_eq!(total.size_bytes, 3000);
        assert_eq!(total.frees_bytes, 1000);
        assert_eq!(total.held_elsewhere_bytes, 500);
        for path in &paths {
            assert_eq!(path.frees_alone_bytes, 0);
            assert_eq!(path.shared_bytes, 1500);
        }
    }

    #[test]
    fn a_group_inside_one_path_comes_back_with_that_path_alone() {
        let mut tally = Tally::new(2);
        tally.add_file(0, 1000, 1, (1, 1), clone(1, 2));
        tally.add_file(0, 1000, 1, (1, 2), clone(1, 2));
        let (paths, total) = tally.finish();
        assert_eq!(paths[0].frees_alone_bytes, 1000);
        assert_eq!(paths[0].shared_bytes, 0);
        assert_eq!(total.frees_bytes, 1000);
    }

    #[test]
    fn a_rewritten_clone_frees_its_rewrite_and_leaves_the_rest_uncertain() {
        let mut tally = Tally::new(1);
        tally.add_file(0, 10_000, 1, (1, 1), rewritten(4096));
        let (paths, total) = tally.finish();
        assert_eq!(total.frees_bytes, 4096);
        assert_eq!(total.uncertain_bytes, 10_000 - 4096);
        assert_eq!(paths[0].frees_alone_bytes, 4096);
        assert_eq!(paths[0].uncertain_bytes, 10_000 - 4096);
    }

    #[test]
    fn a_hardlink_comes_back_when_every_name_is_in_the_set() {
        // Inode 5: names in both paths (2 links). Inode 6: one of 2 names.
        let mut tally = Tally::new(2);
        tally.add_file(0, 4096, 2, (1, 5), PLAIN);
        tally.add_file(1, 4096, 2, (1, 5), PLAIN);
        tally.add_file(0, 8192, 2, (1, 6), PLAIN);
        let (paths, total) = tally.finish();
        assert_eq!(total.files, 3);
        assert_eq!(total.size_bytes, 4096 + 8192);
        assert_eq!(total.frees_bytes, 4096);
        assert_eq!(total.held_elsewhere_bytes, 8192);
        assert_eq!(paths[0].size_bytes, 4096 + 8192);
        assert_eq!(paths[0].frees_alone_bytes, 0);
        assert_eq!(paths[0].shared_bytes, 4096 + 8192);
        assert_eq!(paths[1].shared_bytes, 4096);
    }

    #[test]
    fn a_hardlinked_clone_counts_once_toward_its_group() {
        // One inode with two names (one APFS clone), plus its other clone.
        let mut tally = Tally::new(1);
        tally.add_file(0, 2048, 2, (1, 8), clone(3, 2));
        tally.add_file(0, 2048, 2, (1, 8), clone(3, 2));
        tally.add_file(0, 2048, 1, (1, 9), clone(3, 2));
        let (paths, total) = tally.finish();
        assert_eq!(total.size_bytes, 4096);
        assert_eq!(total.frees_bytes, 2048);
        assert_eq!(paths[0].frees_alone_bytes, 2048);
    }

    #[test]
    fn nested_and_repeated_paths_are_measured_once() {
        let paths = ["/a/b", "/a", "/c", "/a", "/a/b/c", "/ab"].map(PathBuf::from);
        let (kept, nested) = outermost(&paths);
        assert_eq!(kept, ["/a", "/ab", "/c"].map(PathBuf::from));
        let pairs: Vec<_> = nested
            .iter()
            .map(|n| (n.path.as_str(), n.within.as_str()))
            .collect();
        assert_eq!(pairs, [("/a/b", "/a"), ("/a/b/c", "/a")]);
    }

    /// AGENTS.md scaling rule: N files over K paths, then 8N over 8K.
    #[test]
    fn tally_work_grows_linearly_with_files_and_paths() {
        fn steps(files: u64, paths: u32) -> u64 {
            work::take();
            let mut tally = Tally::new(paths as usize);
            for i in 0..files {
                let path = (i % u64::from(paths)) as u32;
                // Every file is a clone held in every path's group, plus
                // a hardlink pair per 10 files: the worst sharing.
                let attrs = clone(i % 16, paths);
                if i % 10 == 0 {
                    tally.add_file(path, 4096, 2, (1, i), attrs);
                    tally.add_file((path + 1) % paths, 4096, 2, (1, i), attrs);
                } else {
                    tally.add_file(path, 4096, 1, (1, i), attrs);
                }
            }
            let _ = tally.finish();
            work::take()
        }
        let small = steps(1_000, 8);
        let large = steps(8_000, 64);
        let growth = large as f64 / small as f64;
        eprintln!("measure tally: {small} -> {large} steps ({growth:.1}x)");
        assert!(growth <= 16.0, "tally grew {growth:.1}x from N to 8N");
        assert!(large <= 8_000 * 12, "tally took {large} steps at 8N");
    }

    #[test]
    fn measures_a_real_folder_and_a_listed_file() {
        let tree = crate::test_support::TempTree::new("measure");
        tree.write("keep/a.bin", 10_000);
        tree.write("gone/b.bin", 20_000);
        tree.write("gone/c.bin", 30_000);
        let file = tree.write("loose.bin", 5_000);
        let gone = tree.path("gone");
        let report = measure(
            &[
                gone.clone(),
                file.clone(),
                gone.join("c.bin"),
                tree.path("nope"),
            ],
            2,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(report.paths.len(), 2);
        let folder = report.paths.iter().find(|p| p.kind == "folder").unwrap();
        assert_eq!(folder.totals.files, 2);
        assert!(folder.totals.size_bytes >= 50_000);
        assert_eq!(folder.totals.frees_alone_bytes, folder.totals.size_bytes);
        let loose = report.paths.iter().find(|p| p.kind == "file").unwrap();
        assert_eq!(loose.totals.files, 1);
        assert!(loose.totals.size_bytes >= 5_000);
        assert_eq!(report.total.files, 3);
        assert_eq!(report.total.frees_bytes, report.total.size_bytes);
        assert_eq!(
            report.missing,
            [tree.path("nope").to_string_lossy().into_owned()]
        );
        assert_eq!(report.nested.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn measures_hardlinks_on_disk() {
        let tree = crate::test_support::TempTree::new("measure-links");
        let target = tree.write("a/data.bin", 64 * 1024);
        tree.link(&target, "b/data.bin");
        let a = tree.path("a");
        let b = tree.path("b");
        let alone = measure(std::slice::from_ref(&a), 2, &AtomicBool::new(false)).unwrap();
        assert_eq!(alone.total.frees_bytes, 0);
        assert!(alone.total.held_elsewhere_bytes >= 64 * 1024);
        let both = measure(&[a, b], 2, &AtomicBool::new(false)).unwrap();
        assert_eq!(both.total.files, 2);
        assert_eq!(both.total.size_bytes, alone.total.size_bytes);
        assert_eq!(both.total.frees_bytes, both.total.size_bytes);
    }

    /// `cp -c` makes real APFS clones; skipped off APFS.
    #[cfg(target_os = "macos")]
    #[test]
    fn measures_apfs_clones_on_disk() {
        let tree = crate::test_support::TempTree::new("measure-clones");
        if !crate::clone_attrs::enable_for_root(&tree.path("")) {
            eprintln!("not APFS, skipping");
            return;
        }
        let source = tree.write("a/data.bin", 256 * 1024);
        std::fs::create_dir_all(tree.path("b")).unwrap();
        let status = std::process::Command::new("cp")
            .arg("-c")
            .arg(&source)
            .arg(tree.path("b/data.bin"))
            .status()
            .unwrap();
        assert!(status.success());
        let a = tree.path("a");
        let b = tree.path("b");
        let alone = measure(std::slice::from_ref(&a), 2, &AtomicBool::new(false)).unwrap();
        assert!(alone.clone_metadata);
        assert_eq!(alone.total.frees_bytes, 0, "{alone:?}");
        assert!(alone.total.held_elsewhere_bytes >= 256 * 1024);
        let both = measure(&[a, b], 2, &AtomicBool::new(false)).unwrap();
        assert_eq!(both.total.size_bytes, 2 * alone.total.size_bytes);
        assert_eq!(both.total.frees_bytes, alone.total.size_bytes, "{both:?}");
        for path in &both.paths {
            assert_eq!(path.totals.frees_alone_bytes, 0);
            assert_eq!(path.totals.shared_bytes, alone.total.size_bytes);
        }
    }
}
