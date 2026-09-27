//! APFS clone / private-size accounting for the macOS walker.
//!
//! `st_blocks` reports every block a file references, so a pnpm store
//! cloned into twenty projects' node_modules shows up twenty-one times
//! in `bytes_seen`, and deleting any one copy frees ~nothing. macOS 12+
//! exposes the missing facts per file through `getattrlist` extended
//! common attributes (FSOPT_ATTR_CMN_EXTENDED):
//!
//!   ATTR_CMNEXT_PRIVATESIZE   bytes freed immediately if this file were
//!                             deleted — excludes blocks shared with a
//!                             clone AND blocks a snapshot references
//!   ATTR_CMNEXT_CLONEID       shared by every full clone of one data
//!                             stream (a modified clone gets a new id)
//!   ATTR_CMNEXT_CLONE_REFCNT  size of that full-clone group, self included
//!   ATTR_CMNEXT_EXT_FLAGS     EF_MAY_SHARE_BLOCKS / EF_SHARES_ALL_BLOCKS
//!
//! Verified with `cp -c` on macOS 26: original + 2 clones → all three
//! report the same clone id, refcnt 3, private 0; writing one byte into
//! a clone gives it a fresh id, refcnt 1, private 16 KB (the rewritten
//! extent) while the other two drop to refcnt 2.
//!
//! How the walker gets them: dua-core already reads every folder with
//! `getattrlistbulk`, and with `apfs_clone_metadata` that read also
//! returns CLONEID for files flagged EF_MAY_SHARE_BLOCKS. Only those
//! files take one more `getattrlist`, for PRIVATESIZE and CLONE_REFCNT,
//! so no folder is read twice. (Reading each folder a second time for
//! these attributes cost about +5 s user and +5.5 s system on a 623k-file
//! walk.) PRIVATESIZE is the dear one: APFS walks each file's extents to
//! compute it, ~10 µs per large file, and asking for it on every file
//! made the walk 20–25 % slower. Clones are the files where it differs
//! from what `st_blocks` already says, snapshots aside. Snapshot-held
//! space is reported per volume instead
//! (src/shared/macStorageAccounting.ts).
//!
//! DISKHOUND_NO_CLONE_ATTRS=1 turns the whole pass off.

use std::collections::HashMap;

pub const EF_MAY_SHARE_BLOCKS: u64 = 0x0000_0001;
pub const EF_SHARES_ALL_BLOCKS: u64 = 0x0000_0040;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CloneAttrs {
    /// ATTR_CMNEXT_PRIVATESIZE — only fetched for clone files; None
    /// otherwise or when the per-file call failed.
    pub private_size: Option<u64>,
    /// 0 when the kernel did not return ATTR_CMNEXT_CLONEID.
    pub clone_id: u64,
    /// 0 when the kernel did not return ATTR_CMNEXT_CLONE_REFCNT.
    pub clone_refcnt: u32,
    pub ext_flags: u64,
}

impl CloneAttrs {
    /// Some or all blocks are shared with another file.
    pub fn may_share(&self) -> bool {
        self.ext_flags & (EF_MAY_SHARE_BLOCKS | EF_SHARES_ALL_BLOCKS) != 0
    }

    /// `(clone_id, refcnt)` when this file is one of ≥2 full clones.
    pub fn full_clone_group(&self) -> Option<(u64, u32)> {
        (self.clone_id != 0 && self.clone_refcnt >= 2).then_some((self.clone_id, self.clone_refcnt))
    }

    /// Private bytes of a clone, clamped to its allocated size. An
    /// unmeasured clone counts as 0 so "frees" estimates stay low.
    pub fn clone_private_of(&self, allocated: u64) -> u64 {
        self.private_size.unwrap_or(0).min(allocated)
    }
}

// ── Scan-wide totals (main thread, every recorded file) ─────

#[derive(Clone, Copy, Debug, Default)]
pub struct CloneTotals {
    pub measured_files: u64,
    pub measured_bytes: u64,
    pub clone_files: u64,
    pub clone_bytes: u64,
    /// Σ private size of clone files (partially rewritten clones).
    pub clone_private_bytes: u64,
}

