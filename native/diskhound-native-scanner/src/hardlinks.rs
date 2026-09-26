//! Unix hardlink dedupe for the dua-core walker.
//!
//! A regular file with `st_nlink > 1` is one inode reached through several
//! names. A scan counts its bytes once: the first link in walk order owns
//! them, and every other link is indexed with `h:1` (the flag the Windows
//! MFT path already writes), so it adds 0 to directory and total sizes.
//! This matches `du`, which also counts each inode once.
//!
//! "First" has to be the same from one scan to the next, or the full diff
//! would show the bytes moving between links. Walk order (`walk_order`) is
//! depth-first, and inside each directory files before subdirectories,
//! each group sorted by name bytes. The JS fallback worker
//! (`src/scan/scanWorker.ts`) walks in that order, so both engines pick
//! the same owner.
//!
//! The native walker reads folders in parallel and yields entries in the
//! order the reads finish, which changes from scan to scan. So the tracker
//! holds each name of a multi-link inode until it has seen all of them, or
//! the walk ends, and then ranks them by walk order (`walk_order_of_paths`).
//!
//! Only multi-link names are held, and an inode is released once all of
//! its links have been seen. Memory is bounded by the hardlinked names
//! whose other names are still ahead of the walk or outside the scan root.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::work;

/// One name of a hardlinked file, held until the tracker knows which name
/// owns the inode's bytes. The path keeps its raw bytes, so names that are
/// not UTF-8 still rank as the walk would have visited them.
pub struct Link {
    pub path: PathBuf,
    pub size: u64,
    pub modified_at: u64,
}

/// The names of one inode seen so far.
struct PendingInode {
    /// Names not seen yet.
    unseen: u64,
    links: Vec<Link>,
}

#[derive(Default)]
pub struct HardlinkTracker {
    /// `(st_dev, st_ino)` → names seen so far.
    pending: HashMap<(u64, u64), PendingInode>,
    held: usize,
    peak_held: usize,
    extra_links: u64,
    extra_link_bytes: u64,
    unseen_at_finish: usize,
}

impl HardlinkTracker {
    /// Takes one name of an inode with `nlink > 1` names. Once the last
    /// name arrives, passes every name to `release` in walk order, with
    /// `true` for each extra link and `false` for the owner.
    pub fn add(
        &mut self,
        dev: u64,
        ino: u64,
        nlink: u64,
        link: Link,
        release: impl FnMut(Link, bool),
    ) {
        let inode = self.pending.entry((dev, ino)).or_insert_with(|| PendingInode {
            unseen: nlink,
            links: Vec::new(),
        });
        inode.unseen = inode.unseen.saturating_sub(1);
        inode.links.push(link);
        self.held += 1;
        self.peak_held = self.peak_held.max(self.held);
        if inode.unseen == 0 {
            if let Some(inode) = self.pending.remove(&(dev, ino)) {
                self.release(inode, release);
            }
        }
    }

    /// Releases the inodes with names the walk never reached, usually
    /// because those names live outside the scan root. Call once, after
    /// the walk.
    pub fn finish(&mut self, mut release: impl FnMut(Link, bool)) {
        self.unseen_at_finish = self.pending.len();
        let pending = std::mem::take(&mut self.pending);
        for (_, inode) in pending {
            self.release(inode, &mut release);
        }
    }

    fn release(&mut self, inode: PendingInode, mut release: impl FnMut(Link, bool)) {
        let mut links = inode.links;
        links.sort_by(|a, b| {
            work::step();
            walk_order_of_paths(&a.path, &b.path)
        });
        self.held -= links.len();
        for (index, link) in links.into_iter().enumerate() {
            work::step();
            let extra = index > 0;
            if extra {
                self.extra_links += 1;
                self.extra_link_bytes = self.extra_link_bytes.saturating_add(link.size);
            }
            release(link, extra);
        }
    }

    pub fn extra_links(&self) -> u64 {
        self.extra_links
    }

    /// Bytes of the extra links, which the scan counts at 0.
    pub fn extra_link_bytes(&self) -> u64 {
        self.extra_link_bytes
    }

    /// The most names held at once during the walk.
    pub fn peak_held(&self) -> usize {
        self.peak_held
    }

    /// Hardlinked inodes with names the walk never reached, usually
    /// because those names live outside the scan root.
    pub fn inodes_with_unseen_links(&self) -> usize {
        self.unseen_at_finish
    }
}

/// Order of entries inside one directory: files first, then
/// subdirectories, each by name bytes.
pub fn walk_order(a_is_dir: bool, a_name: &OsStr, b_is_dir: bool, b_name: &OsStr) -> Ordering {
    a_is_dir.cmp(&b_is_dir).then_with(|| a_name.cmp(b_name))
}

