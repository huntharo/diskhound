//! Which directories the Unix walker leaves out.
//!
//! `scan_generic` asks `PrunePlan::skip_reason` about every child before
//! jwalk descends into it. Three rules:
//!
//! 1. Pseudo filesystems by path (`LINUX_SKIP_PREFIXES`): /proc, /sys, /dev
//!    and the rest. Walking them is meaningless and can hang.
//! 2. Other filesystems mounted below the scan root. They keep their own
//!    drive pill. Linux compares mountinfo device ids, so btrfs subvolumes
//!    of one pool stay in. macOS keeps the startup disk's System and Data
//!    volumes together and leaves out /Volumes/*, the VM, Preboot and
//!    Update volumes, simulator and cryptex images, and autofs. A scan of
//!    the mount point itself still walks it. Linux also skips the second
//!    path to files another mount of the same filesystem already shows:
//!    bind mounts, and subvolumes also visible inside another mount
//!    (`duplicate_mount_paths`).
//! 3. macOS firmlinks. `/` is the sealed System volume and user files live
//!    on the Data volume at /System/Volumes/Data. /usr/share/firmlinks
//!    joins them: /Users and /System/Volumes/Data/Users are one directory.
//!    When both names are under the scan root, the walk keeps the
//!    firmlinked name users know and skips the Data-side twin. Data-only
//!    content (.Spotlight-V100, .fseventsd, MobileSoftwareUpdate, …) has
//!    no twin and is still walked once, through /System/Volumes/Data.
//!
//! The plan is built once per scan. Deciding is a string compare and two
//! set lookups per directory; nothing is stat'ed during the walk.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Virtual / pseudo filesystem mount points that a user scan should
/// never descend into. Walking these is both meaningless (the
/// "files" under /proc and /sys are kernel-generated text and
/// change every read) and occasionally dangerous (certain /proc
/// entries can hang or cause side effects when opened).
///
/// Docker and snap bind-mounts are excluded too — docker's
/// overlayfs images + snap squashfs mounts multiply the visible
/// file count 10-100× without telling the user anything useful
/// about the host filesystem's free space.
const LINUX_SKIP_PREFIXES: &[&str] = &[
    "/proc",
    "/sys",
    "/dev",
    "/run",
    "/snap",
    "/var/lib/docker/overlay2",
    "/var/lib/docker/containers",
    "/var/lib/containers/storage/overlay",
    // Flatpak + Nix per-app mounts; not the install roots, just the
    // transient bind-mount views that blow up file counts.
    "/var/lib/flatpak/exports",
];

/// Where macOS mounts the startup disk's Data volume.
pub const MAC_DATA_VOLUME: &str = "/System/Volumes/Data";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prune {
    PseudoFs,
    OtherMount,
    DuplicateMount,
    FirmlinkTwin,
}

#[derive(Debug, Default)]
pub struct PrunePlan {
    /// Mount points below the root that belong to another filesystem.
    pub other_mounts: HashSet<String>,
    /// Linux: second paths to files another mount of the root's
    /// filesystem already shows.
    pub duplicate_mounts: HashSet<String>,
    /// Data-volume names of directories the walk reaches through a
    /// firmlink below the root.
    pub firmlink_twins: HashSet<String>,
}

impl PrunePlan {
    /// Why the walk must not enter `child`, or `None` to keep it. `child`
    /// is the absolute path jwalk hands the read-dir callback.
    pub fn skip_reason(&self, child: &str, is_dir: bool) -> Option<Prune> {
        if is_pseudo_fs_path(child) {
            return Some(Prune::PseudoFs);
        }
        if !is_dir {
            return None;
        }
        if self.other_mounts.contains(child) {
            return Some(Prune::OtherMount);
        }
        if self.duplicate_mounts.contains(child) {
            return Some(Prune::DuplicateMount);
        }
        if self.firmlink_twins.contains(child) {
            return Some(Prune::FirmlinkTwin);
        }
        None
    }
}

/// What the walk actually skipped. Written from jwalk's worker threads.
#[derive(Default)]
pub struct PruneLog {
    other_mounts: Mutex<Vec<String>>,
    duplicate_mounts: AtomicUsize,
    firmlink_twins: AtomicUsize,
}