impl CloneTotals {
    pub fn add(&mut self, allocated: u64, attrs: &CloneAttrs) {
        self.measured_files += 1;
        self.measured_bytes = self.measured_bytes.saturating_add(allocated);
        if attrs.may_share() {
            self.clone_files += 1;
            self.clone_bytes = self.clone_bytes.saturating_add(allocated);
            self.clone_private_bytes = self
                .clone_private_bytes
                .saturating_add(attrs.clone_private_of(allocated));
        }
    }
}

// ── Clone groups (index-writer thread) ──────────────────────

/// Group member outside every Dev Artifacts root.
pub const OUTSIDE_ROOTS: u32 = u32::MAX - 1;
const EMPTY_SLOT: u32 = u32::MAX;
const ROOT_SLOTS: usize = 3;
/// ~48 B per group incl. hash overhead → ~48 MB worst case. Past this,
/// new groups are not tracked and results are flagged approximate.
pub const MAX_CLONE_GROUPS: usize = 1_000_000;
const MAX_ROOT_EDGES: usize = 250_000;

#[derive(Clone, Copy)]
struct GroupRec {
    /// Allocated size of one member. Full clones share every block, so
    /// all members report the same size.
    alloc: u64,
    refcnt: u32,
    seen: u32,
    /// Distinct Dev roots (or OUTSIDE_ROOTS) holding members.
    roots: [u32; ROOT_SLOTS],
    overflow: bool,
}

/// Full-clone groups seen during one scan, keyed by clone id.
pub struct CloneGroups {
    groups: HashMap<u64, GroupRec>,
    truncated: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CloneGroupSummary {
    /// Bytes `bytes_seen` counts more than once: (seen − 1) × size per group.
    pub duplicate_bytes: u64,
    pub groups: u64,
    pub truncated: bool,
}

/// Per-Dev-root results of `CloneGroups::attribute`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RootCloneShare {
    /// Blocks of groups living entirely in this root (counted once).
    pub internal_bytes: u64,
    /// Allocated bytes of this root's files in those groups.
    pub internal_file_bytes: u64,
    /// Other roots sharing at least one group, with shared bytes.
    pub neighbors: Vec<(u32, u64)>,
}

impl Default for CloneGroups {
    fn default() -> Self {
        Self::new()
    }
}

impl CloneGroups {
    pub fn new() -> Self {
        Self {
            groups: HashMap::new(),
            truncated: false,
        }
    }

    /// Record one file. `root` is its Dev root id or OUTSIDE_ROOTS.
    pub fn add(&mut self, attrs: &CloneAttrs, allocated: u64, root: u32) {
        crate::work::step();
        let Some((clone_id, refcnt)) = attrs.full_clone_group() else {
            return;
        };
        let rec = match self.groups.get_mut(&clone_id) {
            Some(rec) => rec,
            None => {
                if self.groups.len() >= MAX_CLONE_GROUPS {
                    self.truncated = true;
                    return;
                }
                self.groups.entry(clone_id).or_insert(GroupRec {
                    alloc: allocated,
                    refcnt,
                    seen: 0,
                    roots: [EMPTY_SLOT; ROOT_SLOTS],
                    overflow: false,
                })
            }
        };
        rec.seen = rec.seen.saturating_add(1);
        // A later member can report a higher refcnt if a clone was made
        // mid-scan; keep the largest so "complete" stays conservative.
        rec.refcnt = rec.refcnt.max(refcnt);
        if rec.roots.contains(&root) {
            return;
        }
        match rec.roots.iter_mut().find(|slot| **slot == EMPTY_SLOT) {
            Some(slot) => *slot = root,
            None => rec.overflow = true,
        }
    }

    pub fn summary(&self) -> CloneGroupSummary {
        let mut duplicate_bytes = 0u64;
        for rec in self.groups.values() {
            duplicate_bytes =
                duplicate_bytes.saturating_add(rec.alloc.saturating_mul(u64::from(rec.seen.saturating_sub(1))));
        }
        CloneGroupSummary {
            duplicate_bytes,
            groups: self.groups.len() as u64,
            truncated: self.truncated,
        }
    }

