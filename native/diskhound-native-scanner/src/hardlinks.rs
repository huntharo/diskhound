//! Unix hardlink dedupe for the jwalk walker.
//!
//! A regular file with `st_nlink > 1` is one inode reached through several
//! names. A scan counts its bytes once: the first link the walk reaches
//! owns them, and every later link is indexed with `h:1` (the flag the
//! Windows MFT path already writes), so it adds 0 to directory and total
//! sizes. This matches `du`, which also counts each inode once.
//!
//! "First" has to be the same from one scan to the next, or the full diff
//! would show the bytes moving between links. The walker therefore visits
//! entries in a fixed order (`walk_order`): depth-first, and inside each
//! directory files before subdirectories, each group sorted by name bytes.
//! The JS fallback worker (`src/scan/scanWorker.ts`) walks in the same
//! order, so both engines pick the same owner.
//!
//! Only multi-link inodes are tracked, and an inode is dropped once all of
//! its links have been seen. Memory is bounded by the hardlinked inodes
//! whose other names are still ahead of the walk or outside the scan root.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::ffi::OsStr;

#[derive(Default)]
pub struct HardlinkTracker {
    /// `(st_dev, st_ino)` → links not seen yet.
    pending: HashMap<(u64, u64), u64>,
    extra_links: u64,
}

impl HardlinkTracker {
    /// True when this name is an extra link to an inode the scan has
    /// already counted.
    pub fn is_extra_link(&mut self, dev: u64, ino: u64, nlink: u64) -> bool {
        if nlink <= 1 {
            return false;
        }
        match self.pending.entry((dev, ino)) {
            Entry::Vacant(slot) => {
                slot.insert(nlink - 1);
                false
            }
            Entry::Occupied(mut slot) => {
                self.extra_links += 1;
                let remaining = slot.get_mut();
                *remaining = remaining.saturating_sub(1);
                if *remaining == 0 {
                    slot.remove();
                }
                true
            }
        }
    }

    pub fn extra_links(&self) -> u64 {
        self.extra_links
    }

    /// Hardlinked inodes with names the walk never reached, usually
    /// because those names live outside the scan root.
    pub fn inodes_with_unseen_links(&self) -> usize {
        self.pending.len()
    }
}

/// Order of entries inside one directory: files first, then
/// subdirectories, each by name bytes.
pub fn walk_order(a_is_dir: bool, a_name: &OsStr, b_is_dir: bool, b_name: &OsStr) -> Ordering {
    a_is_dir.cmp(&b_is_dir).then_with(|| a_name.cmp(b_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_link_files_are_never_extra() {
        let mut tracker = HardlinkTracker::default();
        assert!(!tracker.is_extra_link(1, 10, 1));
        assert!(!tracker.is_extra_link(1, 10, 1));
        assert_eq!(tracker.inodes_with_unseen_links(), 0);
    }

    #[test]
    fn first_link_owns_and_later_links_are_extra() {
        let mut tracker = HardlinkTracker::default();
        assert!(!tracker.is_extra_link(1, 10, 3));
        assert!(tracker.is_extra_link(1, 10, 3));
        assert!(tracker.is_extra_link(1, 10, 3));
        assert_eq!(tracker.extra_links(), 2);
    }

    #[test]
    fn inode_is_forgotten_once_every_link_is_seen() {
        let mut tracker = HardlinkTracker::default();
        tracker.is_extra_link(1, 10, 2);
        assert_eq!(tracker.inodes_with_unseen_links(), 1);
        tracker.is_extra_link(1, 10, 2);
        assert_eq!(tracker.inodes_with_unseen_links(), 0);
    }

    #[test]
    fn links_outside_the_scan_stay_pending() {
        let mut tracker = HardlinkTracker::default();
        tracker.is_extra_link(1, 10, 5);
        tracker.is_extra_link(1, 10, 5);
        assert_eq!(tracker.inodes_with_unseen_links(), 1);
    }

    #[test]
    fn same_inode_number_on_another_device_is_a_different_file() {
        let mut tracker = HardlinkTracker::default();
        assert!(!tracker.is_extra_link(1, 10, 2));
        assert!(!tracker.is_extra_link(2, 10, 2));
    }

    #[test]
    fn walk_order_puts_files_before_directories_then_sorts_by_name() {
        let mut entries = vec![
            (true, OsStr::new("b")),
            (false, OsStr::new("z.txt")),
            (true, OsStr::new("a")),
            (false, OsStr::new("B.txt")),
            (false, OsStr::new("a.txt")),
        ];
        entries.sort_by(|a, b| walk_order(a.0, a.1, b.0, b.1));
        let names: Vec<_> = entries.iter().map(|e| e.1.to_str().unwrap()).collect();
        assert_eq!(names, ["B.txt", "a.txt", "z.txt", "a", "b"]);
    }
}