/// Which of two files a depth-first walk in `walk_order` reaches first.
/// Below the folder they share, each path's next name is a file if it is
/// the path's last name and a subdirectory otherwise.
pub fn walk_order_of_paths(a: &Path, b: &Path) -> Ordering {
    let mut a_names = a.components().peekable();
    let mut b_names = b.components().peekable();
    loop {
        match (a_names.next(), b_names.next()) {
            (Some(a_name), Some(b_name)) if a_name == b_name => continue,
            (Some(a_name), Some(b_name)) => {
                return walk_order(
                    a_names.peek().is_some(),
                    a_name.as_os_str(),
                    b_names.peek().is_some(),
                    b_name.as_os_str(),
                );
            }
            (a_name, b_name) => return a_name.is_some().cmp(&b_name.is_some()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(path: &str) -> Link {
        Link {
            path: path.into(),
            size: 4096,
            modified_at: 0,
        }
    }

    fn text(link: Link) -> String {
        link.path.to_string_lossy().into_owned()
    }

    /// Adds `(dev, ino, nlink, path)` names in order; returns what was
    /// released, as `(path, extra)`.
    fn add_all(tracker: &mut HardlinkTracker, names: &[(u64, u64, u64, &str)]) -> Vec<(String, bool)> {
        let mut released = Vec::new();
        for &(dev, ino, nlink, path) in names {
            tracker.add(dev, ino, nlink, link(path), |link, extra| {
                released.push((text(link), extra))
            });
        }
        released
    }

    #[test]
    fn owner_is_the_first_name_in_walk_order_whatever_the_arrival_order() {
        let names = ["/r/zzz.bin", "/r/aaa/original.bin", "/r/bbb/copy.bin"];
        let orders = [[0, 1, 2], [2, 1, 0], [1, 2, 0], [1, 0, 2]];
        for order in orders {
            let mut tracker = HardlinkTracker::default();
            let arrivals: Vec<_> = order.iter().map(|&i| (1, 10, 3, names[i])).collect();
            let released = add_all(&mut tracker, &arrivals);
            assert_eq!(
                released,
                vec![
                    ("/r/zzz.bin".to_string(), false),
                    ("/r/aaa/original.bin".to_string(), true),
                    ("/r/bbb/copy.bin".to_string(), true),
                ],
                "arrival order {order:?}"
            );
            assert_eq!(tracker.extra_links(), 2);
            assert_eq!(tracker.extra_link_bytes(), 2 * 4096);
        }
    }

    #[test]
    fn names_are_held_until_the_last_one_arrives() {
        let mut tracker = HardlinkTracker::default();
        assert!(add_all(&mut tracker, &[(1, 10, 2, "/r/b")]).is_empty());
        assert!(add_all(&mut tracker, &[(1, 11, 2, "/r/c")]).is_empty());
        assert_eq!(add_all(&mut tracker, &[(1, 10, 2, "/r/a")]).len(), 2);
        assert_eq!(tracker.peak_held(), 3);
        let mut rest = Vec::new();
        tracker.finish(|link, extra| rest.push((text(link), extra)));
        assert_eq!(rest, vec![("/r/c".to_string(), false)]);
        assert_eq!(tracker.inodes_with_unseen_links(), 1);
    }

    #[test]
    fn links_outside_the_scan_are_released_at_finish_with_an_owner() {
        let mut tracker = HardlinkTracker::default();
        assert!(add_all(&mut tracker, &[(1, 10, 5, "/r/y"), (1, 10, 5, "/r/x")]).is_empty());
        let mut rest = Vec::new();
        tracker.finish(|link, extra| rest.push((text(link), extra)));
        assert_eq!(rest, vec![("/r/x".to_string(), false), ("/r/y".to_string(), true)]);
        assert_eq!(tracker.extra_links(), 1);
    }

    #[test]
    fn same_inode_number_on_another_device_is_a_different_file() {
        let mut tracker = HardlinkTracker::default();
        let released = add_all(&mut tracker, &[(1, 10, 2, "/r/a"), (2, 10, 2, "/r/b")]);
        assert!(released.is_empty());
        let mut rest = Vec::new();
        tracker.finish(|link, extra| rest.push((text(link), extra)));
        assert!(rest.iter().all(|(_, extra)| !extra), "each device's inode has its own owner");
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

    #[test]
    fn walk_order_of_paths_matches_a_depth_first_walk() {
        // The order a depth-first walk in `walk_order` visits these files.
        let walked = [
            "/r/B.txt",
            "/r/z.txt",
            "/r/a/z.txt",
            "/r/a/a/deep.txt",
            "/r/a/b/x.txt",
            "/r/a b/x.txt",
            "/r/a-b/x.txt",
            "/r/ab/x.txt",
            "/r/b/x.txt",
        ];
        let mut shuffled: Vec<&str> = walked.iter().rev().copied().collect();
        shuffled.sort_by(|a, b| walk_order_of_paths(Path::new(a), Path::new(b)));
        assert_eq!(shuffled, walked);
        assert_eq!(walk_order_of_paths(Path::new("/x.txt"), Path::new("/a/x.txt")), Ordering::Less);
    }

    #[test]
    fn names_that_are_not_utf8_rank_by_their_bytes() {
        use std::os::unix::ffi::OsStrExt;
        // Both would read as "/r/\u{FFFD}" once made lossy.
        let a = Path::new(OsStr::from_bytes(b"/r/\xfe"));
        let b = Path::new(OsStr::from_bytes(b"/r/\xff"));
        assert_eq!(walk_order_of_paths(a, b), Ordering::Less);
        assert_eq!(walk_order_of_paths(b, a), Ordering::Greater);
    }
}