    /// Split clone groups across Dev roots.
    ///
    /// A group is *internal* to root R when every member the kernel
    /// counts (refcnt) was seen, all inside R — deleting R frees it.
    /// Groups that touch several roots link those roots as neighbours
    /// ("space is shared with N other trees"). With three root slots per
    /// group a clone spread over many projects links each project to the
    /// first few seen; across thousands of groups every sharer still
    /// shows up, so the neighbour count is a close lower bound.
    pub fn attribute(&self, root_count: usize) -> Vec<RootCloneShare> {
        let mut out = vec![RootCloneShare::default(); root_count];
        let mut edges: HashMap<(u32, u32), u64> = HashMap::new();
        for rec in self.groups.values() {
            crate::work::step();
            let dev_roots: Vec<u32> = rec
                .roots
                .iter()
                .copied()
                .filter(|r| *r != EMPTY_SLOT && *r != OUTSIDE_ROOTS && (*r as usize) < root_count)
                .collect();
            let only_dev_root = dev_roots.len() == 1
                && !rec.overflow
                && !rec.roots.contains(&OUTSIDE_ROOTS);
            if only_dev_root && rec.seen >= rec.refcnt {
                let share = &mut out[dev_roots[0] as usize];
                share.internal_bytes = share.internal_bytes.saturating_add(rec.alloc);
                share.internal_file_bytes = share
                    .internal_file_bytes
                    .saturating_add(rec.alloc.saturating_mul(u64::from(rec.seen)));
                continue;
            }
            for (i, a) in dev_roots.iter().enumerate() {
                for b in &dev_roots[i + 1..] {
                    crate::work::step();
                    let key = if a < b { (*a, *b) } else { (*b, *a) };
                    if let Some(bytes) = edges.get_mut(&key) {
                        *bytes = bytes.saturating_add(rec.alloc);
                    } else if edges.len() < MAX_ROOT_EDGES {
                        edges.insert(key, rec.alloc);
                    }
                }
            }
        }
        for ((a, b), bytes) in edges {
            out[a as usize].neighbors.push((b, bytes));
            out[b as usize].neighbors.push((a, bytes));
        }
        for share in &mut out {
            share.neighbors.sort_by(|x, y| {
                crate::work::step();
                y.1.cmp(&x.1).then(x.0.cmp(&y.0))
            });
        }
        out
    }
}

// ── Reader (macOS) ──────────────────────────────────────────

#[cfg(target_os = "macos")]
mod reader {
    use super::{CloneAttrs, EF_MAY_SHARE_BLOCKS};
    use std::num::NonZeroU64;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::atomic::{AtomicU32, Ordering};

    // <sys/attr.h>. ABI-stable; declared here because libc 0.2.185 lacks
    // ATTR_CMNEXT_CLONE_REFCNT.
    const ATTR_BIT_MAP_COUNT: u16 = 5;
    const ATTR_CMN_RETURNED_ATTRS: u32 = 0x8000_0000;
    const ATTR_CMNEXT_PRIVATESIZE: u32 = 0x0000_0008;
    const ATTR_CMNEXT_CLONE_REFCNT: u32 = 0x0000_1000;
    const FSOPT_NOFOLLOW: u64 = 0x0000_0001;
    const FSOPT_PACK_INVAL_ATTRS: u64 = 0x0000_0008;
    const FSOPT_ATTR_CMN_EXTENDED: u64 = 0x0000_0020;

    const FULL_MASK: u32 = ATTR_CMNEXT_PRIVATESIZE | ATTR_CMNEXT_CLONE_REFCNT;
    /// Current per-file fork-attr mask. A kernel that rejects an
    /// attribute with EINVAL steps it down once: CLONE_REFCNT goes first
    /// (the private size alone still says what a clone frees), then 0.
    static FORK_MASK: AtomicU32 = AtomicU32::new(FULL_MASK);

    #[repr(C)]
    struct AttrList {
        bitmapcount: u16,
        reserved: u16,
        commonattr: u32,
        volattr: u32,
        dirattr: u32,
        fileattr: u32,
        forkattr: u32,
    }

