//! Named macOS stores from the normal scan. No extra reads, privilege or actions.
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    kind: &'static str,
    path: String,
    bytes: Option<u64>,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    issue: Option<&'static str>,
}

struct Row {
    kind: &'static str,
    path: String,
    bytes: u64,
    observed: bool,
    failed: bool,
}

pub struct Tracker {
    root: String,
    rows: [Row; 2],
}

fn under(parent: &str, path: &str) -> bool {
    path == parent
        || (path.starts_with(parent)
            && (parent == "/" || path.as_bytes().get(parent.len()) == Some(&b'/')))
}

impl Tracker {
    pub fn new(root: &str) -> Self {
        let volume = if let Some(tail) = root.strip_prefix("/Volumes/") {
            let name = tail.split('/').next().unwrap_or("");
            format!("/Volumes/{name}")
        } else if let Some(parent) = root
            .strip_suffix("/.fseventsd")
            .or_else(|| root.strip_suffix("/.Spotlight-V100"))
        {
            parent.to_owned()
        } else {
            "/System/Volumes/Data".to_owned()
        };
        Self::for_volume(root, &volume)
    }

    fn for_volume(root: &str, volume: &str) -> Self {
        Self {
            root: root.to_owned(),
            rows: [("fsevents", ".fseventsd"), ("spotlight", ".Spotlight-V100")].map(
                |(kind, name)| Row {
                    kind,
                    path: format!("{volume}/{name}"),
                    bytes: 0,
                    observed: false,
                    failed: false,
                },
            ),
        }
    }

    pub fn directory(&mut self, path: &str) {
        for row in &mut self.rows {
            crate::work::step();
            if path == row.path {
                row.observed = true;
            }
        }
    }

    pub fn file(&mut self, path: &str, occupancy: u64) {
        for row in &mut self.rows {
            crate::work::step();
            if under(&row.path, path) {
                row.observed = true;
                row.bytes += occupancy;
            }
        }
    }

    /// dua-core's enumeration errors do not carry a path. Unknown failures
    /// conservatively prevent completeness claims for both stores.
    pub fn uncertain(&mut self, path: Option<&str>) {
        for row in &mut self.rows {
            crate::work::step();
            if path.is_none_or(|p| under(&row.path, p) || under(p, &row.path)) {
                row.failed = true;
            }
        }
    }

    pub fn snapshot(&self, done: bool) -> Vec<Usage> {
        self.rows
            .iter()
            .map(|row| {
                let covered = under(&self.root, &row.path);
                let complete = covered && done && row.observed && !row.failed;
                let bytes = (complete || row.bytes > 0).then_some(row.bytes);
                Usage {
                    kind: row.kind,
                    path: row.path.clone(),
                    bytes,
                    status: if !covered {
                        "outside-scan"
                    } else if complete {
                        "complete"
                    } else if bytes.is_some() {
                        "incomplete"
                    } else {
                        "unavailable"
                    },
                    issue: if complete || !covered {
                        None
                    } else if row.failed {
                        Some("scan-errors")
                    } else {
                        Some("not-observed")
                    },
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_is_not_zero_and_partial_is_not_complete() {
        let mut t = Tracker::new("/");
        assert_eq!(t.snapshot(true)[0].bytes, None);
        t.directory("/System/Volumes/Data/.fseventsd");
        t.uncertain(None);
        assert_eq!(t.snapshot(true)[0].bytes, None);
        t.file("/System/Volumes/Data/.fseventsd/log", 20_585_635_840);
        let rows = t.snapshot(true);
        assert_eq!(rows[0].bytes, Some(20_585_635_840));
        assert_eq!(rows[0].status, "incomplete");
        assert_eq!(rows[1].status, "unavailable");
    }

    #[test]
    fn canonical_paths_and_scan_scope() {
        let mut t = Tracker::new("/");
        t.file("/System/Volumes/Data/.Spotlight-V100/store", 8_597_852_160);
        t.file("/.Spotlight-V100/store", 8_597_852_160);
        t.file("/System/Volumes/Data/.Spotlight-V100-extra/store", 99);
        assert_eq!(t.snapshot(true)[1].bytes, Some(8_597_852_160));
        assert_eq!(t.snapshot(true)[1].status, "complete");
        assert_eq!(
            Tracker::new("/Users/me").snapshot(true)[0].status,
            "outside-scan"
        );
        assert_eq!(
            Tracker::new("/Volumes/USB/photos").snapshot(true)[1].path,
            "/Volumes/USB/.Spotlight-V100"
        );
    }

    #[test]
    fn metadata_tracking_scales_linearly() {
        let run = |n| {
            let mut t = Tracker::new("/");
            crate::work::take();
            for _ in 0..n {
                t.file("/System/Volumes/Data/.fseventsd/log", 4096);
                t.file("/Users/me/file", 4096);
                t.directory("/Users/me/folder");
            }
            crate::work::take()
        };
        let small = run(1000);
        let large = run(8000);
        assert!(large <= small * 16);
        assert!(large <= 48_000);
    }

    #[cfg(unix)]
    #[test]
    fn normal_walker_counts_cross_store_hardlinks_once_without_hotspot_limits() {
        use crate::test_support::{TempTree, finish_index, test_state};
        use std::os::unix::fs::MetadataExt;
        let tree = TempTree::new("metadata-walk");
        let log = tree.write("root/.fseventsd/log", 8192);
        tree.link(&log, "root/.Spotlight-V100/link");
        let store = tree.write("root/.Spotlight-V100/store", 16384);
        let root = tree.path("root");
        let index = tree.path("index.gz");
        let root_str = crate::normalize_path(&root);
        let mut state = test_state(&root, &index);
        state.input.top_directory_limit = 1;
        state.mac_system_metadata = Some(Tracker::for_volume(&root_str, &root_str));
        crate::scan_generic(&root, &mut state).unwrap();
        finish_index(&mut state, &index);
        let rows = state.mac_system_metadata.as_ref().unwrap().snapshot(true);
        let total = (std::fs::metadata(log).unwrap().blocks()
            + std::fs::metadata(store).unwrap().blocks())
            * 512;
        // The lexically first hardlink (.Spotlight-V100) owns the bytes.
        assert_eq!(rows[0].bytes, Some(0));
        assert_eq!(rows[1].bytes, Some(total));
        assert_eq!(rows[0].status, "complete");
        assert_eq!(rows[1].status, "complete");
        assert_eq!(state.bytes_seen, total);
        assert_eq!(state.hottest_directories.len(), 1);
    }
}