impl PruneLog {
    pub fn note(&self, reason: Prune, path: &str) {
        match reason {
            Prune::PseudoFs => {}
            Prune::OtherMount => {
                if let Ok(mut mounts) = self.other_mounts.lock() {
                    mounts.push(path.to_string());
                }
            }
            Prune::DuplicateMount => {
                self.duplicate_mounts.fetch_add(1, Ordering::Relaxed);
            }
            Prune::FirmlinkTwin => {
                self.firmlink_twins.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// Mount points the walk reached and left out, sorted.
    pub fn other_mounts(&self) -> Vec<String> {
        let mut mounts = self
            .other_mounts
            .lock()
            .map(|mounts| mounts.clone())
            .unwrap_or_default();
        mounts.sort();
        mounts.dedup();
        mounts
    }

    pub fn duplicate_mounts(&self) -> usize {
        self.duplicate_mounts.load(Ordering::Relaxed)
    }

    pub fn firmlink_twins(&self) -> usize {
        self.firmlink_twins.load(Ordering::Relaxed)
    }
}

/// Matches a prefix followed by end-of-string or '/'. Pure `starts_with`
/// would false-positive on paths like "/devices" matching "/dev".
fn is_pseudo_fs_path(path: &str) -> bool {
    LINUX_SKIP_PREFIXES
        .iter()
        .any(|prefix| is_at_or_under(prefix, path))
}

fn trim_mount_point(path: &str) -> &str {
    if path.len() > 1 {
        path.trim_end_matches('/')
    } else {
        path
    }
}

/// `path` is strictly below `root`.
fn is_under(root: &str, path: &str) -> bool {
    if root == "/" {
        return path.len() > 1 && path.starts_with('/');
    }
    path.starts_with(root) && path.as_bytes().get(root.len()) == Some(&b'/')
}

fn is_at_or_under(root: &str, path: &str) -> bool {
    path == root || is_under(root, path)
}

// ── macOS: firmlinks and the startup volume group ─────────────────────

/// One line of /usr/share/firmlinks: a directory reachable as `system`
/// (`/Users`) and as `data` (`/System/Volumes/Data/Users`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct Firmlink {
    pub system: String,
    pub data: String,
}

/// Each line is `<path on />\t<path relative to the Data volume>`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_firmlinks(text: &str) -> Vec<Firmlink> {
    text.lines()
        .filter_map(|line| {
            let (system, relative) = line.split_once('\t')?;
            let system = trim_mount_point(system);
            let relative = relative.trim_end_matches('\r').trim_matches('/');
            if !system.starts_with('/') || system == "/" || relative.is_empty() {
                return None;
            }
            Some(Firmlink {
                system: system.to_string(),
                data: format!("{MAC_DATA_VOLUME}/{relative}"),
            })
        })
        .collect()
}

/// The other names of `path` through firmlinks, e.g. /Users/me ↔
/// /System/Volumes/Data/Users/me.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn firmlink_aliases(path: &str, firmlinks: &[Firmlink]) -> Vec<String> {
    let mut aliases = Vec::new();
    for link in firmlinks {
        if is_at_or_under(&link.system, path) {
            aliases.push(format!("{}{}", link.data, &path[link.system.len()..]));
        }
        if is_at_or_under(&link.data, path) {
            aliases.push(format!("{}{}", link.system, &path[link.data.len()..]));
        }
    }
    aliases
}

/// The mount point of the filesystem `path` lives on. The mount table can
/// name a mount by either side of a firmlink, and the longest literal
/// prefix of /Users/me is `/` though it lives on the Data volume, so every
/// alias is checked.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn owning_mount<'a>(path: &str, mounts: &'a [String], firmlinks: &[Firmlink]) -> Option<&'a str> {
    let mut names = firmlink_aliases(path, firmlinks);
    names.push(path.to_string());
    mounts
        .iter()
        .filter(|point| names.iter().any(|name| is_at_or_under(point, name)))
        .max_by_key(|point| point.len())
        .map(String::as_str)
}

/// The sealed System volume and its Data volume are one startup disk.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn is_startup_volume(point: &str) -> bool {
    point == "/" || point == MAC_DATA_VOLUME
}

/// Pure half of the macOS plan. `mounts` are mount points from the mount
/// table; `firmlinks` are the verified pairs.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mac_prune_plan(root: &str, mounts: &[String], firmlinks: &[Firmlink]) -> PrunePlan {
    let root = trim_mount_point(root);
    let mut plan = PrunePlan::default();

    for link in firmlinks {
        if is_under(root, &link.data) && is_at_or_under(root, &link.system) {
            plan.firmlink_twins.insert(link.data.clone());
        }
    }

    let Some(root_mount) = owning_mount(root, mounts, firmlinks) else {
        return plan;
    };
    for point in mounts {
        let same_disk = point == root_mount
            || (is_startup_volume(point) && is_startup_volume(root_mount));
        if same_disk {
            continue;
        }
        let mut names = firmlink_aliases(point, firmlinks);
        names.push(point.clone());
        for name in names {
            if is_under(root, &name) {
                plan.other_mounts.insert(name);
            }
        }
    }
    plan
}

/// Firmlinks whose two names really are one directory. /usr/share/firmlinks
/// lists some that a Mac doesn't have: /pkg can exist on the Data volume
/// with no /pkg on `/`, and then the Data side is the only way in.
#[cfg(target_os = "macos")]
fn load_firmlinks() -> Vec<Firmlink> {
    use std::os::unix::fs::MetadataExt;
    let Ok(text) = std::fs::read_to_string("/usr/share/firmlinks") else {
        return Vec::new();
    };
    parse_firmlinks(&text)
        .into_iter()
        .filter(|link| {
            match (std::fs::metadata(&link.system), std::fs::metadata(&link.data)) {
                (Ok(system), Ok(data)) => {
                    system.is_dir() && system.dev() == data.dev() && system.ino() == data.ino()
                }
                _ => false,
            }
        })
        .collect()
}