    /// Decide once per scan whether to read clone attributes: on unless
    /// DISKHOUND_NO_CLONE_ATTRS=1, and only on an APFS root.
    pub fn enable_for_root(root: &Path) -> bool {
        std::env::var("DISKHOUND_NO_CLONE_ATTRS").as_deref() != Ok("1") && is_apfs(root)
    }

    fn is_apfs(path: &Path) -> bool {
        let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        let mut st: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statfs(c_path.as_ptr(), &mut st) } != 0 {
            return false;
        }
        let name: Vec<u8> = st
            .f_fstypename
            .iter()
            .take_while(|c| **c != 0)
            .map(|c| *c as u8)
            .collect();
        name == b"apfs"
    }

    /// Clone attributes of one regular file, given the clone id the
    /// walker's bulk folder read returned (Some only for files that may
    /// share blocks). Other files cost nothing and report no sharing.
    pub fn file_clone_attrs(path: &Path, clone_id: Option<NonZeroU64>) -> CloneAttrs {
        let Some(clone_id) = clone_id else {
            return CloneAttrs::default();
        };
        let (private_size, clone_refcnt) = private_size_and_refcnt(path);
        CloneAttrs {
            private_size,
            clone_id: clone_id.get(),
            clone_refcnt,
            ext_flags: EF_MAY_SHARE_BLOCKS,
        }
    }

    fn private_size_and_refcnt(path: &Path) -> (Option<u64>, u32) {
        let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
            return (None, 0);
        };
        loop {
            let mask = FORK_MASK.load(Ordering::Relaxed);
            if mask == 0 {
                return (None, 0);
            }
            let mut attrs = AttrList {
                bitmapcount: ATTR_BIT_MAP_COUNT,
                reserved: 0,
                commonattr: ATTR_CMN_RETURNED_ATTRS,
                volattr: 0,
                dirattr: 0,
                fileattr: 0,
                forkattr: mask,
            };
            // With FSOPT_PACK_INVAL_ATTRS every requested attribute keeps
            // its slot, in bit order: u32 length | attribute_set_t
            // returned (20) | off_t private size | u32 clone refcnt.
            let mut buf = [0u8; 40];
            let rc = unsafe {
                libc::getattrlist(
                    c_path.as_ptr(),
                    &mut attrs as *mut AttrList as *mut libc::c_void,
                    buf.as_mut_ptr() as *mut libc::c_void,
                    buf.len(),
                    (FSOPT_NOFOLLOW | FSOPT_ATTR_CMN_EXTENDED | FSOPT_PACK_INVAL_ATTRS) as libc::c_uint,
                )
            };
            if rc != 0 {
                if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL) {
                    let next = if mask == FULL_MASK { ATTR_CMNEXT_PRIVATESIZE } else { 0 };
                    if FORK_MASK.compare_exchange(mask, next, Ordering::Relaxed, Ordering::Relaxed).is_ok() {
                        eprintln!(
                            "[diskhound-native-scanner] clone attrs: kernel rejected mask {mask:#x}, falling back to {next:#x}"
                        );
                    }
                    continue;
                }
                return (None, 0);
            }
            let returned = read_u32(&buf, 4 + 16).unwrap_or(0);
            let private = (returned & ATTR_CMNEXT_PRIVATESIZE != 0).then(|| read_u64(&buf, 24)).flatten();
            let refcnt = if mask & ATTR_CMNEXT_CLONE_REFCNT != 0 && returned & ATTR_CMNEXT_CLONE_REFCNT != 0 {
                read_u32(&buf, 32).unwrap_or(0)
            } else {
                0
            };
            return (private, refcnt);
        }
    }

    fn read_u32(buf: &[u8], at: usize) -> Option<u32> {
        buf.get(at..at + 4).map(|b| u32::from_ne_bytes(b.try_into().unwrap()))
    }

    fn read_u64(buf: &[u8], at: usize) -> Option<u64> {
        buf.get(at..at + 8).map(|b| u64::from_ne_bytes(b.try_into().unwrap()))
    }
}

