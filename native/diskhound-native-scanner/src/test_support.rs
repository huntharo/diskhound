//! Fixtures shared by the walker tests: temp trees, a `ScanState` that
//! writes an index, an index reader, and the visit-once I/O budgets.

use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};

use crate::index_line::{parse_index_line, IndexLineRec};
use crate::{normalize_path, IndexWriter, IoStats, ScanInput, ScanState};

pub struct TempTree(PathBuf);

impl TempTree {
    pub fn new(label: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "diskhound-{label}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        // /var → /private/var on macOS; run() scans the canonical root.
        TempTree(dir.canonicalize().unwrap())
    }

    pub fn path(&self, rel: &str) -> PathBuf {
        self.0.join(rel)
    }

    pub fn write(&self, rel: &str, bytes: usize) -> PathBuf {
        let path = self.path(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, vec![7u8; bytes]).unwrap();
        path
    }

    #[cfg(unix)]
    pub fn mkdir(&self, rel: &str) -> PathBuf {
        let path = self.path(rel);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[cfg(unix)]
    pub fn link(&self, target: &Path, rel: &str) {
        let path = self.path(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::hard_link(target, path).unwrap();
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn scan_input(root: &Path, index_output: &Path) -> ScanInput {
    ScanInput {
        root_path: root.to_path_buf(),
        top_file_limit: 100,
        top_directory_limit: 100,
        index_output: Some(index_output.to_path_buf()),
        baseline_index: None,
        folder_tree_output: None,
        dev_artifacts_output: None,
        expected_total_files: None,
    }
}

/// A fresh scan of `root` that writes its index to `index_output`.
pub fn test_state(root: &Path, index_output: &Path) -> ScanState {
    state_for(scan_input(root, index_output), None, Arc::new(IoStats::default()))
}

pub fn state_for(
    input: ScanInput,
    baseline: Option<crate::Baseline>,
    io: Arc<IoStats>,
) -> ScanState {
    let root_path_string = normalize_path(&input.root_path);
    let index_output = input.index_output.clone().unwrap();
    let index_writer =
        IndexWriter::create(&index_output, None, root_path_string.clone()).unwrap();
    ScanState::new(input, root_path_string, Some(index_writer), baseline, io)
}

/// Closes the scan's index and returns every line in it.
pub fn finish_index(state: &mut ScanState, index_output: &Path) -> Vec<IndexLineRec> {
    state.index_writer.take().unwrap().finish().0.unwrap();
    let reader = BufReader::new(GzDecoder::new(File::open(index_output).unwrap()));
    reader
        .lines()
        .map(|line| line.unwrap())
        .map(|line| parse_index_line(&line).unwrap_or_else(|| panic!("bad index line: {line}")))
        .collect()
}

/// Each directory and each file appears once in the index. Returns the
/// directory and file paths.
pub fn assert_listed_once(index: &[IndexLineRec]) -> (HashSet<String>, HashSet<String>) {
    let mut dirs = HashSet::new();
    let mut files = HashSet::new();
    for rec in index {
        let fresh = if rec.is_dir {
            dirs.insert(rec.path.clone())
        } else {
            files.insert(rec.path.clone())
        };
        assert!(fresh, "{} is in the index twice", rec.path);
    }
    (dirs, files)
}

/// No inode is listed twice. A path reached a second way, through a bind
/// mount, a firmlink or a second walk, shows up as another index line for
/// an inode already listed. Extra hardlinks share their owner's inode and
/// are flagged `h:1`; their owner must be in the index too.
#[cfg(unix)]
pub fn assert_each_inode_owned_once(index: &[IndexLineRec]) {
    use std::os::unix::fs::MetadataExt;

    let mut owned = HashSet::new();
    let mut extra_links = Vec::new();
    for rec in index {
        let meta = fs::symlink_metadata(&rec.path).unwrap();
        let id = (meta.dev(), meta.ino());
        if rec.extra_hardlink {
            extra_links.push((rec.path.clone(), id));
        } else {
            assert!(owned.insert(id), "{} is an inode the index already lists", rec.path);
        }
    }
    for (path, id) in extra_links {
        assert!(owned.contains(&id), "{path} is flagged h:1 but its owner is not in the index");
    }
}

/// What one scenario cost the disk, as recorded in `io-budgets.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IoBudget {
    pub note: String,
    /// Directory listings: dua-core's reads, `FindFirstFileExW`.
    pub readdir: u64,
    /// Per-path metadata reads: `symlink_metadata`, `metadata`,
    /// `GetCompressedFileSizeW`.
    pub stat: u64,
    /// Full passes over the baseline index, from the bytes read.
    pub baseline_passes: u64,
}

impl IoBudget {
    fn counts(&self) -> (u64, u64, u64) {
        (self.readdir, self.stat, self.baseline_passes)
    }
}

/// Measures a scenario from its `IoStats`. `baseline` is the index the
/// scan was given, if any; every read of it must cover the whole file.
pub fn measured(note: &str, io: &IoStats, baseline: Option<&Path>) -> IoBudget {
    let bytes = io.baseline_bytes_read();
    let baseline_passes = match baseline {
        None => {
            assert_eq!(bytes, 0, "no baseline was given, but {bytes} baseline bytes were read");
            0
        }
        Some(path) => {
            let size = fs::metadata(path).unwrap().len();
            assert_eq!(bytes % size, 0, "read {bytes} bytes of a {size}-byte baseline: a partial pass");
            bytes / size
        }
    };
    IoBudget {
        note: note.to_string(),
        readdir: io.readdir_calls(),
        stat: io.stat_calls(),
        baseline_passes,
    }
}

const BUDGETS_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/io-budgets.json");

/// Tests run on threads of one process; each re-record rewrites the file.
static BUDGETS_LOCK: Mutex<()> = Mutex::new(());

/// Checks a measurement against `io-budgets.json` next to Cargo.toml,
/// exactly: an increase is the regression this exists to catch, and a
/// decrease means the budget is stale. `UPDATE_IO_BUDGETS=1 cargo test`
/// records instead, so the change shows up as a reviewable line in the PR.
/// Same convention as the JS scenarios in src/test/io-budgets.json.
pub fn expect_io_budget(scenario: &str, measured: IoBudget) {
    let _guard = BUDGETS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut budgets = read_budgets();

    if std::env::var_os("UPDATE_IO_BUDGETS").is_some() {
        budgets.insert(scenario.to_string(), measured);
        let mut json = serde_json::to_string_pretty(&budgets).unwrap();
        json.push('\n');
        fs::write(BUDGETS_PATH, json).unwrap();
        return;
    }

    let Some(budget) = budgets.get(scenario) else {
        panic!(
            "No I/O budget recorded for \"{scenario}\".\nMeasured {measured:?}.\n\
             Record it with UPDATE_IO_BUDGETS=1 cargo test and commit the result."
        );
    };
    assert!(
        budget.counts() == measured.counts(),
        "I/O budget \"{scenario}\" changed.\n  budget:   {budget:?}\n  measured: {measured:?}\n\
         If this is intended, re-record with UPDATE_IO_BUDGETS=1 and explain the change\n\
         in the commit message. If it is not, the walker now touches the disk more (or\n\
         less) than it did for the same tree."
    );
}

fn read_budgets() -> BTreeMap<String, IoBudget> {
    match fs::read_to_string(BUDGETS_PATH) {
        Ok(text) => serde_json::from_str(&text).expect("io-budgets.json does not parse"),
        Err(_) => BTreeMap::new(),
    }
}