/// Mount points from getfsstat(2). MNT_NOWAIT returns the kernel's cached
/// list, so a dead network mount can't block the scan from starting.
#[cfg(target_os = "macos")]
fn mac_mount_points() -> Vec<String> {
    use std::ffi::CStr;
    let count = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) };
    if count <= 0 {
        return Vec::new();
    }
    // Room for mounts that appear between the two calls.
    let capacity = count as usize + 8;
    let mut table: Vec<libc::statfs> = Vec::with_capacity(capacity);
    let bytes = (capacity * std::mem::size_of::<libc::statfs>()) as libc::c_int;
    let filled = unsafe { libc::getfsstat(table.as_mut_ptr(), bytes, libc::MNT_NOWAIT) };
    if filled <= 0 {
        return Vec::new();
    }
    unsafe { table.set_len((filled as usize).min(capacity)) };
    table
        .iter()
        .map(|fs| {
            let point = unsafe { CStr::from_ptr(fs.f_mntonname.as_ptr()) };
            trim_mount_point(&point.to_string_lossy()).to_string()
        })
        .collect()
}

#[cfg(target_os = "macos")]
pub fn plan_for(root: &Path) -> PrunePlan {
    let mounts = mac_mount_points();
    if mounts.is_empty() {
        eprintln!(
            "[diskhound-native-scanner] macos: could not read the mount table — scan may cross into other disks"
        );
    }
    mac_prune_plan(&root.to_string_lossy(), &mounts, &load_firmlinks())
}

// ── Linux: /proc/self/mountinfo ───────────────────────────────────────

/// One line of `/proc/self/mountinfo`: mount point, the major:minor of
/// the filesystem, and the path inside that filesystem the mount shows
/// (`/` for a whole filesystem, `/@home` for a btrfs subvolume, the
/// source directory for a bind mount). btrfs subvolumes of one pool
/// share the major:minor; `stat.st_dev` does not.
#[cfg(target_os = "linux")]
pub struct LinuxMount {
    point: String,
    dev: String,
    root: String,
}

#[cfg(target_os = "linux")]
pub fn unescape_mountinfo(field: &str) -> String {
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\'
            && i + 3 < bytes.len()
            && bytes[i + 1..i + 4].iter().all(|c| c.is_ascii_digit())
        {
            if let Ok(v) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 4]).unwrap_or(""), 8)
            {
                out.push(v);
                i += 4;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(target_os = "linux")]
pub fn parse_mountinfo(text: &str) -> Vec<LinuxMount> {
    let mut mounts = Vec::new();
    for line in text.lines() {
        let Some((before, _)) = line.split_once(" - ") else {
            continue;
        };
        let fields: Vec<&str> = before.split(' ').collect();
        if fields.len() < 5 {
            continue;
        }
        let dev = fields[2];
        if dev.is_empty() || !dev.contains(':') {
            continue;
        }
        let point = unescape_mountinfo(fields[4]);
        let point = trim_mount_point(&point).to_string();
        if point.is_empty() {
            continue;
        }
        let root = unescape_mountinfo(fields[3]);
        mounts.push(LinuxMount {
            point,
            dev: dev.to_string(),
            root: trim_mount_point(&root).to_string(),
        });
    }
    mounts
}

/// Mount points under `root` that live on a different filesystem.
/// Same-pool btrfs subvolumes are kept. `st_dev` is the wrong key here:
/// btrfs gives each subvolume a distinct `st_dev` even when `df` shows one
/// pool. The scan root itself is never included, so an explicit scan of
/// `/mnt/windows` still walks it.
#[cfg(target_os = "linux")]
pub fn foreign_mount_points(mounts: &[LinuxMount], root: &str) -> HashSet<String> {
    let root = trim_mount_point(root);
    let Some(root_dev) = mounts
        .iter()
        .filter(|m| is_at_or_under(&m.point, root))
        .max_by_key(|m| m.point.len())
        .map(|m| m.dev.clone())
    else {
        return HashSet::new();
    };
    mounts
        .iter()
        .filter(|m| m.dev != root_dev && is_under(root, &m.point))
        .map(|m| m.point.clone())
        .collect()
}