#[cfg(target_os = "macos")]
pub use reader::{enable_for_root, file_clone_attrs};

#[cfg(test)]
mod tests {
    use super::*;

    fn clone_file(id: u64, refcnt: u32) -> CloneAttrs {
        CloneAttrs {
            private_size: Some(0),
            clone_id: id,
            clone_refcnt: refcnt,
            ext_flags: EF_MAY_SHARE_BLOCKS | EF_SHARES_ALL_BLOCKS,
        }
    }

    /// AGENTS.md scaling rule: count `work::step()`s at N and 8N, with the
    /// Dev root count growing 8× too, and allow 16× for log factors.
    #[test]
    fn clone_groups_scale_linearly() {
        fn assert_scales(label: &str, small: u64, large: u64, cap: u64) {
            let growth = large as f64 / small as f64;
            eprintln!("{label}: {small} -> {large} steps ({growth:.1}x), cap {cap}");
            assert!(growth <= 16.0, "{label} grew {growth:.1}x from N to 8N");
            assert!(large <= cap, "{label} took {large} steps at 8N, over {cap}");
        }
        // Five-way clones spread over consecutive roots, so every group
        // fills its root slots and links roots pairwise.
        let groups = |files: usize, roots: u32| {
            crate::work::take();
            let mut g = CloneGroups::new();
            for i in 0..files {
                g.add(&clone_file((i / 5) as u64 + 1, 5), 4096, i as u32 % roots);
            }
            assert_eq!(g.attribute(roots as usize).len(), roots as usize);
            crate::work::take()
        };
        let (n, k) = (4_000, 50);
        assert_scales("clone groups", groups(n, k), groups(8 * n, 8 * k), 20 * 8 * n as u64);
    }

    #[test]
    fn totals_count_clone_bytes_and_their_private_part() {
        let mut t = CloneTotals::default();
        // Ordinary file: measured, not a clone.
        t.add(4096, &CloneAttrs::default());
        // Full clone.
        t.add(16384, &clone_file(7, 2));
        // Partially rewritten clone: 8 KB of its own blocks.
        t.add(
            32768,
            &CloneAttrs {
                private_size: Some(8192),
                clone_id: 99,
                clone_refcnt: 1,
                ext_flags: EF_MAY_SHARE_BLOCKS,
            },
        );
        assert_eq!(t.measured_files, 3);
        assert_eq!(t.measured_bytes, 53248);
        assert_eq!(t.clone_files, 2);
        assert_eq!(t.clone_bytes, 49152);
        assert_eq!(t.clone_private_bytes, 8192);
    }

    #[test]
    fn clone_private_is_clamped_and_defaults_to_zero() {
        let attrs = CloneAttrs { private_size: Some(10_000), ..Default::default() };
        assert_eq!(attrs.clone_private_of(4096), 4096);
        assert_eq!(CloneAttrs::default().clone_private_of(4096), 0);
    }

    #[test]
    fn duplicate_bytes_count_extra_members_once_per_group() {
        let mut g = CloneGroups::new();
        for _ in 0..3 {
            g.add(&clone_file(1, 3), 1000, OUTSIDE_ROOTS);
        }
        g.add(&clone_file(2, 2), 50, OUTSIDE_ROOTS);
        // Not a full clone (refcnt 1) → ignored.
        g.add(&clone_file(3, 1), 999, OUTSIDE_ROOTS);
        let s = g.summary();
        assert_eq!(s.duplicate_bytes, 2000);
        assert_eq!(s.groups, 2);
        assert!(!s.truncated);
    }

    #[test]
    fn complete_group_inside_one_root_is_internal() {
        let mut g = CloneGroups::new();
        g.add(&clone_file(1, 2), 4096, 0);
        g.add(&clone_file(1, 2), 4096, 0);
        let shares = g.attribute(2);
        assert_eq!(shares[0].internal_bytes, 4096);
        assert_eq!(shares[0].internal_file_bytes, 8192);
        assert!(shares[0].neighbors.is_empty());
    }

    #[test]
    fn group_with_unseen_members_is_not_internal() {
        let mut g = CloneGroups::new();
        // refcnt 3 but only 2 members inside the scan.
        g.add(&clone_file(1, 3), 4096, 0);
        g.add(&clone_file(1, 3), 4096, 0);
        let shares = g.attribute(1);
        assert_eq!(shares[0].internal_bytes, 0);
    }

    #[test]
    fn shared_groups_link_roots_as_neighbors() {
        let mut g = CloneGroups::new();
        // pnpm store (root 0) cloned into two projects (roots 1, 2).
        for id in 1..=4u64 {
            g.add(&clone_file(id, 3), 1000, 0);
            g.add(&clone_file(id, 3), 1000, 1);
            g.add(&clone_file(id, 3), 1000, 2);
        }
        // One more group only between store and project 1, and one that
        // also has a member outside every Dev root.
        g.add(&clone_file(9, 2), 500, 0);
        g.add(&clone_file(9, 2), 500, 1);
        g.add(&clone_file(10, 2), 70, 1);
        g.add(&clone_file(10, 2), 70, OUTSIDE_ROOTS);
        let shares = g.attribute(3);
        assert_eq!(shares[0].neighbors, vec![(1, 4500), (2, 4000)]);
        assert_eq!(shares[2].neighbors, vec![(0, 4000), (1, 4000)]);
        assert!(shares.iter().all(|s| s.internal_bytes == 0));
    }

    #[test]
    fn cap_marks_truncated() {
        let mut g = CloneGroups::new();
        for id in 0..(MAX_CLONE_GROUPS as u64 + 5) {
            g.add(&clone_file(id + 1, 2), 1, OUTSIDE_ROOTS);
        }
        assert_eq!(g.groups.len(), MAX_CLONE_GROUPS);
        assert!(g.summary().truncated);
    }

    /// End-to-end against the real kernel: clonefile(2) a file in a temp
    /// dir, walk it with dua-core as the scanner does, and read the rest.
    #[cfg(target_os = "macos")]
    #[test]
    fn reads_clone_attrs_from_apfs() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("dh-clone-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        if !enable_for_root(&dir) {
            eprintln!("temp dir is not APFS; skipping");
            return;
        }
        let orig = dir.join("orig.bin");
        let mut f = std::fs::File::create(&orig).unwrap();
        f.write_all(&vec![7u8; 256 * 1024]).unwrap();
        f.sync_all().unwrap();
        drop(f);
        let clone = dir.join("clone.bin");
        let src = std::ffi::CString::new(orig.to_str().unwrap()).unwrap();
        let dst = std::ffi::CString::new(clone.to_str().unwrap()).unwrap();
        unsafe extern "C" {
            fn clonefile(src: *const libc::c_char, dst: *const libc::c_char, flags: u32) -> libc::c_int;
        }
        assert_eq!(unsafe { clonefile(src.as_ptr(), dst.as_ptr(), 0) }, 0);
        std::fs::write(dir.join("plain.bin"), vec![1u8; 64 * 1024]).unwrap();

        let options = dua_core::Options { apfs_clone_metadata: true, ..dua_core::Options::default() };
        let mut attrs = HashMap::new();
        for entry in dua_core::walk(&dir, 1, dua_core::Order::Completion, options, |_| true) {
            let entry = entry.unwrap();
            if !entry.file_type.is_file() {
                continue;
            }
            let clone_id = entry.metadata.as_ref().unwrap().as_ref().unwrap().clone_id();
            let name = entry.file_name.to_string_lossy().into_owned();
            attrs.insert(name, file_clone_attrs(&entry.path(), clone_id));
        }
        let (a, b, plain) = (attrs["orig.bin"], attrs["clone.bin"], attrs["plain.bin"]);
        assert!(a.may_share() && b.may_share());
        assert!(!plain.may_share());
        assert_eq!(a.private_size, Some(0));
        assert_eq!(b.private_size, Some(0));
        assert_eq!(a.clone_id, b.clone_id);
        assert_eq!(a.full_clone_group().map(|g| g.1), Some(2));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