/// `path` relative to `base`: `Some("")` when they are equal,
/// `Some("/rest")` when `path` is under `base`, `None` otherwise.
#[cfg(target_os = "linux")]
fn relative_mount_path<'a>(path: &'a str, base: &str) -> Option<&'a str> {
    if path == base {
        Some("")
    } else if base == "/" {
        Some(path)
    } else if is_under(base, path) {
        Some(&path[base.len()..])
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn join_mount_path(base: &str, rel: &str) -> String {
    if rel.is_empty() {
        base.to_string()
    } else if base == "/" {
        rel.to_string()
    } else {
        format!("{base}{rel}")
    }
}

/// Paths under `root` that would walk a second copy of files the scan
/// already reaches through another mount of the same filesystem. That
/// happens with a bind mount, a btrfs subvolume that is also visible
/// inside a mounted top-level volume, or openSUSE's
/// `/.snapshots/<n>/snapshot` when `<n>` is the running root.
///
/// For two walked mounts A and B on one device, where B's mountinfo root
/// is inside A's, B's files also appear inside A at A + (root(B) − root(A)).
/// That second path is pruned and B's mount point is kept, so `/home`
/// wins over `/@home` and a bind's mount point wins over its source. If
/// B is mounted inside that second path, a bind of a folder into itself,
/// B's mount point is pruned instead. Two mounts of the same subtree keep
/// the one mounted first. Sibling subvolumes, such as `/` from `@` and
/// `/home` from `@home`, never overlap and are both walked.
#[cfg(target_os = "linux")]
pub fn duplicate_mount_paths(mounts: &[LinuxMount], root: &str) -> HashSet<String> {
    let root = trim_mount_point(root);
    // A later mount on the same point hides the earlier one.
    let last_at: std::collections::HashMap<&str, usize> = mounts
        .iter()
        .enumerate()
        .map(|(i, m)| (m.point.as_str(), i))
        .collect();
    let visible: Vec<(usize, &LinuxMount)> = mounts
        .iter()
        .enumerate()
        .filter(|(i, m)| last_at[m.point.as_str()] == *i)
        .collect();
    let Some(&(home_index, home)) = visible
        .iter()
        .filter(|(_, m)| is_at_or_under(&m.point, root))
        .max_by_key(|(_, m)| m.point.len())
    else {
        return HashSet::new();
    };
    // The walk never gets to a mount under another filesystem's mount or
    // a skipped prefix, or to one a later mount above it covers. Pruning
    // its source would leave those files counted nowhere.
    let reachable = |i: usize, m: &LinuxMount| {
        !is_pseudo_fs_path(&m.point)
            && !visible.iter().any(|(j, above)| {
                is_under(&above.point, &m.point)
                    && (*j > i || (above.dev != home.dev && is_under(root, &above.point)))
            })
    };
    // Each same-device mount the walk enters: mountinfo order, where the
    // walk enters it, and the path inside the filesystem found there.
    let walked: Vec<(usize, String, String)> = visible
        .iter()
        .filter(|(i, m)| {
            *i == home_index
                || (m.dev == home.dev && is_under(root, &m.point) && reachable(*i, m))
        })
        .map(|(i, m)| {
            let entry = if *i == home_index { root.to_string() } else { m.point.clone() };
            let inside = relative_mount_path(&entry, &m.point).unwrap_or("");
            (*i, entry.clone(), join_mount_path(&m.root, inside))
        })
        .collect();

    let mut duplicates = HashSet::new();
    for (a_index, a_entry, a_fs) in &walked {
        for (b_index, b_entry, b_fs) in &walked {
            if a_index == b_index {
                continue;
            }
            let Some(rel) = relative_mount_path(b_fs, a_fs) else {
                continue;
            };
            if rel.is_empty() && a_index < b_index {
                continue;
            }
            let copy = join_mount_path(a_entry, rel);
            // Another mount inside A, at or above `copy`, covers it: A's
            // own files there are never reached.
            let covered = visible
                .iter()
                .any(|(_, m)| is_under(a_entry, &m.point) && is_at_or_under(&m.point, &copy));
            if covered {
                continue;
            }
            // `copy` itself is B's mount point only when B is bound onto
            // itself, and the check above already skipped that.
            if is_under(&copy, b_entry) {
                duplicates.insert(b_entry.clone());
            } else {
                duplicates.insert(copy);
            }
        }
    }
    // Paths under another pruned path are never reached anyway.
    let nested: Vec<String> = duplicates
        .iter()
        .filter(|path| duplicates.iter().any(|other| is_under(other, path)))
        .cloned()
        .collect();
    for path in nested {
        duplicates.remove(&path);
    }
    duplicates
}

#[cfg(target_os = "linux")]
pub fn plan_for(root: &Path) -> PrunePlan {
    let text = match std::fs::read_to_string("/proc/self/mountinfo") {
        Ok(text) => text,
        Err(err) => {
            eprintln!(
                "[diskhound-native-scanner] linux: could not read mountinfo ({err}) — scan may cross into other disks"
            );
            return PrunePlan::default();
        }
    };
    let mounts = parse_mountinfo(&text);
    let root = root.to_string_lossy();
    PrunePlan {
        other_mounts: foreign_mount_points(&mounts, &root),
        duplicate_mounts: duplicate_mount_paths(&mounts, &root),
        firmlink_twins: HashSet::new(),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn plan_for(_root: &Path) -> PrunePlan {
    PrunePlan::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn pseudo_fs_prefixes_match_whole_components() {
        let plan = PrunePlan::default();
        assert_eq!(plan.skip_reason("/proc", true), Some(Prune::PseudoFs));
        assert_eq!(plan.skip_reason("/dev/fd", true), Some(Prune::PseudoFs));
        assert_eq!(plan.skip_reason("/proc/kcore", false), Some(Prune::PseudoFs));
        assert_eq!(plan.skip_reason("/devices", true), None);
        assert_eq!(plan.skip_reason("/home/me/proc", true), None);
    }

    #[test]
    fn mounts_and_twins_are_skipped_only_as_directories() {
        let plan = PrunePlan {
            other_mounts: set(&["/Volumes/USB"]),
            duplicate_mounts: set(&["/mnt/bind"]),
            firmlink_twins: set(&["/System/Volumes/Data/Users"]),
        };
        assert_eq!(plan.skip_reason("/Volumes/USB", true), Some(Prune::OtherMount));
        assert_eq!(plan.skip_reason("/mnt/bind", true), Some(Prune::DuplicateMount));
        assert_eq!(
            plan.skip_reason("/System/Volumes/Data/Users", true),
            Some(Prune::FirmlinkTwin)
        );
        assert_eq!(plan.skip_reason("/Volumes/USB", false), None);
        assert_eq!(plan.skip_reason("/Volumes/USB/photos", true), None, "below a pruned mount is never asked");
        assert_eq!(plan.skip_reason("/Users", true), None);
        assert_eq!(plan.skip_reason("/System/Volumes/Data", true), None);
    }

    #[test]
    fn prune_log_reports_each_mount_once_and_counts_twins() {
        let log = PruneLog::default();
        log.note(Prune::OtherMount, "/Volumes/USB");
        log.note(Prune::OtherMount, "/System/Volumes/VM");
        log.note(Prune::OtherMount, "/Volumes/USB");
        log.note(Prune::FirmlinkTwin, "/System/Volumes/Data/Users");
        log.note(Prune::DuplicateMount, "/mnt/bind");
        log.note(Prune::PseudoFs, "/dev");
        assert_eq!(log.other_mounts(), vec!["/System/Volumes/VM", "/Volumes/USB"]);
        assert_eq!(log.firmlink_twins(), 1);
        assert_eq!(log.duplicate_mounts(), 1);
    }

    const FIRMLINKS: &str = "\
/AppleInternal\tAppleInternal
/Applications\tApplications
/Library\tLibrary
/System/Library/Caches\tSystem/Library/Caches
/System/Library/CoreServices/CoreTypes.bundle/Contents/Library\tSystem/Library/CoreServices/CoreTypes.bundle/Contents/Library
/Users\tUsers
/Volumes\tVolumes
/cores\tcores
/opt\topt
/pkg\tpkg
/private\tprivate
/usr/local\tusr/local
";

    /// A Mac with no /AppleInternal and no /pkg on `/`: the loader drops
    /// those two lines.
    fn firmlinks() -> Vec<Firmlink> {
        parse_firmlinks(FIRMLINKS)
            .into_iter()
            .filter(|l| l.system != "/AppleInternal" && l.system != "/pkg")
            .collect()
    }

    /// `mount` on a macOS 26 Mac with Xcode, plus a USB disk, an SMB share
    /// with a space in its name, and a disk image mounted in a home folder.
    fn mounts() -> Vec<String> {
        [
            "/",
            "/dev",
            "/System/Volumes/VM",
            "/System/Volumes/Preboot",
            "/System/Volumes/Update",
            "/System/Volumes/xarts",
            "/System/Volumes/iSCPreboot",
            "/System/Volumes/Hardware",
            "/System/Volumes/Data",
            "/System/Volumes/Data/home",
            "/Library/Developer/CoreSimulator/Volumes/iOS_21A342",
            "/private/var/run/com.apple.security.cryptexd/mnt/com.apple.MobileAsset.MetalToolchain",
            "/Volumes/Storage",
            "/Volumes/Media Share",
            "/Users/me/mnt/image",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    #[test]
    fn parses_firmlinks_into_both_names() {
        let links = parse_firmlinks(FIRMLINKS);
        assert_eq!(links.len(), 12);
        assert_eq!(
            links[5],
            Firmlink {
                system: "/Users".into(),
                data: "/System/Volumes/Data/Users".into(),
            }
        );
        assert_eq!(links[11].data, "/System/Volumes/Data/usr/local");
        assert!(parse_firmlinks("garbage\n/\tx\nrelative\tx\n/a\t\n").is_empty());
    }

    #[test]
    fn root_scan_walks_data_once_and_leaves_out_other_volumes() {
        let plan = mac_prune_plan("/", &mounts(), &firmlinks());

        assert_eq!(
            plan.firmlink_twins,
            set(&[
                "/System/Volumes/Data/Applications",
                "/System/Volumes/Data/Library",
                "/System/Volumes/Data/System/Library/Caches",
                "/System/Volumes/Data/System/Library/CoreServices/CoreTypes.bundle/Contents/Library",
                "/System/Volumes/Data/Users",
                "/System/Volumes/Data/Volumes",
                "/System/Volumes/Data/cores",
                "/System/Volumes/Data/opt",
                "/System/Volumes/Data/private",
                "/System/Volumes/Data/usr/local",
            ])
        );
        // Not a live firmlink here, so the Data side is the only way in.
        assert!(!plan.firmlink_twins.contains("/System/Volumes/Data/pkg"));

        for point in [
            "/dev",
            "/System/Volumes/VM",
            "/System/Volumes/Preboot",
            "/System/Volumes/Update",
            "/System/Volumes/xarts",
            "/System/Volumes/iSCPreboot",
            "/System/Volumes/Hardware",
            "/System/Volumes/Data/home",
            "/Library/Developer/CoreSimulator/Volumes/iOS_21A342",
            "/private/var/run/com.apple.security.cryptexd/mnt/com.apple.MobileAsset.MetalToolchain",
            "/Volumes/Storage",
            "/Volumes/Media Share",
            "/Users/me/mnt/image",
        ] {
            assert!(plan.other_mounts.contains(point), "{point} should be left out");
        }
        assert!(!plan.other_mounts.contains("/System/Volumes/Data"));
        assert!(!plan.other_mounts.contains("/"));

        // Data-only folders are walked, through the Data volume.
        for kept in [
            "/System/Volumes/Data",
            "/System/Volumes/Data/.Spotlight-V100",
            "/System/Volumes/Data/MobileSoftwareUpdate",
            "/System/Volumes/Data/System/Library/CoreServices",
            "/System/Volumes/Data/usr",
            "/System/Volumes/Data/pkg",
            "/Users",
            "/usr/local",
        ] {
            assert_eq!(plan.skip_reason(kept, true), None, "{kept} should be walked");
        }
    }

    #[test]
    fn data_volume_scan_has_no_twins_but_leaves_out_mounts_by_either_name() {
        let plan = mac_prune_plan("/System/Volumes/Data", &mounts(), &firmlinks());
        assert!(plan.firmlink_twins.is_empty());
        assert!(plan.other_mounts.contains("/System/Volumes/Data/home"));
        assert!(plan.other_mounts.contains("/System/Volumes/Data/Volumes/Storage"));
        assert!(plan
            .other_mounts
            .contains("/System/Volumes/Data/Library/Developer/CoreSimulator/Volumes/iOS_21A342"));
        assert!(!plan.other_mounts.iter().any(|m| !m.starts_with("/System/Volumes/Data/")));
    }

    #[test]
    fn home_scan_is_on_the_data_volume_and_leaves_out_a_mounted_image() {
        let plan = mac_prune_plan("/Users/me", &mounts(), &firmlinks());
        assert!(plan.firmlink_twins.is_empty());
        assert_eq!(plan.other_mounts, set(&["/Users/me/mnt/image"]));
        assert_eq!(
            owning_mount("/Users/me", &mounts(), &firmlinks()),
            Some("/System/Volumes/Data")
        );
    }

    #[test]
    fn scanning_a_mount_itself_walks_it() {
        let plan = mac_prune_plan("/Volumes/Storage", &mounts(), &firmlinks());
        assert!(plan.other_mounts.is_empty());
        assert!(plan.firmlink_twins.is_empty());
        let plan = mac_prune_plan("/Volumes/Storage/", &mounts(), &firmlinks());
        assert!(plan.other_mounts.is_empty());
    }

    #[test]
    fn volumes_folder_scan_leaves_out_every_disk_in_it() {
        let plan = mac_prune_plan("/Volumes", &mounts(), &firmlinks());
        assert_eq!(plan.other_mounts, set(&["/Volumes/Storage", "/Volumes/Media Share"]));
    }

    #[test]
    fn system_scan_skips_twins_of_firmlinks_below_it() {
        let plan = mac_prune_plan("/System", &mounts(), &firmlinks());
        assert_eq!(
            plan.firmlink_twins,
            set(&[
                "/System/Volumes/Data/System/Library/Caches",
                "/System/Volumes/Data/System/Library/CoreServices/CoreTypes.bundle/Contents/Library",
            ])
        );
        assert!(plan.other_mounts.contains("/System/Volumes/VM"));
        assert!(!plan.other_mounts.contains("/System/Volumes/Data"));
    }

    #[test]
    fn no_mount_table_still_skips_twins() {
        let plan = mac_prune_plan("/", &[], &firmlinks());
        assert!(plan.other_mounts.is_empty());
        assert!(plan.firmlink_twins.contains("/System/Volumes/Data/Users"));
    }

    #[test]
    fn a_disk_without_firmlinks_prunes_like_linux() {
        let plan = mac_prune_plan("/", &["/".into(), "/Volumes/USB".into()], &[]);
        assert_eq!(plan.other_mounts, set(&["/Volumes/USB"]));
        assert!(plan.firmlink_twins.is_empty());
    }

    /// The live plan for `/` on this Mac: every twin it skips is the same
    /// directory as its firmlinked name, and the Data volume stays in.
    #[cfg(target_os = "macos")]
    #[test]
    fn live_root_plan_skips_only_true_twins_and_keeps_the_data_volume() {
        use std::os::unix::fs::MetadataExt;
        if std::fs::metadata(MAC_DATA_VOLUME).is_err() {
            return; // Pre-Catalina: no Data volume, nothing to prune.
        }
        let plan = plan_for(Path::new("/"));
        assert!(plan.firmlink_twins.contains("/System/Volumes/Data/Users"));
        assert!(plan.firmlink_twins.contains("/System/Volumes/Data/Applications"));
        assert!(plan.firmlink_twins.contains("/System/Volumes/Data/private"));
        for twin in &plan.firmlink_twins {
            let system = twin.strip_prefix(MAC_DATA_VOLUME).unwrap();
            let (a, b) = (
                std::fs::metadata(system).unwrap(),
                std::fs::metadata(twin).unwrap(),
            );
            assert_eq!((a.dev(), a.ino()), (b.dev(), b.ino()), "{twin} is not {system}");
        }
        assert_eq!(plan.skip_reason(MAC_DATA_VOLUME, true), None);
        assert_eq!(plan.skip_reason("/Users", true), None);
        for volume in ["/System/Volumes/VM", "/System/Volumes/Preboot"] {
            if std::fs::metadata(volume).is_ok() {
                assert!(plan.other_mounts.contains(volume), "{volume} should be left out");
            }
        }
        assert!(!plan.other_mounts.contains("/"));
    }

    /// Walks the directories of `/` down to /System/Volumes/Data/<x> with
    /// the live plan and checks each one is reached once, Data-only
    /// folders included. Without the twins the same walk reaches /Users a
    /// second time as /System/Volumes/Data/Users.
    #[cfg(target_os = "macos")]
    #[test]
    fn live_root_walk_reaches_each_directory_once() {
        use std::collections::HashMap;
        use std::os::unix::fs::MetadataExt;
        if std::fs::metadata(MAC_DATA_VOLUME).is_err() {
            return;
        }

        fn walk(plan: &PrunePlan, max_depth: usize) -> HashMap<(u64, u64), Vec<String>> {
            let mut seen: HashMap<(u64, u64), Vec<String>> = HashMap::new();
            let mut stack = vec![("/".to_string(), 0usize)];
            while let Some((dir, depth)) = stack.pop() {
                let Ok(meta) = std::fs::symlink_metadata(&dir) else { continue };
                seen.entry((meta.dev(), meta.ino())).or_default().push(dir.clone());
                // Home folders hold Desktop, Documents and Downloads, and
                // listing those raises a privacy prompt.
                let in_home = is_under("/Users", &dir) || is_under("/System/Volumes/Data/Users", &dir);
                if depth == max_depth || in_home {
                    continue;
                }
                let Ok(children) = std::fs::read_dir(&dir) else { continue };
                for child in children.flatten() {
                    let Ok(kind) = child.file_type() else { continue };
                    if !kind.is_dir() {
                        continue;
                    }
                    let path = child.path().to_string_lossy().into_owned();
                    if plan.skip_reason(&path, true).is_none() {
                        stack.push((path, depth + 1));
                    }
                }
            }
            seen
        }

        // /System/Volumes/Data/Users is 4 levels down.
        let plan = plan_for(Path::new("/"));
        let with_plan = walk(&plan, 4);
        let twice: Vec<_> = with_plan.values().filter(|paths| paths.len() > 1).collect();
        assert!(twice.is_empty(), "reached more than once: {twice:?}");
        let reached: HashSet<&String> = with_plan.values().flatten().collect();
        assert!(reached.contains(&"/Users".to_string()));
        for child in std::fs::read_dir(MAC_DATA_VOLUME).unwrap().flatten() {
            let path = child.path().to_string_lossy().into_owned();
            if child.file_type().is_ok_and(|kind| kind.is_dir())
                && plan.skip_reason(&path, true).is_none()
            {
                assert!(reached.contains(&path), "Data-only {path} was not walked");
            }
        }

        // Same walk with the other volumes still left out (listing them can
        // prompt too), but no twins.
        let without = walk(
            &PrunePlan {
                other_mounts: plan.other_mounts.clone(),
                ..PrunePlan::default()
            },
            4,
        );
        let users = std::fs::metadata("/Users").unwrap();
        assert_eq!(
            without[&(users.dev(), users.ino())].len(),
            2,
            "the check must catch the old double walk"
        );
    }

    #[cfg(target_os = "linux")]
    mod linux {
        use super::super::{
            duplicate_mount_paths, foreign_mount_points, parse_mountinfo, unescape_mountinfo,
        };
        use std::collections::HashSet;

        fn duplicates(mountinfo: &str, root: &str) -> Vec<String> {
            let mut paths: Vec<String> =
                duplicate_mount_paths(&parse_mountinfo(mountinfo), root).into_iter().collect();
            paths.sort();
            paths
        }

        const FIXTURE: &str = "\
36 35 0:29 / / rw,relatime - btrfs /dev/mapper/root rw\n\
37 36 0:29 /@home /home rw - btrfs /dev/mapper/root rw\n\
38 36 0:29 /@log /var/log rw - btrfs /dev/mapper/root rw\n\
39 36 0:58 / /tmp rw - tmpfs tmpfs rw\n\
40 36 259:9 / /boot rw - vfat /dev/nvme0n1p1 rw\n\
41 36 259:6 / /mnt/windows rw - ntfs3 /dev/nvme1n1p1 ro\n\
42 36 259:7 / /mnt/windows-backup rw - ntfs3 /dev/sdc1 rw\n\
43 39 0:99 / /tmp/.mount_DiskHo rw - fuse.AppImage DiskHound ro\n\
44 36 0:30 / /mnt/my\\040disk rw - ext4 /dev/sdb1 rw\n\
45 41 0:58 / /mnt/windows/nested-tmp rw - tmpfs tmpfs rw\n";

        #[test]
        fn unescapes_octal_space() {
            assert_eq!(unescape_mountinfo(r"/mnt/my\040disk"), "/mnt/my disk");
        }

        #[test]
        fn root_scan_keeps_same_pool_subvolumes_and_drops_other_disks() {
            let mounts = parse_mountinfo(FIXTURE);
            let foreign = foreign_mount_points(&mounts, "/");
            assert!(foreign.contains("/mnt/windows"));
            assert!(foreign.contains("/mnt/windows-backup"));
            assert!(foreign.contains("/boot"));
            assert!(foreign.contains("/tmp"));
            assert!(foreign.contains("/tmp/.mount_DiskHo"));
            assert!(foreign.contains("/mnt/my disk"));
            assert!(foreign.contains("/mnt/windows/nested-tmp"));
            assert!(!foreign.contains("/home"));
            assert!(!foreign.contains("/var/log"));
            assert!(!foreign.contains("/"));
        }

        #[test]
        fn home_scan_does_not_include_windows() {
            let mounts = parse_mountinfo(FIXTURE);
            let foreign = foreign_mount_points(&mounts, "/home");
            assert!(foreign.is_empty());
        }

        #[test]
        fn a_bind_mount_is_walked_once_through_its_mount_point() {
            let mountinfo = "\
125 196 0:66 / /scan rw - tmpfs tmpfs rw\n\
126 125 0:66 /proj /scan/view rw - tmpfs tmpfs rw\n";
            assert_eq!(duplicates(mountinfo, "/scan"), vec!["/scan/proj"]);
            // Scans that reach only one copy prune nothing.
            assert!(duplicates(mountinfo, "/scan/proj").is_empty());
            assert!(duplicates(mountinfo, "/scan/view").is_empty());
        }

        #[test]
        fn sibling_subvolumes_are_both_walked() {
            // Fedora and Ubuntu: / is subvolume root (or @), /home is home (or @home).
            let mountinfo = "\
30 1 0:29 /root / rw - btrfs /dev/nvme0n1p3 rw\n\
31 30 0:29 /home /home rw - btrfs /dev/nvme0n1p3 rw\n\
32 30 0:29 /var /var rw - btrfs /dev/nvme0n1p3 rw\n";
            assert!(duplicates(mountinfo, "/").is_empty());
        }

        #[test]
        fn subvolumes_inside_a_mounted_top_level_volume_are_walked_at_their_mount_points() {
            let found = duplicates(FIXTURE, "/");
            assert_eq!(found, vec!["/@home", "/@log"]);
            assert!(duplicates(FIXTURE, "/home").is_empty());
            // Other disks are foreign_mount_points' job, not duplicates.
            assert!(!found.iter().any(|p| p.starts_with("/mnt")));
        }

        #[test]
        fn opensuse_root_snapshot_is_not_walked_again_under_snapshots() {
            let mountinfo = "\
60 1 0:40 /@/.snapshots/1/snapshot / rw - btrfs /dev/vda2 rw\n\
61 60 0:40 /@/.snapshots /.snapshots rw - btrfs /dev/vda2 rw\n\
62 60 0:40 /@/home /home rw - btrfs /dev/vda2 rw\n";
            assert_eq!(duplicates(mountinfo, "/"), vec!["/.snapshots/1/snapshot"]);
        }

        #[test]
        fn a_folder_bound_inside_itself_is_skipped_at_the_inner_mount() {
            let mountinfo = "\
20 1 8:1 / / rw - ext4 /dev/sda1 rw\n\
21 20 8:1 /data /data/sub/loop rw - ext4 /dev/sda1 rw\n";
            assert_eq!(duplicates(mountinfo, "/"), vec!["/data/sub/loop"]);
            assert_eq!(duplicates(mountinfo, "/data"), vec!["/data/sub/loop"]);
        }

        #[test]
        fn the_same_folder_bound_twice_keeps_the_first_mount() {
            let mountinfo = "\
20 1 8:1 / / rw - ext4 /dev/sda1 rw\n\
21 20 8:1 /data/x /mnt/a rw - ext4 /dev/sda1 rw\n\
22 20 8:1 /data/x /mnt/b rw - ext4 /dev/sda1 rw\n\
23 20 8:1 / /mnt/whole rw - ext4 /dev/sda1 rw\n";
            assert_eq!(duplicates(mountinfo, "/"), vec!["/data/x", "/mnt/b", "/mnt/whole"]);
        }

        #[test]
        fn a_folder_bound_onto_itself_is_walked_once_without_pruning() {
            let mountinfo = "\
20 1 8:1 / / rw - ext4 /dev/sda1 rw\n\
21 20 8:1 /srv /srv rw - ext4 /dev/sda1 rw\n";
            assert!(duplicates(mountinfo, "/").is_empty());
        }

        #[test]
        fn a_mount_the_walk_never_reaches_prunes_nothing() {
            // /tmp/x sits under a tmpfs, and /mnt/y is covered by the tmpfs
            // mounted on /mnt after it. Neither is walked, so /data/x and
            // /data/y are the only way to those files.
            let mountinfo = "\
20 1 8:1 / / rw - ext4 /dev/sda1 rw\n\
21 20 0:50 / /tmp rw - tmpfs tmpfs rw\n\
22 21 8:1 /data/x /tmp/x rw - ext4 /dev/sda1 rw\n\
23 20 8:1 /data/y /mnt/y rw - ext4 /dev/sda1 rw\n\
24 20 0:51 / /mnt rw - tmpfs tmpfs rw\n";
            let found: HashSet<String> = duplicate_mount_paths(&parse_mountinfo(mountinfo), "/");
            assert!(found.is_empty(), "{found:?}");
        }

        #[test]
        fn a_copy_under_a_foreign_mount_is_already_out_of_the_walk() {
            let mountinfo = "\
20 1 8:1 / / rw - ext4 /dev/sda1 rw\n\
21 20 0:50 / /data rw - tmpfs tmpfs rw\n\
22 20 8:1 /data/x /mnt/x rw - ext4 /dev/sda1 rw\n";
            // /data on the root disk is hidden under the tmpfs, so /mnt/x is
            // the only way to its files.
            let found: HashSet<String> = duplicate_mount_paths(&parse_mountinfo(mountinfo), "/");
            assert!(found.is_empty(), "{found:?}");
        }

        #[test]
        fn explicit_windows_scan_walks_that_disk_and_skips_nested_other_fs() {
            let mounts = parse_mountinfo(FIXTURE);
            let foreign = foreign_mount_points(&mounts, "/mnt/windows");
            assert!(foreign.contains("/mnt/windows/nested-tmp"));
            assert!(!foreign.contains("/mnt/windows"));
            assert!(!foreign.contains("/mnt/windows-backup"));
        }
    }
}
