use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(target_os = "linux")]
use std::sync::atomic::AtomicUsize;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;

/// Global cancellation flag — set by signal handlers.
static CANCELLED: AtomicBool = AtomicBool::new(false);

#[cfg(not(windows))]
use jwalk::WalkDirGeneric;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use serde::Serialize;

#[cfg(windows)]
mod usn_journal;

#[cfg(windows)]
mod mft;

mod sample;
mod clone_attrs;
mod dev_artifacts;
mod index_line;
#[cfg(not(windows))]
mod hardlinks;
#[cfg(test)]
mod test_support;

use clone_attrs::{CloneAttrs, CloneGroupSummary, CloneGroups, CloneTotals, OUTSIDE_ROOTS};

#[cfg(windows)]
use windows_sys::Win32::Foundation::{GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW,
    FindNextFileW, GetCompressedFileSizeW, FIND_FIRST_EX_LARGE_FETCH,
    FILE_ATTRIBUTE_COMPRESSED, FILE_ATTRIBUTE_DEVICE, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_SPARSE_FILE,
    INVALID_FILE_SIZE, WIN32_FIND_DATAW,
};

// Generous internal caps — large enough that no user reasonably hits them,
// small enough that a multi-million-file scan stays memory-safe. The full
// per-file index on disk (NDJSON) is the source of truth for the treemap.
const DEFAULT_TOP_FILE_LIMIT: usize = 5_000;
const DEFAULT_TOP_DIRECTORY_LIMIT: usize = 10_000;
const TOP_EXTENSION_LIMIT: usize = 12;
const SNAPSHOT_INTERVAL_MS: u128 = 200;
/// Must match `FILES_PER_FOLDER` in folderTreeWorkerRuntime.ts — the UI
/// code expects at most this many top files per folder when rendering
/// the Folders tab. Trimmed to this cap after every insert that
/// overflows the soft 2x bound.
const FOLDER_TREE_FILES_PER_PARENT: usize = 200;
const WINDOWS_TO_UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;

#[derive(Debug, Clone)]
struct ScanInput {
    root_path: PathBuf,
    top_file_limit: usize,
    top_directory_limit: usize,
    index_output: Option<PathBuf>,
    /// Optional previous scan's index. When provided, directories whose
    /// mtime matches the baseline have their subtree inherited instead
    /// of walked — typical 10-50x speedup on mostly-idle drives.
    baseline_index: Option<PathBuf>,
    /// Optional sidecar output for the pre-built folder tree. When set,
    /// the scanner accumulates per-parent top-N files + per-parent
    /// subdir totals during emit and writes a JSON.gz sidecar at the
    /// end. Node reads the sidecar directly on Folders-tab load, which
    /// avoids a second multi-minute pass + ~4 GB working set through a
    /// worker thread (which was OOM-ing even at 8 GB heap on drives
    /// with 8M+ records).
    folder_tree_output: Option<PathBuf>,
    /// Compact Dev Artifacts sidecar written from the index-writer thread.
    dev_artifacts_output: Option<PathBuf>,
    /// The previous scan's file count, for the files-based progress bar.
    /// The Unix walker takes this instead of reading the baseline index,
    /// which it has no other use for.
    #[cfg_attr(windows, allow(dead_code))]
    expected_total_files: Option<u64>,
}

/// Disk touches one scan makes. The visit-once tests check these against
/// `io-budgets.json`, and `run()` logs them after the walk.
///
/// - `readdir_calls`: directory listings (jwalk's `read_dir`, `FindFirstFileExW`).
/// - `stat_calls`: per-path metadata reads (`symlink_metadata`, `metadata`,
///   `GetCompressedFileSizeW`).
/// - `baseline_bytes_read`: compressed bytes read from `--baseline-index`.
///   Divided by the file's size, it is the number of passes over it.
///
/// Not counted: `canonicalize` of the root, jwalk's own `symlink_metadata`
/// of the root, and the MFT read.
#[derive(Default)]
struct IoStats {
    readdir_calls: AtomicU64,
    stat_calls: AtomicU64,
    baseline_bytes_read: AtomicU64,
}

impl IoStats {
    fn count_readdir(&self) {
        self.readdir_calls.fetch_add(1, Ordering::Relaxed);
    }

    fn count_stat(&self) {
        self.stat_calls.fetch_add(1, Ordering::Relaxed);
    }

    fn readdir_calls(&self) -> u64 {
        self.readdir_calls.load(Ordering::Relaxed)
    }

    fn stat_calls(&self) -> u64 {
        self.stat_calls.load(Ordering::Relaxed)
    }

    fn baseline_bytes_read(&self) -> u64 {
        self.baseline_bytes_read.load(Ordering::Relaxed)
    }
}

/// Counts the bytes read from the baseline index into `IoStats`.
#[cfg_attr(not(windows), allow(dead_code))]
struct BaselineReader {
    file: File,
    io: Arc<IoStats>,
}

impl io::Read for BaselineReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.file.read(buf)?;
        self.io
            .baseline_bytes_read
            .fetch_add(read as u64, Ordering::Relaxed);
        Ok(read)
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn open_baseline(path: &Path, io: &Arc<IoStats>) -> io::Result<BufReader<GzDecoder<BufReader<BaselineReader>>>> {
    let file = File::open(path)?;
    let reader = BaselineReader {
        file,
        io: Arc::clone(io),
    };
    Ok(BufReader::new(GzDecoder::new(BufReader::new(reader))))
}

/// Empty options struct — kept for IPC contract stability with the JS side.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanOptions {}

// IndexEntry and DirIndexEntry used to be serde-serialized; the
// hand-rolled JSON writer in the gzip thread now emits equivalent
// lines directly via `append_json_escaped` + `append_u64_decimal`,
// so these structs were retired.

/// Background-thread gzip writer. Main emit thread only does state
/// updates + sends owned records over a bounded channel; a dedicated
/// writer thread pulls from the channel, serializes to JSON, feeds
/// through `GzEncoder` at `Compression::fast()` (level 1), and writes
/// to the file.
///
/// Rationale: emit was ~50% CPU / 50% blocked before — the blocking
/// was largely per-record syscall overhead through the gzip encoder's
/// small internal buffer flushes. Moving writes off the hot path lets
/// the main thread run uninterrupted at 100% CPU on state + rollup,
/// while the writer thread handles serialization + compression
/// concurrently on a separate core. On an 8-core box this alone should
/// cut emit by ~40-50%.
///
/// Phase C extensibility: the channel accepts records from any thread.
/// A future parallel-sharded emit can spawn N emit threads each pushing
/// into this single channel (writer remains one thread because gzip
/// compression is inherently sequential on one stream).
struct IndexWriter {
    tx: Option<crossbeam_channel::Sender<IndexWriteMsg>>,
    /// Writer thread result plus the APFS clone groups it collected
    /// (returned even when gzip failed, so the Dev sidecar keeps them).
    handle: Option<std::thread::JoinHandle<(io::Result<()>, CloneGroups)>>,
    dev_acc: Option<Arc<Mutex<dev_artifacts::DevArtifactAcc>>>,
    dev_output: Option<PathBuf>,
    scan_root: String,
}

enum IndexWriteMsg {
    File {
        path: String,
        size: u64,
        mtime: u64,
        extra_hardlink: bool,
        /// APFS private size / clone id (macOS walker only).
        clone: Option<CloneAttrs>,
    },
    Dir { path: String, mtime: u64 },
    Finish,
}

impl IndexWriter {
    fn create(path: &Path, dev_output: Option<PathBuf>, scan_root: String) -> io::Result<Self> {
        let file = File::create(path)?;
        let dev_acc = dev_output
            .as_ref()
            .map(|_| Arc::new(Mutex::new(dev_artifacts::DevArtifactAcc::new())));
        let dev_acc_thread = dev_acc.clone();
        // Bounded so the emit thread back-pressures naturally when the
        // writer falls behind (very rare in practice — gzip at level 1
        // on JSON runs at ~200-500 MB/s, far above our record
        // generation rate). 32k entry cap ≈ 6-8 MB of queued record
        // strings, plenty of headroom without being unbounded.
        let (tx, rx) = crossbeam_channel::bounded::<IndexWriteMsg>(32_768);
        let handle = std::thread::Builder::new()
            .name("diskhound-index-writer".to_string())
            .spawn(move || -> (io::Result<()>, CloneGroups) {
                // Full-clone groups keyed by APFS clone id. Lives on this
                // thread because Dev root classification happens here.
                let mut clone_groups = CloneGroups::new();
                let result = (|| -> io::Result<()> {
                // 1 MB buffer between gzip encoder and File — reduces
                // write syscalls from thousands per second to tens.
                let buffered = BufWriter::with_capacity(1 << 20, file);
                // Compression::fast() is level 1 — roughly 3-5× faster
                // than default (level 6) with ~25% larger output. On a
                // 250 MB index, that's 315 MB instead. Trivial disk
                // cost vs the CPU savings on emit.
                let mut encoder = GzEncoder::new(buffered, Compression::fast());
                // Reusable line buffer — avoids re-allocating a Vec
                // for every record. Grown-once-reused keeps allocator
                // churn near zero in the hot path.
                let mut line = Vec::with_capacity(512);
                while let Ok(msg) = rx.recv() {
                    match msg {
                        IndexWriteMsg::File {
                            path,
                            size,
                            mtime,
                            extra_hardlink,
                            clone,
                        } => {
                            line.clear();
                            // Hand-rolled `{"p":"<esc>","s":N,"m":M}\n`.
                            // serde_json::to_writer was doing 5-8 μs
                            // per record on our schema — dominated by
                            // allocator overhead from the internal
                            // Serializer state machine. For 7M records
                            // that's 35-60 s just in the writer. This
                            // bespoke path is ~0.5-1 μs per record
                            // (5-10× speedup) so the writer stops
                            // being the main emit bottleneck.
                            line.extend_from_slice(br#"{"p":""#);
                            append_json_escaped(&mut line, path.as_bytes());
                            line.extend_from_slice(br#"","s":"#);
                            append_u64_decimal(&mut line, size);
                            line.extend_from_slice(br#","m":"#);
                            append_u64_decimal(&mut line, mtime);
                            if extra_hardlink {
                                line.extend_from_slice(br#","h":1"#);
                            }
                            // APFS clones: `v` = private bytes (what
                            // deleting this file alone frees; the rest
                            // of `s` is shared with another clone),
                            // `k` = shares blocks with a clone. Only
                            // clone files carry them. Field order is
                            // fixed (h, v, k) so the TS / Rust
                            // fast-path parsers stay regex-cheap.
                            if let Some(attrs) = clone.as_ref().filter(|a| a.may_share()) {
                                if let Some(private) = attrs.private_size {
                                    let private = private.min(size);
                                    if private < size {
                                        line.extend_from_slice(br#","v":"#);
                                        append_u64_decimal(&mut line, private);
                                    }
                                }
                                line.extend_from_slice(br#","k":1"#);
                            }
                            line.extend_from_slice(b"}\n");
                            encoder.write_all(&line)?;
                            let dev_root = match &dev_acc_thread {
                                Some(acc) => acc
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .add(&path, size, extra_hardlink, clone.as_ref()),
                                None => None,
                            };
                            if let (Some(attrs), false) = (clone.as_ref(), extra_hardlink) {
                                clone_groups.add(attrs, size, dev_root.unwrap_or(OUTSIDE_ROOTS));
                            }
                        }
                        IndexWriteMsg::Dir { path, mtime } => {
                            line.clear();
                            line.extend_from_slice(br#"{"p":""#);
                            append_json_escaped(&mut line, path.as_bytes());
                            line.extend_from_slice(br#"","t":"d","m":"#);
                            append_u64_decimal(&mut line, mtime);
                            line.extend_from_slice(b"}\n");
                            encoder.write_all(&line)?;
                        }
                        IndexWriteMsg::Finish => break,
                    }
                }
                let mut buffered = encoder.finish()?;
                buffered.flush()?;
                Ok(())
                })();
                (result, clone_groups)
            })?;
        Ok(IndexWriter {
            tx: Some(tx),
            handle: Some(handle),
            dev_acc,
            dev_output,
            scan_root,
        })
    }

    /// Clone the underlying Sender for use by parallel emit workers.
    /// Workers push IndexWriteMsg directly, bypassing the &mut self
    /// methods below, so N emit threads can feed the one gzip writer
    /// concurrently. None if the writer thread has already been
    /// shut down via `finish`.
    fn tx_clone(&self) -> Option<crossbeam_channel::Sender<IndexWriteMsg>> {
        self.tx.clone()
    }

    fn write_dir_entry(&mut self, path: &str, mtime: u64) -> io::Result<()> {
        if let Some(tx) = self.tx.as_ref() {
            tx.send(IndexWriteMsg::Dir {
                path: path.to_string(),
                mtime,
            })
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "index writer thread exited"))?;
        }
        Ok(())
    }

    fn write_entry(
        &mut self,
        path: &str,
        size: u64,
        mtime: u64,
        extra_hardlink: bool,
        clone: Option<CloneAttrs>,
    ) -> io::Result<()> {
        if let Some(tx) = self.tx.as_ref() {
            tx.send(IndexWriteMsg::File {
                path: path.to_string(),
                size,
                mtime,
                extra_hardlink,
                clone,
            })
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "index writer thread exited"))?;
        }
        Ok(())
    }

    /// Signal the writer thread to finish pending messages, close the
    /// gzip stream cleanly, and flush to disk. Blocks on the join so
    /// the caller knows the file is complete before returning. Also
    /// returns the clone-group summary when any APFS clones were seen.
    fn finish(mut self) -> (io::Result<()>, Option<CloneGroupSummary>) {
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(IndexWriteMsg::Finish);
            drop(tx);
        }
        let (join_err, clone_groups) = if let Some(handle) = self.handle.take() {
            match handle.join() {
                Ok((result, groups)) => (result.err(), Some(groups)),
                Err(_) => (Some(io::Error::other("index writer thread panicked")), None),
            }
        } else {
            (None, None)
        };
        let clone_summary = clone_groups
            .as_ref()
            .map(CloneGroups::summary)
            .filter(|summary| summary.groups > 0);
        // Write the Dev sidecar even if gzip finish failed — classify
        // already ran on every file the writer accepted.
        if let (Some(out), Some(acc)) = (self.dev_output.take(), self.dev_acc.take()) {
            let guard = acc.lock().unwrap_or_else(|e| e.into_inner());
            match dev_artifacts::write_sidecar(&out, &self.scan_root, &guard, clone_groups.as_ref()) {
                Ok(()) => eprintln!(
                    "[diskhound-native-scanner] dev-artifacts sidecar: wrote {} ({} roots)",
                    out.display(),
                    guard.root_count()
                ),
                Err(err) => eprintln!(
                    "[diskhound-native-scanner] dev-artifacts sidecar: write failed ({err})"
                ),
            }
        }
        let result = match join_err {
            Some(err) => Err(err),
            None => Ok(()),
        };
        (result, clone_summary)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanFileRecord {
    path: String,
    name: String,
    parent_path: String,
    extension: String,
    size: u64,
    modified_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryHotspot {
    path: String,
    size: u64,
    file_count: u64,
    depth: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionBucket {
    extension: String,
    size: u64,
    count: u64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ScanStatus {
    Running,
    Done,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ScanEngine {
    NativeSidecar,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanSnapshot {
    status: ScanStatus,
    engine: ScanEngine,
    root_path: Option<String>,
    scan_options: ScanOptions,
    started_at: Option<u64>,
    finished_at: Option<u64>,
    elapsed_ms: u64,
    files_visited: u64,
    directories_visited: u64,
    skipped_entries: u64,
    bytes_seen: u64,
    largest_files: Vec<ScanFileRecord>,
    hottest_directories: Vec<DirectoryHotspot>,
    top_extensions: Vec<ExtensionBucket>,
    error_message: Option<String>,
    last_updated_at: u64,
    /// Which phase of the scan we're in. Added so the UI can stop
    /// showing a misleading byte-based progress % during the emit's
    /// tail where pre-sorted-by-size-desc means bytes plateau at ~98%
    /// while the last few million small files still stream through.
    scan_phase: ScanPhase,
    /// Set after MFT enumeration; lets the UI render a files-based
    /// progress bar (emitted_files / expected_total_files) during the
    /// indexing phase when the byte-based bar is stuck near 100%.
    /// None for the walker path where this number isn't known upfront.
    expected_total_files: Option<u64>,
    /// APFS clone / private-size tallies (macOS walker). Mirrors
    /// `ScanStorageAccounting` in src/shared/contracts.ts.
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_accounting: Option<StorageAccountingOut>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageAccountingOut {
    measured_files: u64,
    measured_bytes: u64,
    clone_files: u64,
    clone_bytes: u64,
    clone_private_bytes: u64,
    clone_duplicate_bytes: Option<u64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    approximate: bool,
}

/// Coarse-grained scan progress phases. The UI switches status copy
/// and progress-bar denominator based on this. Scanner sets it at each
/// phase transition via `state.scan_phase = ScanPhase::X`.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ScanPhase {
    /// Pre-work: parsing args, loading baseline.
    Starting,
    /// MFT read / path build (MFT fast path only).
    ReadingMetadata,
    /// Actively walking or emitting records into scan state.
    Indexing,
    /// Post-walk work: inherited-file streaming, final gzip flush,
    /// `Done` snapshot about to fire.
    Finalizing,
    Complete,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Message {
    Progress { snapshot: ScanSnapshot },
    Done { snapshot: ScanSnapshot },
    Error { message: String },
}

struct ScanState {
    input: ScanInput,
    root_path_string: String,
    started_at_ms: u64,
    started_at_instant: Instant,
    files_visited: u64,
    directories_visited: u64,
    skipped_entries: u64,
    bytes_seen: u64,
    largest_files: Vec<ScanFileRecord>,
    hottest_directories: Vec<DirectoryHotspot>,
    directory_totals: HashMap<String, DirectoryHotspot>,
    extension_totals: HashMap<String, ExtensionBucket>,
    /// Per-parent top-N files for the folder-tree sidecar. Only populated
    /// when `input.folder_tree_output` is Some. Values are capped at
    /// `FOLDER_TREE_FILES_PER_PARENT` after periodic sort+truncate so the
    /// per-folder memory stays bounded even for node_modules-style giant
    /// directories. Each tuple is (name, size, mtime).
    folder_tree_files: HashMap<String, Vec<(String, u64, u64)>>,
    last_emit_elapsed_ms: u128,
    index_writer: Option<IndexWriter>,
    /// Baseline used by the Phase-1 mtime-skip optimization. None when the
    /// caller didn't pass --baseline-index or when parsing it failed.
    #[cfg_attr(not(windows), allow(dead_code))]
    baseline: Option<Baseline>,
    /// Directory paths (normalized) whose subtrees were inherited from the
    /// baseline during the walk. After the walk completes we do one more
    /// streaming pass over the baseline to copy file records under these
    /// prefixes into the new index + update top-N file and extension stats.
    inherited_prefixes: Vec<String>,
    /// Diagnostic counters — emitted on stderr so we can confirm the fast
    /// path actually fires in production builds.
    inherited_dirs: u64,
    inherited_files: u64,
    /// When true, Running-status `snapshot()` calls skip the expensive
    /// clone of largest_files + hottest_directories + extension tallies
    /// and emit a lite counters-only snapshot instead. The MFT emit path
    /// enables this because all records are pre-sorted by size descending
    /// — once the first 5k records fill largest_files, nothing changes
    /// for the rest of the emit, so the UI doesn't lose information. The
    /// payload drops from ~1-2 MB per emit to ~200 bytes, which unblocks
    /// the scanner from stdout pipe backpressure (Node's readline has to
    /// accumulate full lines before dispatching, and a 1 MB line through
    /// a 64 KB Windows pipe is where the scanner was stalling).
    emit_lite_snapshots: bool,
    /// Current scan phase. Mirrored into each snapshot.
    scan_phase: ScanPhase,
    /// Expected total file count (populated from MFT records_kept after
    /// MFT enumeration). None for walker path.
    expected_total_files: Option<u64>,
    /// When true, `rollup_directory_size` updates only the
    /// `directory_totals` HashMap and skips the `upsert_ranked_directory`
    /// maintenance of `hottest_directories`. The MFT emit path enables
    /// this because pre-sorting files by size means every file rolls up
    /// into the same handful of ancestor directories, and the legacy
    /// upsert does a full 10000-entry sort on every rollup — trillions
    /// of ops. When this flag flips back to false, call
    /// `finalize_hottest_directories()` to rebuild the top-N from the
    /// HashMap in O(N_dirs log N_dirs) total, ~100× cheaper overall.
    defer_hottest_dir_ranking: bool,
    /// APFS clone / private-size sums over every recorded file that
    /// came with clone attributes (macOS walker only).
    clone_totals: CloneTotals,
    /// Full-clone dedupe from the index writer; set just before Done.
    clone_group_summary: Option<CloneGroupSummary>,
    /// Disk touches so far. Shared with walker threads.
    io: Arc<IoStats>,
}

impl ScanState {
    fn new(
        input: ScanInput,
        root_path_string: String,
        index_writer: Option<IndexWriter>,
        baseline: Option<Baseline>,
        io: Arc<IoStats>,
    ) -> Self {
        let mut directory_totals = HashMap::new();
        directory_totals.insert(
            root_path_string.clone(),
            DirectoryHotspot {
                path: root_path_string.clone(),
                size: 0,
                file_count: 0,
                depth: 0,
            },
        );
        ScanState {
            largest_files: Vec::with_capacity(input.top_file_limit),
            hottest_directories: Vec::with_capacity(input.top_directory_limit),
            input,
            root_path_string,
            started_at_ms: unix_timestamp_ms(SystemTime::now()),
            started_at_instant: Instant::now(),
            files_visited: 0,
            directories_visited: 0,
            skipped_entries: 0,
            bytes_seen: 0,
            directory_totals,
            extension_totals: HashMap::new(),
            folder_tree_files: HashMap::new(),
            last_emit_elapsed_ms: 0,
            index_writer,
            baseline,
            inherited_prefixes: Vec::new(),
            inherited_dirs: 0,
            inherited_files: 0,
            emit_lite_snapshots: false,
            scan_phase: ScanPhase::Starting,
            expected_total_files: None,
            defer_hottest_dir_ranking: false,
            clone_totals: CloneTotals::default(),
            clone_group_summary: None,
            io,
        }
    }
}

/// Preloaded baseline from a previous scan's NDJSON index — streaming
/// variant that keeps per-directory metadata in memory but NOT individual
/// file records. For a drive with 7M files this holds ~150 MB of state
/// instead of ~2 GB, because cumulative file counts + sizes are O(dirs)
/// rather than O(files).
///
/// During the walk we use this to cheaply decide "is this dir's mtime
/// unchanged" and "how many files/bytes live under this dir" so running
/// progress counters stay accurate. After the walk we stream the full
/// baseline index a second time to copy actual file records into the new
/// index file for the subtrees we inherited.
///
/// Windows only in practice: the Unix walker never inherits, so it never
/// loads one (see `load_baseline`).
#[cfg_attr(not(windows), allow(dead_code))]
struct Baseline {
    baseline_path: PathBuf,
    dir_mtimes: HashMap<String, u64>,
    /// Recursive total file count under each directory (bubbled up from
    /// leaves during load). Indexed by normalized dir path.
    dir_file_counts: HashMap<String, u64>,
    /// Recursive total bytes under each directory.
    dir_total_sizes: HashMap<String, u64>,
    /// Set of all dir paths present in the baseline — used for re-emitting
    /// dir entries under inherited subtrees in the new index.
    dirs: HashSet<String>,
    /// Extra NTFS names (`h:1`) from the previous index. The walker cannot
    /// see link counts, so a re-walk of a touched directory keeps this flag
    /// when the same path is still present. Windows only: the Unix walker
    /// reads link counts itself, and a pnpm-heavy index can carry millions
    /// of `h:1` paths.
    #[cfg(windows)]
    extra_hardlink_paths: HashSet<String>,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl Baseline {
    /// First pass over the baseline NDJSON: collect per-directory metadata
    /// (mtimes + cumulative file counts + cumulative bytes) without
    /// materializing individual file records. File data is re-streamed in
    /// `stream_inherited_files_into` after the walk completes.
    ///
    /// Calls `on_heartbeat` every `HEARTBEAT_LINES` lines so the caller
    /// can emit Progress snapshots during baseline load — on a drive with
    /// millions of prior-scan records this phase used to take 20-40s of
    /// stdout silence, long enough for the renderer's "0 files" display
    /// to look dead.
    fn load_metadata<F: FnMut(u64)>(
        path: &Path,
        io: &Arc<IoStats>,
        mut on_heartbeat: F,
    ) -> Option<Baseline> {
        const HEARTBEAT_LINES: u64 = 100_000;
        let reader = open_baseline(path, io).ok()?;

        let mut dir_mtimes: HashMap<String, u64> = HashMap::new();
        let mut dirs: HashSet<String> = HashSet::new();
        let mut dir_file_counts: HashMap<String, u64> = HashMap::new();
        let mut dir_total_sizes: HashMap<String, u64> = HashMap::new();
        #[cfg(windows)]
        let mut extra_hardlink_paths: HashSet<String> = HashSet::new();
        let mut lines_read: u64 = 0;
        // Separately count files so we can detect truncated baselines
        // — one of 0.4.3's fixed bugs (strong_count=2 skipping the
        // post-walk stream) silently wrote index files with dir entries
        // but almost no file entries. Rescans against those baselines
        // THEN inherited the bogus 1968-file count into a fresh
        // truncated index, self-propagating the damage. Tracking
        // file_records separately lets us reject these at load time.
        let mut file_records: u64 = 0;

        // Hand-rolled field extraction — same keys the IndexWriter
        // emits (`p`/`s`/`m`/`t`/`h`). Owned `String` for `p` after
        // unescape: Windows paths contain `\\` in the NDJSON source,
        // and a borrowed slice of the raw line is the wrong path
        // (v0.3.5–v0.3.10 serde `&str` bug: every backslash record
        // failed, Phase-1 inheritance saw `dirs=0`).
        for line in reader.lines() {
            let Ok(line) = line else { continue };
            if line.is_empty() {
                continue;
            }
            lines_read += 1;
            if lines_read % HEARTBEAT_LINES == 0 {
                on_heartbeat(lines_read);
            }

            let Some(rec) = index_line::parse_index_line(&line) else {
                continue;
            };
            let is_dir = rec.is_dir;
            let normalized = normalize_path(Path::new(&rec.path));

            if is_dir {
                let mtime = rec.mtime.unwrap_or(0);
                dir_mtimes.insert(normalized.clone(), mtime);
                dirs.insert(normalized);
                continue;
            }

            let Some(size) = rec.size else {
                continue;
            };
            file_records += 1;
            let extra_hardlink = rec.extra_hardlink;
            #[cfg(windows)]
            if extra_hardlink {
                extra_hardlink_paths.insert(normalized.clone());
            }
            let occupancy = if extra_hardlink { 0 } else { size };

            // Bubble the file's size/count up to every ancestor directory.
            // This gives us O(1) "how much is under dir D" lookups during
            // the walk without having to store individual file records.
            let mut current = Path::new(&rec.path).parent().map(normalize_path);
            while let Some(dir) = current {
                if dir.is_empty() {
                    break;
                }
                *dir_file_counts.entry(dir.clone()).or_insert(0) += 1;
                *dir_total_sizes.entry(dir.clone()).or_insert(0) += occupancy;
                let parent = Path::new(&dir).parent().map(normalize_path);
                if parent.as_deref().map(str::is_empty).unwrap_or(true)
                    || parent.as_deref() == Some(dir.as_str())
                {
                    break;
                }
                current = parent;
            }
        }

        // Final heartbeat so the caller sees the full line count.
        on_heartbeat(lines_read);

        // Truncated-baseline detection. Real NTFS filesystems have more
        // files than directories (typically 5-50× more). An index with
        // file_records < dirs.len() was almost certainly written by a
        // broken scan — either the strong_count=2 bug from 0.4.1–0.4.2
        // that skipped the post-walk stream, or a crash mid-write.
        // Using such a baseline for inheritance PROPAGATES the
        // truncation: the rescan inherits the few files present,
        // writes a new index with those few files + 1 fresh walk
        // worth, and the next rescan inherits that too. User-visible
        // symptom: scan results show "24 dirs, 1968 files" on a 7M-file
        // drive.
        //
        // Threshold: file_records must be at least 50 % of dirs.len()
        // to consider the baseline usable. That's well below a
        // realistic floor (the worst real filesystems have ~3-5 files
        // per dir) so we only trip on genuinely broken indices. On a
        // rejection the scanner falls back to a full walk — slow but
        // correct — and writes a fresh, usable index for next time.
        let dir_count = dirs.len() as u64;
        if dir_count > 0 && file_records * 2 < dir_count {
            eprintln!(
                "[diskhound-native-scanner] baseline REJECTED as truncated: \
                 dirs={} file_records={} (ratio {:.4}) — forcing a full walk. \
                 This is self-healing: the walk will write a complete new index.",
                dir_count,
                file_records,
                if dir_count > 0 { file_records as f64 / dir_count as f64 } else { 0.0 }
            );
            return None;
        }
        eprintln!(
            "[diskhound-native-scanner] baseline accepted: dirs={} file_records={} (ratio {:.2})",
            dir_count,
            file_records,
            if dir_count > 0 { file_records as f64 / dir_count as f64 } else { 0.0 }
        );

        Some(Baseline {
            baseline_path: path.to_path_buf(),
            dir_mtimes,
            dir_file_counts,
            dir_total_sizes,
            dirs,
            #[cfg(windows)]
            extra_hardlink_paths,
        })
    }

    /// Return all directory paths at or under the given root. Used when we
    /// inherit a subtree so we can re-emit dir entries in the new index.
    fn subtree_dirs(&self, dir_path: &str) -> Vec<String> {
        let prefix = if dir_path.ends_with(std::path::MAIN_SEPARATOR) {
            dir_path.to_string()
        } else {
            format!("{}{}", dir_path, std::path::MAIN_SEPARATOR)
        };
        self.dirs
            .iter()
            .filter(|d| d.as_str() != dir_path && d.starts_with(&prefix))
            .cloned()
            .collect()
    }
}

/// Second pass: stream the baseline NDJSON and copy file records (not
/// dir records — those were emitted during the walk) into the new index
/// for any inherited subtree. Also updates the scan's `largest_files`
/// and `extension_totals` so post-inherit snapshots are complete.
///
/// Extracted as a free function instead of an impl method so it can
/// borrow state mutably without fighting the borrow checker against a
/// live &self.baseline borrow.
#[cfg_attr(not(windows), allow(dead_code))]
fn stream_inherited_files_into(
    baseline_path: &Path,
    inherited_prefixes: &[String],
    state: &mut ScanState,
) -> io::Result<()> {
    if inherited_prefixes.is_empty() {
        return Ok(());
    }

    // Pre-compute path-separator-suffixed prefixes so we don't mismatch
    // `/foo/bar` against `/foo/barbaz/thing.txt`.
    let normalized_prefixes: Vec<(String, String)> = inherited_prefixes
        .iter()
        .map(|p| {
            let with_sep = if p.ends_with(std::path::MAIN_SEPARATOR) {
                p.clone()
            } else {
                format!("{}{}", p, std::path::MAIN_SEPARATOR)
            };
            (p.clone(), with_sep)
        })
        .collect();

    let reader = open_baseline(baseline_path, &state.io)?;

    // Emit a progress snapshot every N file records processed. The
    // inherited stream can be 7 M+ file records on a rescan of a
    // big drive, and without periodic emits the UI sits on its
    // pre-stream snapshot with no tile movement for the full
    // stream duration (observed as "no tiles streaming" on
    // non-elevated rescans). 50 K is a good cadence — at typical
    // stream rate of ~1 M records/sec that's ~50 ms between emits,
    // which is thinly below the 200 ms snapshot-interval throttle
    // inside maybe_emit_progress, so only the snapshot-interval
    // cap actually limits emissions.
    const EMIT_EVERY_N_FILES: u64 = 50_000;
    let mut files_since_last_emit: u64 = 0;

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        if line.is_empty() {
            continue;
        }
        let Some(rec) = index_line::parse_index_line(&line) else {
            continue;
        };
        if rec.is_dir {
            // Dir entries were already emitted during the walk's inherit
            // path, so we don't re-emit them here.
            continue;
        }
        let Some(size) = rec.size else {
            continue;
        };
        let path_str = rec.path.as_str();

        let normalized = normalize_path(Path::new(path_str));
        let under_inherit = normalized_prefixes
            .iter()
            .any(|(eq, prefix)| normalized == *eq || normalized.starts_with(prefix.as_str()));
        if !under_inherit {
            continue;
        }

        let mtime = rec.mtime.unwrap_or(0);
        let extra_hardlink = rec.extra_hardlink;

        let name = Path::new(path_str)
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("")
            .to_string();
        let extension = file_extension(&name);

        // Write to new index so the index remains a complete baseline for
        // the NEXT scan.
        if let Some(writer) = state.index_writer.as_mut() {
            let _ = writer.write_entry(&normalized, size, mtime, extra_hardlink, None);
        }

        // Update top-N + extension aggregates. Note: directory_totals +
        // bytes_seen were updated at inherit time in the walk using the
        // precomputed dir aggregates, so we skip those here to avoid
        // double-counting.
        let parent = Path::new(path_str)
            .parent()
            .map(normalize_path)
            .unwrap_or_default();
        let file_record = ScanFileRecord {
            path: normalized,
            name: name.clone(),
            parent_path: parent.clone(),
            extension: extension.clone(),
            size,
            modified_at: mtime,
        };
        if !extra_hardlink {
            upsert_ranked_file(&mut state.largest_files, file_record, state.input.top_file_limit);
            rollup_extension(&mut state.extension_totals, &extension, size);
        }

        // Populate the folder-tree sidecar accumulator. Walker's
        // inheritance branch doesn't call `record_file` (which is where
        // `folder_tree_files` is normally filled), so without this the
        // Folders-tab sidecar was written empty on every
        // rescan-vs-unchanged-drive. That cascaded: each subsequent
        // rescan's baseline sidecar was also empty, and we'd happily
        // copy the empty baseline forward via the sidecar short-circuit
        // — users saw "This folder appears empty in the scan index"
        // for every drill-in despite a fully-populated NDJSON index.
        if state.input.folder_tree_output.is_some() {
            let list = state
                .folder_tree_files
                .entry(parent)
                .or_insert_with(Vec::new);
            list.push((name, size, mtime));
            if list.len() > FOLDER_TREE_FILES_PER_PARENT * 2 {
                list.sort_by(|a, b| b.1.cmp(&a.1));
                list.truncate(FOLDER_TREE_FILES_PER_PARENT);
            }
        }

        // Periodic progress emit so tiles stream into the UI during
        // the long inherited-file stream. The maybe_emit_progress
        // throttle (200 ms) ensures we don't spam stdout; this
        // counter is just a cheap way to avoid checking the clock on
        // every single record.
        files_since_last_emit += 1;
        if files_since_last_emit >= EMIT_EVERY_N_FILES {
            files_since_last_emit = 0;
            let _ = maybe_emit_progress(state);
        }
    }

    Ok(())
}

fn main() {
    // Register signal handler for graceful cancellation.
    // On Windows, Node sends SIGTERM which triggers CTRL_CLOSE_EVENT.
    // On Unix, SIGTERM and SIGINT are caught.
    register_signal_handler();

    // Dispatch to USN-related subcommands before the standard scan path
    // so we don't require --root in those modes.
    let raw_args: Vec<String> = std::env::args().skip(1).collect();

    let is_journal_mode = raw_args.iter().any(|a| a == "--mode=journal")
        || matches_flag(&raw_args, "--mode", "journal");
    let is_cursor_query = raw_args.iter().any(|a| a == "--mode=query-cursor")
        || matches_flag(&raw_args, "--mode", "query-cursor");
    let is_sample = raw_args.iter().any(|a| a == "--mode=sample")
        || matches_flag(&raw_args, "--mode", "sample");

    if is_sample {
        if let Err(error) = sample::run_sample_once() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }

    if is_journal_mode || is_cursor_query {
        #[cfg(windows)]
        {
            let result = if is_cursor_query {
                run_cursor_query(&raw_args)
            } else {
                run_journal_mode(&raw_args)
            };
            if let Err(error) = result {
                let _ = emit_message(&Message::Error { message: error });
                std::process::exit(1);
            }
            return;
        }
        #[cfg(not(windows))]
        {
            let _ = emit_message(&Message::Error {
                message: "USN journal mode is Windows-only".to_string(),
            });
            std::process::exit(1);
        }
    }

    if let Err(error) = run() {
        let _ = emit_message(&Message::Error {
            message: error.to_string(),
        });
        std::process::exit(1);
    }
}

fn matches_flag(args: &[String], name: &str, value: &str) -> bool {
    let mut iter = args.iter();
    while let Some(a) = iter.next() {
        if a == name {
            if let Some(next) = iter.next() {
                if next == value {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(windows)]
fn run_journal_mode(args: &[String]) -> Result<(), String> {
    let mut drive_letter: Option<char> = None;
    let mut cursor: Option<i64> = None;

    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--mode" => {
                // already validated to be "journal"
                let _ = iter.next();
            }
            "--mode=journal" => {}
            "--volume" => {
                let v = iter
                    .next()
                    .ok_or_else(|| String::from("Expected drive letter after --volume"))?;
                let trimmed = v.trim_end_matches(':').trim_end_matches('\\');
                let ch = trimmed
                    .chars()
                    .next()
                    .ok_or_else(|| String::from("Empty --volume"))?;
                drive_letter = Some(ch.to_ascii_uppercase());
            }
            "--cursor" => {
                let v = iter
                    .next()
                    .ok_or_else(|| String::from("Expected USN after --cursor"))?;
                cursor = Some(
                    v.parse::<i64>()
                        .map_err(|_| format!("Invalid --cursor: {v}"))?,
                );
            }
            unknown => return Err(format!("Unknown journal-mode arg: {unknown}")),
        }
    }

    let drive_letter = drive_letter
        .ok_or_else(|| String::from("--volume <drive-letter> required in journal mode"))?;

    usn_journal::run_journal_mode(drive_letter, cursor)
}

#[cfg(windows)]
fn run_cursor_query(args: &[String]) -> Result<(), String> {
    let mut drive_letter: Option<char> = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--mode" => { let _ = iter.next(); }
            "--mode=query-cursor" => {}
            "--volume" => {
                let v = iter
                    .next()
                    .ok_or_else(|| String::from("Expected drive letter after --volume"))?;
                let trimmed = v.trim_end_matches(':').trim_end_matches('\\');
                let ch = trimmed
                    .chars()
                    .next()
                    .ok_or_else(|| String::from("Empty --volume"))?;
                drive_letter = Some(ch.to_ascii_uppercase());
            }
            unknown => return Err(format!("Unknown query-cursor arg: {unknown}")),
        }
    }
    let drive_letter = drive_letter
        .ok_or_else(|| String::from("--volume <drive-letter> required in query-cursor mode"))?;
    usn_journal::query_cursor(drive_letter)
}

fn register_signal_handler() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::{
            SetConsoleCtrlHandler, CTRL_C_EVENT, CTRL_CLOSE_EVENT, CTRL_BREAK_EVENT,
        };

        unsafe extern "system" fn handler(ctrl_type: u32) -> i32 {
            if ctrl_type == CTRL_C_EVENT
                || ctrl_type == CTRL_CLOSE_EVENT
                || ctrl_type == CTRL_BREAK_EVENT
            {
                CANCELLED.store(true, Ordering::SeqCst);
                return 1; // handled
            }
            0
        }

        unsafe { SetConsoleCtrlHandler(Some(handler), 1) };
    }

    #[cfg(not(windows))]
    {
        // Best-effort: catch SIGTERM and SIGINT via a simple flag.
        // Rust's standard library doesn't expose signal handlers directly,
        // so we use a background thread that blocks on the signal.
        // This is a lightweight alternative to adding the ctrlc crate.
        unsafe {
            libc::signal(libc::SIGTERM, sigterm_handler as libc::sighandler_t);
            libc::signal(libc::SIGINT, sigterm_handler as libc::sighandler_t);
        }
    }
}

#[cfg(not(windows))]
extern "C" fn sigterm_handler(_sig: libc::c_int) {
    CANCELLED.store(true, Ordering::SeqCst);
}

fn is_cancelled() -> bool {
    CANCELLED.load(Ordering::Relaxed)
}

fn run() -> Result<(), String> {
    let input = parse_args()?;
    let root_path = input.root_path.canonicalize().map_err(|error| {
        format!(
            "Failed to resolve root path {}: {error}",
            input.root_path.to_string_lossy()
        )
    })?;

    let index_writer = match &input.index_output {
        Some(path) => match IndexWriter::create(
            path,
            input.dev_artifacts_output.clone(),
            input.root_path.to_string_lossy().into_owned(),
        ) {
            Ok(writer) => Some(writer),
            Err(error) => {
                return Err(format!(
                    "Failed to create index output at {}: {error}",
                    path.to_string_lossy()
                ));
            }
        },
        None => None,
    };

    let root_path_string = normalize_path(&root_path);
    let scan_started_ms = unix_timestamp_ms(SystemTime::now());
    let scan_started_instant = Instant::now();

    // Emit an early "running" snapshot BEFORE baseline loading so the
    // renderer sees the scan is alive even when baseline parsing takes
    // a while on huge drives. Without this the UI sat on its pre-scan
    // "0 files, 0 bytes" placeholder for 20-40s during a rescan.
    let _ = emit_message(&Message::Progress {
        snapshot: early_running_snapshot(&root_path_string, scan_started_ms, 0),
    });

    let io = Arc::new(IoStats::default());
    let baseline_load_started = Instant::now();
    let baseline = load_baseline(&input, &io, &root_path_string, scan_started_ms, scan_started_instant);
    if input.baseline_index.is_some() {
        eprintln!(
            "[diskhound-native-scanner] phase: baseline load took {} ms (loaded={}, dirs={}, bytes_read={})",
            baseline_load_started.elapsed().as_millis(),
            baseline.is_some(),
            baseline.as_ref().map(|b| b.dirs.len()).unwrap_or(0),
            io.baseline_bytes_read(),
        );
    }

    let mut state = ScanState::new(
        ScanInput {
            root_path: root_path.clone(),
            ..input
        },
        root_path_string,
        index_writer,
        baseline,
        io,
    );
    state.started_at_ms = scan_started_ms;
    state.started_at_instant = scan_started_instant;

    let walk_started = Instant::now();
    scan_root(&root_path, &mut state)?;
    eprintln!(
        "[diskhound-native-scanner] phase: walk took {} ms (files={}, dirs={}, inherited_dirs={}, inherited_files={}, readdir_calls={}, stat_calls={}, baseline_bytes_read={})",
        walk_started.elapsed().as_millis(),
        state.files_visited,
        state.directories_visited,
        state.inherited_dirs,
        state.inherited_files,
        state.io.readdir_calls(),
        state.io.stat_calls(),
        state.io.baseline_bytes_read(),
    );

    let final_status = if is_cancelled() {
        ScanStatus::Cancelled
    } else {
        ScanStatus::Done
    };

    // Write the folder-tree sidecar BEFORE the Done snapshot so Node
    // can start loading it the instant it sees the scan complete. If
    // writing fails, log and continue — Node falls back to the legacy
    // NDJSON streaming path in that case.
    if matches!(final_status, ScanStatus::Done) {
        if let Err(err) = write_folder_tree_sidecar(&mut state) {
            eprintln!(
                "[diskhound-native-scanner] folder-tree sidecar: write failed ({err}) — Node will fall back to the streaming worker path"
            );
        }
    }

    // Finish the index writer (gzip flush + Dev sidecar) BEFORE Done.
    // Node renames pending-* files as soon as it sees Done. Writing the
    // Dev sidecar after Done raced: the rename missed, and Dev Artifacts
    // fell through to a 1m+ folder-tree classify on a 7M-file C: scan.
    if let Some(writer) = state.index_writer.take() {
        let (result, clone_summary) = writer.finish();
        if let Err(err) = result {
            eprintln!("[diskhound-native-scanner] index writer finish failed ({err})");
        }
        if let Some(summary) = clone_summary {
            eprintln!(
                "[diskhound-native-scanner] clone groups: {} groups, {} duplicate bytes{}",
                summary.groups,
                summary.duplicate_bytes,
                if summary.truncated { " (capped)" } else { "" },
            );
        }
        state.clone_group_summary = clone_summary;
    }

    if matches!(final_status, ScanStatus::Done) {
        state.scan_phase = ScanPhase::Complete;
    }

    emit_message(&Message::Done {
        snapshot: state.snapshot(final_status, None),
    })
    .map_err(|error| error.to_string())
}

/// Loads `--baseline-index` for Phase-1 inheritance. Silent fallback to
/// None on any failure (missing file, corrupt gzip, malformed NDJSON): the
/// scanner just walks everything. Each ~100k-line chunk fires a snapshot
/// carrying the elapsed time, so the UI stays alive during long parses.
#[cfg(windows)]
fn load_baseline(
    input: &ScanInput,
    io: &Arc<IoStats>,
    root_path_string: &str,
    scan_started_ms: u64,
    scan_started_instant: Instant,
) -> Option<Baseline> {
    let path = input.baseline_index.as_deref()?;
    if !path.exists() {
        return None;
    }
    Baseline::load_metadata(path, io, |lines_read| {
        // Stderr line lands in the scanner's log buffer so we can
        // confirm the fast path in production without noise on stdout
        // (stdout is reserved for Progress/Done messages).
        eprintln!(
            "[diskhound-native-scanner] baseline load heartbeat: {} lines",
            lines_read
        );
        let elapsed = scan_started_instant.elapsed().as_millis() as u64;
        let _ = emit_message(&Message::Progress {
            snapshot: early_running_snapshot(root_path_string, scan_started_ms, elapsed),
        });
    })
}

/// The Unix walker never inherits subtrees, so it has no use for the
/// baseline. Parsing it cost a full decompress of the previous index, with
/// a string clone per ancestor of every file (20-40 s on a big drive), only
/// to read the root's file count. That count now comes from
/// `--expected-files`.
#[cfg(not(windows))]
fn load_baseline(
    input: &ScanInput,
    _io: &Arc<IoStats>,
    _root_path_string: &str,
    _scan_started_ms: u64,
    _scan_started_instant: Instant,
) -> Option<Baseline> {
    if input.baseline_index.is_some() {
        eprintln!(
            "[diskhound-native-scanner] baseline ignored: the Unix walker does not inherit subtrees"
        );
    }
    None
}

#[cfg(windows)]
fn scan_root(root_path: &Path, state: &mut ScanState) -> Result<(), String> {
    scan_windows(root_path, state)
}

#[cfg(not(windows))]
fn scan_root(root_path: &Path, state: &mut ScanState) -> Result<(), String> {
    scan_generic(root_path, state)
}

/// Virtual / pseudo filesystem mount points that a user scan should
/// never descend into. Walking these is both meaningless (the
/// "files" under /proc and /sys are kernel-generated text and
/// change every read) and occasionally dangerous (certain /proc
/// entries can hang or cause side effects when opened).
///
/// The list covers the roots only; jwalk handles the subtree by
/// virtue of the `.process_read_dir()` predicate pruning the walk
/// below these mounts.
///
/// Docker and snap bind-mounts are excluded too — docker's
/// overlayfs images + snap squashfs mounts multiply the visible
/// file count 10-100× without telling the user anything useful
/// about the host filesystem's free space.
///
/// Separately, `foreign_mount_points` drops any mount whose
/// kernel device id differs from the scan root. btrfs subvolumes
/// of the same pool share that id (so a scan of `/` still includes
/// `/home` when both are subvolumes of one disk). A Windows NTFS
/// mount, tmpfs, or AppImage FUSE mount does not, and is left for
/// its own drive pill. `st_dev` is the wrong key here: btrfs gives
/// each subvolume a distinct `st_dev` even when `df` shows one pool.
/// `duplicate_mount_paths` drops second copies on the same filesystem:
/// bind mounts, and subvolumes also reachable through another mount.
#[cfg(not(windows))]
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

#[cfg(not(windows))]
fn should_skip_linux_path(path: &Path) -> bool {
    let s = path.to_string_lossy();
    // Match exact prefix followed by end-of-string or '/'. Pure
    // `starts_with` would false-positive on paths like
    // "/devices" matching "/dev".
    for prefix in LINUX_SKIP_PREFIXES {
        if s.len() == prefix.len() && s == *prefix {
            return true;
        }
        if s.len() > prefix.len()
            && s.as_bytes().starts_with(prefix.as_bytes())
            && s.as_bytes()[prefix.len()] == b'/'
        {
            return true;
        }
    }
    false
}

/// One line of `/proc/self/mountinfo`: mount point, the major:minor of
/// the filesystem, and the path inside that filesystem the mount shows
/// (`/` for a whole filesystem, `/@home` for a btrfs subvolume, the
/// source directory for a bind mount). btrfs subvolumes of one pool
/// share the major:minor; `stat.st_dev` does not.
#[cfg(target_os = "linux")]
struct LinuxMount {
    point: String,
    dev: String,
    root: String,
}

#[cfg(target_os = "linux")]
fn unescape_mountinfo(field: &str) -> String {
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
fn trim_mount_point(path: &str) -> &str {
    if path.len() > 1 {
        path.trim_end_matches('/')
    } else {
        path
    }
}

#[cfg(target_os = "linux")]
fn parse_mountinfo(text: &str) -> Vec<LinuxMount> {
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

#[cfg(target_os = "linux")]
fn path_is_under(root: &str, path: &str) -> bool {
    if root == "/" {
        return path != "/";
    }
    path.starts_with(root) && path.as_bytes().get(root.len()) == Some(&b'/')
}

/// Mount points under `root` that live on a different filesystem.
/// Same-pool btrfs subvolumes are kept. The scan root itself is never
/// included, so an explicit scan of `/mnt/windows` still walks it.
#[cfg(target_os = "linux")]
fn foreign_mount_points(mounts: &[LinuxMount], root: &str) -> HashSet<String> {
    let root = trim_mount_point(root);
    let Some(root_dev) = mounts
        .iter()
        .filter(|m| root == m.point || path_is_under(&m.point, root))
        .max_by_key(|m| m.point.len())
        .map(|m| m.dev.clone())
    else {
        return HashSet::new();
    };
    mounts
        .iter()
        .filter(|m| m.dev != root_dev && path_is_under(root, &m.point))
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
    } else if path_is_under(base, path) {
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
fn duplicate_mount_paths(mounts: &[LinuxMount], root: &str) -> HashSet<String> {
    let root = trim_mount_point(root);
    // A later mount on the same point hides the earlier one.
    let last_at: HashMap<&str, usize> = mounts
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
        .filter(|(_, m)| root == m.point || path_is_under(&m.point, root))
        .max_by_key(|(_, m)| m.point.len())
    else {
        return HashSet::new();
    };
    // The walk never gets to a mount under another filesystem's mount or
    // a skipped prefix, or to one a later mount above it covers. Pruning
    // its source would leave those files counted nowhere.
    let reachable = |i: usize, m: &LinuxMount| {
        !should_skip_linux_path(Path::new(&m.point))
            && !visible.iter().any(|(j, above)| {
                path_is_under(&above.point, &m.point)
                    && (*j > i || (above.dev != home.dev && path_is_under(root, &above.point)))
            })
    };
    // Each same-device mount the walk enters: mountinfo order, where the
    // walk enters it, and the path inside the filesystem found there.
    let walked: Vec<(usize, String, String)> = visible
        .iter()
        .filter(|(i, m)| {
            *i == home_index
                || (m.dev == home.dev && path_is_under(root, &m.point) && reachable(*i, m))
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
            let covered = visible.iter().any(|(_, m)| {
                path_is_under(a_entry, &m.point)
                    && (m.point == copy || path_is_under(&m.point, &copy))
            });
            if covered {
                continue;
            }
            // `copy` itself is B's mount point only when B is bound onto
            // itself, and the check above already skipped that.
            if path_is_under(&copy, b_entry) {
                duplicates.insert(b_entry.clone());
            } else {
                duplicates.insert(copy);
            }
        }
    }
    // Paths under another pruned path are never reached anyway.
    let nested: Vec<String> = duplicates
        .iter()
        .filter(|path| duplicates.iter().any(|other| path_is_under(other, path)))
        .cloned()
        .collect();
    for path in nested {
        duplicates.remove(&path);
    }
    duplicates
}

/// Mount paths a Linux walk skips: other filesystems, and second copies
/// of this one.
#[cfg(target_os = "linux")]
struct LinuxMountPrunes {
    foreign: HashSet<String>,
    duplicates: HashSet<String>,
}

#[cfg(target_os = "linux")]
fn load_linux_mount_prunes(root: &Path) -> LinuxMountPrunes {
    let text = match std::fs::read_to_string("/proc/self/mountinfo") {
        Ok(text) => text,
        Err(err) => {
            eprintln!(
                "[diskhound-native-scanner] linux: could not read mountinfo ({err}) — scan may cross into other disks"
            );
            return LinuxMountPrunes {
                foreign: HashSet::new(),
                duplicates: HashSet::new(),
            };
        }
    };
    let mounts = parse_mountinfo(&text);
    let root = normalize_path(root);
    let duplicates = duplicate_mount_paths(&mounts, &root);
    if !duplicates.is_empty() {
        let mut listed: Vec<&String> = duplicates.iter().collect();
        listed.sort();
        eprintln!(
            "[diskhound-native-scanner] linux: skipping second copies reached through another mount: {listed:?}"
        );
    }
    LinuxMountPrunes {
        foreign: foreign_mount_points(&mounts, &root),
        duplicates,
    }
}

#[cfg(not(windows))]
fn scan_generic(root_path: &Path, state: &mut ScanState) -> Result<(), String> {
    state.scan_phase = ScanPhase::Indexing;
    // Same tally-only directory rollup the Windows MFT path uses.
    // The incremental top-N sort on every ancestor of every file was
    // the CPU cost of a Linux walk once the filesystem was warm.
    state.defer_hottest_dir_ranking = true;
    state.expected_total_files = state.input.expected_total_files;

    // Parallelism: jwalk's default is serial. We explicitly enable
    // parallelism via rayon's thread pool (default 4-16 threads,
    // overridable via env var). The biggest wins
    // are on ext4/btrfs on NVMe — directory enumeration is
    // embarrassingly parallel at the I/O layer since readdir on
    // separate directories hits different inode blocks.
    //
    // DISKHOUND_PARALLEL_THREADS env var lets users override,
    // matching the Windows walker for consistency.
    let thread_override = std::env::var("DISKHOUND_PARALLEL_THREADS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| n >= 1);
    let thread_count = thread_override.unwrap_or_else(|| {
        let logical = num_cpus::get().max(1);
        if logical <= 2 {
            logical
        } else {
            logical.clamp(4, 16)
        }
    });

    // Other disks and pseudo filesystems mounted under the root.
    // macOS keeps the old walk: firmlinks make st_dev / mount ids lie
    // about where user files live, and this bug is the Linux one.
    #[cfg(target_os = "linux")]
    let mount_prunes = load_linux_mount_prunes(root_path);
    #[cfg(target_os = "linux")]
    let pruned_mounts = Arc::new(AtomicUsize::new(0));
    #[cfg(target_os = "linux")]
    let pruned_mounts_for_walk = Arc::clone(&pruned_mounts);
    #[cfg(target_os = "linux")]
    let pruned_duplicates = Arc::new(AtomicUsize::new(0));
    #[cfg(target_os = "linux")]
    let pruned_duplicates_for_walk = Arc::clone(&pruned_duplicates);
    let io_for_walk = Arc::clone(&state.io);

    // macOS: read APFS clone attributes once per directory inside
    // jwalk's (parallel) read-dir callback and park them on each child's
    // client state; the serial loop below hands them to record_file.
    #[cfg(target_os = "macos")]
    let clone_attrs_enabled = clone_attrs::enable_for_root(root_path);
    #[cfg(target_os = "macos")]
    eprintln!(
        "[diskhound-native-scanner] macos: APFS clone attributes {}",
        if clone_attrs_enabled { "on" } else { "off" }
    );

    let walker = WalkDirGeneric::<((), Option<CloneAttrs>)>::new(root_path)
        .sort(false)
        .skip_hidden(false)
        .parallelism(jwalk::Parallelism::RayonNewPool(thread_count))
        // Prune virtual/pseudo filesystems BEFORE descending. Drops
        // /proc, /sys, /dev, /run, /snap, docker overlayfs, etc. so
        // we never touch kernel-generated content. Without this a
        // scan of `/` produced millions of bogus entries and sometimes
        // hung on e.g. /proc/kcore.
        //
        // Also drop mount points that are a different filesystem than
        // the scan root (NTFS at /mnt/windows, tmpfs, FUSE). Same-pool
        // btrfs subvolumes stay. See foreign_mount_points. And drop the
        // second path to files another mount of this filesystem already
        // shows. See duplicate_mount_paths.
        .process_read_dir(move |depth, _path, _state, children| {
            // jwalk calls this once per read_dir, with the depth of the
            // directory read, and once more up front for the root entry
            // itself, with no depth and no read.
            if depth.is_some() {
                io_for_walk.count_readdir();
            }
            #[cfg(target_os = "macos")]
            if clone_attrs_enabled && clone_attrs::enabled() {
                let has_files = children
                    .iter()
                    .any(|c| c.as_ref().is_ok_and(|c| c.file_type().is_file()));
                if has_files {
                    if let Some(attrs) = clone_attrs::read_dir_clone_attrs(_path) {
                        for child in children.iter_mut().flatten() {
                            if child.file_type().is_file() {
                                child.client_state = attrs.get(child.file_name()).copied();
                            }
                        }
                    }
                }
            }
            children.retain(|child_result| {
                let Ok(child) = child_result else {
                    return true; // Let the outer loop handle read errors.
                };
                if should_skip_linux_path(&child.path()) {
                    return false;
                }
                #[cfg(target_os = "linux")]
                if child.file_type().is_dir() {
                    let point = trim_mount_point(&normalize_path(&child.path())).to_string();
                    if mount_prunes.foreign.contains(&point) {
                        pruned_mounts_for_walk.fetch_add(1, Ordering::Relaxed);
                        return false;
                    }
                    if mount_prunes.duplicates.contains(&point) {
                        pruned_duplicates_for_walk.fetch_add(1, Ordering::Relaxed);
                        return false;
                    }
                }
                true
            });
            // Fixed order so the first link of a hardlinked file, which
            // owns its bytes, is the same link on every scan. jwalk
            // streams entries depth-first in this order even when the
            // reads run in parallel.
            children.sort_by(|a, b| match (a, b) {
                (Ok(a), Ok(b)) => hardlinks::walk_order(
                    a.file_type.is_dir(),
                    &a.file_name,
                    b.file_type.is_dir(),
                    &b.file_name,
                ),
                (Ok(_), Err(_)) => std::cmp::Ordering::Less,
                (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
                (Err(_), Err(_)) => std::cmp::Ordering::Equal,
            });
        });

    eprintln!(
        "[diskhound-native-scanner] linux: walking with jwalk, {} rayon threads",
        thread_count
    );
    let walk_started = Instant::now();
    let mut hardlinks = hardlinks::HardlinkTracker::default();
    let mut hardlink_bytes_deduped: u64 = 0;

    for entry in walker {
        if is_cancelled() {
            finalize_hottest_directories(state);
            return Ok(());
        }

        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                state.skipped_entries += 1;
                maybe_emit_progress(state)?;
                continue;
            }
        };

        if entry.read_children_error.is_some() {
            // jwalk skips process_read_dir for a failed read_dir, but it
            // was still a listing attempt, as a failed FindFirstFileExW is.
            state.io.count_readdir();
            state.skipped_entries += 1;
        }

        if entry.file_type().is_dir() {
            state.directories_visited += 1;
            // Emit dir mtime entry so this scan is a valid baseline for the
            // next one. The Phase-1 inherit optimization isn't wired into
            // jwalk's iterator model here — the non-Windows scanner still
            // always walks — but we at least keep the output format
            // consistent so the JS worker (which does implement Phase 1)
            // can read it back.
            if let Some(writer) = state.index_writer.as_mut() {
                state.io.count_stat();
                if let Ok(Ok(modified)) = entry.metadata().map(|meta| meta.modified()) {
                    let dir_path = normalize_path(entry.path().as_path());
                    let _ = writer.write_dir_entry(&dir_path, unix_timestamp_ms(modified));
                }
            }
            maybe_emit_progress(state)?;
            continue;
        }

        if !entry.file_type().is_file() {
            maybe_emit_progress(state)?;
            continue;
        }

        state.io.count_stat();
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                state.skipped_entries += 1;
                maybe_emit_progress(state)?;
                continue;
            }
        };

        let file_path = entry.path();
        let parent_path = file_path
            .parent()
            .map(normalize_path)
            .unwrap_or_else(|| state.root_path_string.clone());
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let size = allocated_size(&metadata);
        let extra_hardlink =
            hardlinks.is_extra_link(metadata.dev(), metadata.ino(), metadata.nlink());
        if extra_hardlink {
            hardlink_bytes_deduped = hardlink_bytes_deduped.saturating_add(size);
        }
        let file_record = ScanFileRecord {
            path: normalize_path(&file_path),
            name: file_name.clone(),
            parent_path,
            extension: file_extension(&file_name),
            size,
            modified_at: metadata_modified_at_ms(&metadata),
        };

        record_file_with_link_flag(state, file_record, extra_hardlink, entry.client_state)?;
    }

    #[cfg(target_os = "linux")]
    let (pruned, duplicates) = (
        pruned_mounts.load(Ordering::Relaxed),
        pruned_duplicates.load(Ordering::Relaxed),
    );
    #[cfg(not(target_os = "linux"))]
    let (pruned, duplicates) = (0usize, 0usize);
    eprintln!(
        "[diskhound-native-scanner] linux: walk done in {} ms (files={}, dirs={}, skipped={}, foreign_mounts_pruned={}, duplicate_mounts_pruned={}, readdir_calls={}, stat_calls={})",
        walk_started.elapsed().as_millis(),
        state.files_visited,
        state.directories_visited,
        state.skipped_entries,
        pruned,
        duplicates,
        state.io.readdir_calls(),
        state.io.stat_calls(),
    );
    eprintln!(
        "[diskhound-native-scanner] hardlinks: {} extra links counted once ({} bytes), {} inodes with links outside the scan",
        hardlinks.extra_links(),
        hardlink_bytes_deduped,
        hardlinks.inodes_with_unseen_links(),
    );
    finalize_hottest_directories(state);
    Ok(())
}

#[cfg(windows)]
fn scan_windows(root_path: &Path, state: &mut ScanState) -> Result<(), String> {
    // Dispatch precedence (fastest → most compatible):
    //
    //   1. MFT raw-read — default when the process has admin. Opens
    //      `\\.\C:` for raw reads; on failure (not elevated / not NTFS)
    //      the helper returns Ok(false) and we fall through silently
    //      to the walker. Skip the attempt entirely via DISKHOUND_NO_MFT=1
    //      for diagnostics.
    //
    //   2. Parallel FindFirstFile walker — default when MFT isn't
    //      available. Uses num_cpus threads with a shared work queue
    //      + level-2 pre-seed on main. DISKHOUND_NO_PARALLEL=1 skips.
    //
    //   3. Sequential walker — original one-thread path; used when the
    //      parallel walker falls through (tiny trees, root enumerate
    //      failure) or is disabled via env var.
    let skip_mft = std::env::var("DISKHOUND_NO_MFT").as_deref() == Ok("1");
    if !skip_mft {
        match try_scan_windows_mft(root_path, state) {
            Ok(true) => return Ok(()),
            Ok(false) => {
                eprintln!(
                    "[diskhound-native-scanner] mft: fell through — running the FindFirstFile walker instead"
                );
            }
            Err(err) => {
                eprintln!(
                    "[diskhound-native-scanner] mft: scan failed ({err}) — falling back to FindFirstFile walker"
                );
            }
        }
        // Reset phase-related state that `try_scan_windows_mft` set up
        // before attempting to open the volume. Without this the UI
        // title stays on "Reading C:\\ metadata…" and lite snapshots
        // strip largest_files for the entire walker run — because the
        // walker doesn't overwrite these flags.
        state.scan_phase = ScanPhase::Starting;
        state.emit_lite_snapshots = false;
        state.defer_hottest_dir_ranking = false;
        state.expected_total_files = None;
    }

    walk_windows(root_path, state, std::env::var("DISKHOUND_NO_PARALLEL").is_err())
}

/// The FindFirstFile walkers. The parallel one goes first when allowed; if
/// it decides threads won't help, the sequential one carries on from where
/// it stopped. Either way the root is statted, listed and recorded once.
#[cfg(windows)]
fn walk_windows(root_path: &Path, state: &mut ScanState, parallel: bool) -> Result<(), String> {
    let stack = if parallel {
        match try_scan_windows_parallel(root_path, state) {
            ParallelDispatch::Ran(result) => return result,
            ParallelDispatch::FellThrough { stack } => stack,
        }
    } else {
        vec![(root_path.to_path_buf(), None)]
    };
    scan_windows_sequential(state, stack)
}

/// Attempt an MFT-based scan. Returns Ok(true) on success, Ok(false) on
/// graceful fall-through (elevation missing, non-NTFS volume), or Err on
/// unexpected failure. In the last two cases the caller runs the
/// FindFirstFile walker so the user still gets a scan.
#[cfg(windows)]
fn try_scan_windows_mft(
    root_path: &Path,
    state: &mut ScanState,
) -> Result<bool, String> {
    let started = Instant::now();
    // Enable lite snapshots during MFT read + path build so we can emit
    // progress updates to the UI without serializing ~1 MB of top-N
    // data each time. Without this the UI shows no activity for the
    // ~25 seconds of MFT enumeration — gives the impression the scan
    // is stalled before emit even starts.
    state.emit_lite_snapshots = true;
    state.scan_phase = ScanPhase::ReadingMetadata;
    // Callback shape: (records_scanned, files_kept, dirs_kept) from
    // the MFT reader. We INTENTIONALLY don't populate files_visited /
    // directories_visited / bytes_seen here — during the MFT read
    // phase bytes aren't known yet and the user saw the stats fill
    // with X files + Y dirs + 0 B, then reset to zero when emit began,
    // then grow again. Keeping the main stats at zero until indexing
    // starts is cleaner: the `scan_phase = ReadingMetadata` + the
    // elapsed timer signal activity, the top-right drive ring + status
    // stripe animate via elapsed_ms, and no counters ever "rewind".
    //
    // Progress during this phase is implicit (the ~15 s it takes is
    // well-predicted by volume size) and the next callback already
    // emits a lite snapshot so the UI doesn't feel frozen.
    let record_count_progress = |records_scanned: u64, files: u64, dirs: u64| {
        let _ = records_scanned;
        let _ = files;
        let _ = dirs;
        let _ = maybe_emit_progress(state);
    };
    match mft::scan_via_mft(root_path, record_count_progress) {
        Ok(records) => {
            eprintln!(
                "[diskhound-native-scanner] mft: scan_via_mft returned {} records in {} ms — emitting into ScanState",
                records.len(),
                started.elapsed().as_millis()
            );
            emit_mft_records_into_state(records, state)?;
            eprintln!(
                "[diskhound-native-scanner] mft: total mft-path scan took {} ms",
                started.elapsed().as_millis()
            );
            Ok(true)
        }
        Err(mft::MftError::NotElevated) | Err(mft::MftError::NotNtfs) => {
            Ok(false)
        }
        Err(other) => Err(format!("{}", other)),
    }
}

/// Convert parsed MFT records into the same `record_file` / dir-entry
/// calls the walker uses, so downstream bookkeeping (largest_files,
/// rollups, index writes, progress emissions) is identical no matter
/// which scan backend produced the data.
#[cfg(windows)]
fn emit_mft_records_into_state(
    mut records: Vec<mft::MftRecordParsed>,
    state: &mut ScanState,
) -> Result<(), String> {
    // Count the root itself the same way the walker does — consumers
    // expect `directories_visited >= 1` on any successful scan.
    state.directories_visited += 1;
    let root_mtime = directory_mtime(state.input.root_path.as_path(), &state.io).unwrap_or(0);
    if let Some(writer) = state.index_writer.as_mut() {
        let _ = writer.write_dir_entry(&state.root_path_string, root_mtime);
    }

    // Pre-sort by size descending BEFORE the emit loop. Without this,
    // `upsert_ranked_file` does a full `sort_by` on the 5k-entry
    // largest_files Vec on every file that exceeds the current smallest
    // — 5.5M × O(5k log 5k) ≈ 300 billion ops, which turns a 30-second
    // MFT read into a 5-minute emit phase. With the pre-sort, the first
    // 5k records fill the list, and every subsequent record hits the
    // early-exit (`size <= smallest`) without sorting. Directories go
    // first (size=0 after sort → end), but we iterate in reverse so
    // files come through first while largest_files is being built.
    //
    // Dirs and files both live in the same Vec; sorting by size alone
    // is fine because directories have size=0 from the MFT parser so
    // they sort to the end. Iterating start-to-end means we process
    // all files (sorted by size desc) first, then all dirs.
    // Two-phase sort:
    //   1. Directories first (so dir-count in the UI grows during the
    //      first few seconds of emit instead of sitting at 1)
    //   2. Files next, sorted by size descending so the largest N fill
    //      the top-files list before the early-exit kicks in
    //
    // We accomplish this with a single sort by a composite key:
    // dirs compare equal below files for any non-zero file size, but
    // the simplest correct approach is two partitions + one sort.
    let sort_started = Instant::now();
    records.sort_unstable_by(|a, b| {
        // is_dir=true should sort BEFORE is_dir=false. Among files,
        // larger sizes sort first.
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => b.size.cmp(&a.size),
        }
    });
    eprintln!(
        "[diskhound-native-scanner] mft: pre-sort (dirs first, then files by size desc) took {} ms",
        sort_started.elapsed().as_millis()
    );

    // Flip lite-mode on while we stream records into state. Largest-files
    // is built from the first ~5k entries (records is pre-sorted desc),
    // so Running snapshots after that point carry no new top-N info
    // anyway. The flag is reset to false below so the final Done snapshot
    // carries the full payload.
    state.emit_lite_snapshots = true;
    // Defer the hottest-directories ranking — on a 7M-file drive, the
    // incremental upsert was doing 10k-entry sorts on every file's
    // every ancestor, turning emit into a 15-min slog. We tally into
    // directory_totals only, then rebuild hottest_directories in one
    // pass via finalize_hottest_directories below.
    state.defer_hottest_dir_ranking = true;

    // Enter the indexing phase — populate expected_total_files so the
    // UI can render a files-based progress bar during this phase (the
    // pre-sort-by-size means bytes saturate at ~98% early while files
    // continue to stream for several more minutes).
    state.scan_phase = ScanPhase::Indexing;
    state.expected_total_files = Some(records.len() as u64);

    // Counters were intentionally left at 0 during the MFT read
    // phase so the UI doesn't show "X files, 0 B" then reset to 0 at
    // emit start. We still bump directories_visited by 1 for the root
    // itself — the walker path does this too, so UI stats match
    // regardless of which backend produced them.
    state.directories_visited = 1; // root

    let total = records.len();
    let emit_started = Instant::now();

    // ── PARALLEL EMIT ──────────────────────────────────────────
    //
    // Split `records` across N worker threads. Each builds a local
    // accumulator (dir_totals, ext_totals, largest_files, folder_tree_files).
    // Workers send NDJSON entries directly through the shared writer
    // channel (the index-writer thread is single-consumer, channel is
    // crossbeam-bounded, so concurrent producers are safe).
    //
    // After the scope ends we do a single-threaded merge. Because
    // records are pre-sorted (dirs first, then files size-desc), shard 0
    // sees the largest files — keeping each shard's top-K local and
    // merging at end remains correct because the global top-K is
    // guaranteed to be contained in the union of all shards' top-Ks.
    //
    // Shard count: env override or num_cpus(), clamped to [1, 8] to
    // match the pre-seed parallel walker's tuning. 8 threads on a
    // 16-logical-core box gives good speedup without saturating L3.
    let shard_count = std::env::var("DISKHOUND_EMIT_THREADS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| n >= 1)
        .unwrap_or_else(|| num_cpus::get().clamp(1, 8));
    let shard_count = shard_count.max(1);

    // Slice the Vec into contiguous chunks. Using split_off shuffles
    // Strings between heaps unnecessarily; Vec::chunks_mut would work
    // but we want owned chunks for the scope.spawn move. Approach:
    // drain into a Vec<Vec<T>> by splitting at computed indices.
    let chunk_base = records.len() / shard_count;
    let chunk_extra = records.len() % shard_count;

    // Find the first non-dir record index. Records were pre-sorted
    // dirs-first, so this is the dir/file boundary. The shard whose
    // chunk contains this index gets the tile_slot — its first ~200
    // file records are the global top-200 biggest files, which is
    // exactly what we want to stream to the UI. Previously tile_slot
    // always went to shard 0; on dir-heavy drives (1.26 M dirs vs
    // ~1 M files per shard) shard 0's entire chunk was dirs, its
    // local.largest_files stayed empty, and tiles NEVER streamed.
    let first_file_offset = records
        .iter()
        .position(|r| !r.is_dir)
        .unwrap_or(records.len());
    let mut first_file_shard: usize = 0;
    {
        let mut cumulative = 0usize;
        for shard_idx in 0..shard_count {
            let size = chunk_base + if shard_idx < chunk_extra { 1 } else { 0 };
            if cumulative + size > first_file_offset {
                first_file_shard = shard_idx;
                break;
            }
            cumulative += size;
        }
    }
    eprintln!(
        "[diskhound-native-scanner] mft: first-file offset={}, tile_slot assigned to shard {}",
        first_file_offset, first_file_shard
    );

    let mut chunks: Vec<Vec<mft::MftRecordParsed>> =
        Vec::with_capacity(shard_count);
    let mut records_iter = records.into_iter();
    for shard_idx in 0..shard_count {
        let size = chunk_base + if shard_idx < chunk_extra { 1 } else { 0 };
        let mut chunk = Vec::with_capacity(size);
        for _ in 0..size {
            match records_iter.next() {
                Some(r) => chunk.push(r),
                None => break,
            }
        }
        chunks.push(chunk);
    }
    drop(records_iter);

    // Shared atomics used ONLY for the progress-pump thread. Workers
    // flush local deltas in batches of 5000 records; main-thread pump
    // reads these to feed maybe_emit_progress during the scope.
    use std::sync::atomic::{AtomicU64, Ordering};
    let shared_files = AtomicU64::new(0);
    let shared_dirs = AtomicU64::new(1); // root counted
    let shared_bytes = AtomicU64::new(0);

    // Tile-streaming slot — shard 0 publishes its local top-K here
    // once it has enough entries (records are pre-sorted biggest-first,
    // so shard 0's first `top_file_limit` entries ARE the global top-K
    // modulo a small boundary blurring). Progress pump swaps it into
    // state.largest_files and fires a one-shot full snapshot so the
    // treemap lights up mid-scan instead of waiting for the ~26 s
    // emit+merge to finish. Arc<Mutex<Option<_>>> means the pump can
    // `take()` it once — no repeated full-snapshot emissions.
    let shared_tile_snapshot: std::sync::Arc<
        std::sync::Mutex<Option<Vec<ScanFileRecord>>>,
    > = std::sync::Arc::new(std::sync::Mutex::new(None));

    let root_path_str = state.root_path_string.clone();
    let top_file_limit = state.input.top_file_limit;
    let want_folder_tree = state.input.folder_tree_output.is_some();
    let writer_tx = state
        .index_writer
        .as_ref()
        .and_then(|w| w.tx_clone());

    eprintln!(
        "[diskhound-native-scanner] mft: parallel emit — {} shards, {} records",
        shard_count,
        total
    );

    let locals: Vec<EmitLocal> = std::thread::scope(|scope| {
        let mut handles: Vec<std::thread::ScopedJoinHandle<EmitLocal>> =
            Vec::with_capacity(shard_count);
        for (shard_idx, chunk) in chunks.into_iter().enumerate() {
            let root_path_ref = root_path_str.as_str();
            let writer_tx = writer_tx.clone();
            let shared_files = &shared_files;
            let shared_dirs = &shared_dirs;
            let shared_bytes = &shared_bytes;
            // Only the first-file shard publishes to the tile slot.
            // Records are pre-sorted dirs-first-then-files-desc, so
            // this shard is the earliest one that will encounter any
            // file records — and its first ~200 file records are
            // approximately the global top-200. Other shards pass
            // None (their file records come through the final merge).
            let tile_slot = if shard_idx == first_file_shard {
                Some(std::sync::Arc::clone(&shared_tile_snapshot))
            } else {
                None
            };
            handles.push(scope.spawn(move || {
                emit_shard(
                    chunk,
                    root_path_ref,
                    top_file_limit,
                    want_folder_tree,
                    writer_tx,
                    shared_files,
                    shared_dirs,
                    shared_bytes,
                    tile_slot,
                )
            }));
        }

        // Main-thread progress pump — reads shared atomics every ~200 ms
        // and feeds maybe_emit_progress. Breaks when all shards are
        // finished. Note: state is ONLY mutated here (workers hold no
        // references to it), so there's no synchronization needed.
        //
        // The pump now continuously consumes tile snapshots as shard 0
        // republishes them. Each successful take() flips the next
        // emission to full-payload so the treemap refreshes with the
        // latest top-K. `tile_publish_count` is logged once at the
        // end so we can verify streaming happened in crash.log.
        let mut tile_publish_count: u32 = 0;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(200));
            let files = shared_files.load(Ordering::Relaxed);
            let dirs = shared_dirs.load(Ordering::Relaxed);
            let bytes = shared_bytes.load(Ordering::Relaxed);
            state.files_visited = files;
            state.directories_visited = dirs;
            state.bytes_seen = bytes;

            // Tile snapshot available? Swap it into state + fire a
            // FULL (non-lite) progress emission so the UI's treemap
            // populates with the latest top-K. This now happens
            // continuously — shard 0 republishes every ~2000 records.
            let tiles_available = shared_tile_snapshot
                .lock()
                .ok()
                .and_then(|mut slot| slot.take());
            if let Some(tiles) = tiles_available {
                state.largest_files = tiles;
                let prior_lite = state.emit_lite_snapshots;
                state.emit_lite_snapshots = false;
                // Bypass the 200 ms throttle so tile flips always
                // get out even if a lite snapshot fired just before.
                state.last_emit_elapsed_ms = 0;
                let _ = maybe_emit_progress(state);
                state.emit_lite_snapshots = prior_lite;
                tile_publish_count += 1;
            } else {
                // No new tiles this tick — emit the normal lite progress
                // for counter updates only.
                let _ = maybe_emit_progress(state);
            }

            if handles.iter().all(|h| h.is_finished()) {
                break;
            }
        }
        eprintln!(
            "[diskhound-native-scanner] mft: tile-stream total publishes during emit = {}",
            tile_publish_count
        );

        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });

    // ── MERGE ─────────────────────────────────────────────────
    // Fold each shard's locals into ScanState. Order is stable since
    // we process shards in index order, but correctness doesn't depend
    // on order (HashMap updates are commutative, top-N merge-sort is
    // order-invariant).
    //
    // Reset counters before the merge. They were already set by the
    // progress-pump loop (reading the shared atomics), so += would
    // double-count — the final pump tick wrote files_visited=N and
    // the merge would add N again from locals. Observed as "14M files
    // / 2.5M dirs" on a drive with real totals of 7M / 1.27M.
    state.files_visited = 0;
    state.directories_visited = 1; // root, matching pre-merge reset
    state.bytes_seen = 0;
    // Also clear largest_files — the tile-streaming pump wrote
    // ~200 capped entries into it mid-scan; the merge below does
    // `.extend(local.largest_files)` per shard, which would otherwise
    // double-count shard 0's top-K against the streamed snapshot
    // (same records, different order) and produce duplicates after
    // sort+truncate. Starting from empty is both correct and cheap.
    state.largest_files.clear();
    let merge_started = Instant::now();
    let mut emitted_files: u64 = 0;
    let mut emitted_dirs: u64 = 0;
    for local in locals {
        emitted_files += local.files;
        emitted_dirs += local.dirs;
        state.files_visited += local.files;
        state.directories_visited += local.dirs;
        state.bytes_seen += local.bytes;

        for (k, v) in local.dir_totals {
            state
                .directory_totals
                .entry(k)
                .and_modify(|e| {
                    e.size += v.size;
                    e.file_count += v.file_count;
                })
                .or_insert(v);
        }
        for (k, v) in local.ext_totals {
            state
                .extension_totals
                .entry(k)
                .and_modify(|e| {
                    e.size += v.size;
                    e.count += v.count;
                })
                .or_insert(v);
        }
        // Union of local top-Ks — pre-sorted shards mostly agree on
        // the global top-K, but we still have to merge to catch edge
        // cases where a boundary record would have displaced a shard's
        // smallest local-top-K member.
        state.largest_files.extend(local.largest_files);

        if want_folder_tree {
            for (k, list) in local.folder_tree_files {
                state
                    .folder_tree_files
                    .entry(k)
                    .or_insert_with(Vec::new)
                    .extend(list);
            }
        }
    }

    // Finalize largest_files: sort+truncate the merged superset.
    state
        .largest_files
        .sort_by(|a, b| b.size.cmp(&a.size));
    state.largest_files.truncate(top_file_limit);

    // Folder-tree file lists may have grown past the cap during merge
    // (two shards each capped at 200 = up to 1600 entries per parent
    // after 8-way merge). Sort+truncate each list once globally.
    if want_folder_tree {
        for list in state.folder_tree_files.values_mut() {
            if list.len() > FOLDER_TREE_FILES_PER_PARENT {
                list.sort_by(|a, b| b.1.cmp(&a.1));
                list.truncate(FOLDER_TREE_FILES_PER_PARENT);
            }
        }
    }

    eprintln!(
        "[diskhound-native-scanner] mft: parallel emit+merge done — {} files + {} dirs across {} shards in {} ms (merge: {} ms)",
        emitted_files,
        emitted_dirs,
        shard_count,
        emit_started.elapsed().as_millis(),
        merge_started.elapsed().as_millis(),
    );
    state.scan_phase = ScanPhase::Finalizing;
    // Finalize the deferred top-N ranking in a single sort, then reset
    // the lite/defer flags so the Done snapshot the caller emits later
    // carries the fully-populated top-N payload.
    let finalize_started = Instant::now();
    finalize_hottest_directories(state);
    eprintln!(
        "[diskhound-native-scanner] mft: finalize hottest_directories took {} ms ({} dirs in totals)",
        finalize_started.elapsed().as_millis(),
        state.directory_totals.len(),
    );
    state.defer_hottest_dir_ranking = false;
    state.emit_lite_snapshots = false;
    eprintln!(
        "[diskhound-native-scanner] mft: emit done, state counters: files={} dirs={} bytes={}",
        state.files_visited, state.directories_visited, state.bytes_seen
    );
    maybe_emit_progress(state)?;
    eprintln!(
        "[diskhound-native-scanner] mft: post-final-progress, state counters: files={} dirs={} bytes={}",
        state.files_visited, state.directories_visited, state.bytes_seen
    );
    Ok(())
}

/// Per-shard accumulator for the parallel emit path. Each worker
/// thread owns one of these; main merges them after scope ends.
/// Structure matches the fields in `ScanState` that `record_file`
/// used to update serially, just scoped to one thread's portion
/// of the records.
#[cfg(windows)]
struct EmitLocal {
    dir_totals: HashMap<String, DirectoryHotspot>,
    ext_totals: HashMap<String, ExtensionBucket>,
    largest_files: Vec<ScanFileRecord>,
    folder_tree_files: HashMap<String, Vec<(String, u64, u64)>>,
    files: u64,
    dirs: u64,
    bytes: u64,
}

#[cfg(windows)]
impl EmitLocal {
    fn new() -> Self {
        Self {
            dir_totals: HashMap::new(),
            ext_totals: HashMap::new(),
            largest_files: Vec::new(),
            folder_tree_files: HashMap::new(),
            files: 0,
            dirs: 0,
            bytes: 0,
        }
    }
}

/// Process one shard of pre-sorted MFT records into an EmitLocal.
/// Called on a worker thread; the caller owns the returned local
/// and merges it into ScanState once all shards complete.
///
/// `tile_slot` is Some only on shard 0 — once shard 0's local
/// largest_files has reached top_file_limit entries we snapshot it
/// into the shared slot so the main-thread progress pump can surface
/// the tiles to the UI mid-emit. Shards 1..N pass None and never
/// touch the slot.
#[cfg(windows)]
fn emit_shard(
    records: Vec<mft::MftRecordParsed>,
    root_path: &str,
    top_file_limit: usize,
    want_folder_tree: bool,
    writer_tx: Option<crossbeam_channel::Sender<IndexWriteMsg>>,
    shared_files: &std::sync::atomic::AtomicU64,
    shared_dirs: &std::sync::atomic::AtomicU64,
    shared_bytes: &std::sync::atomic::AtomicU64,
    tile_slot: Option<std::sync::Arc<std::sync::Mutex<Option<Vec<ScanFileRecord>>>>>,
) -> EmitLocal {
    use std::sync::atomic::Ordering;

    let mut local = EmitLocal::new();
    // Batch atomic flushes so per-record work avoids cross-core cache
    // line ping-pong. 5000 records ≈ 50-100 ms at realistic emit rates
    // — plenty of granularity for the 200 ms progress pump.
    const BATCH_SIZE: u64 = 5_000;
    // Initial tile publish threshold — kept low so tiles appear within
    // the first second of emit instead of after 5k records. On a fast
    // drive shard 0 produces thousands of records per second, so 5k
    // was landing only seconds before "done" — user saw only % for
    // the whole scan. 200 records is ~0.1 s of work and surfaces the
    // biggest files immediately.
    const TILE_PUBLISH_THRESHOLD: usize = 200;
    // Cap the snapshot we publish mid-scan. Running-status progress
    // snapshots with 5000 × 4-field records run ~1–2 MB per emit which
    // saturated the Windows 64 KB stdout pipe and back-pressured the
    // scanner. 200 records is ~30 KB, well under the pipe buffer at
    // 5 emits/sec.
    const TILE_PUBLISH_CAP: usize = 200;
    let mut batch_files: u64 = 0;
    let mut batch_dirs: u64 = 0;
    let mut batch_bytes: u64 = 0;
    // Track whether we've done the INITIAL publish (threshold reached)
    // and also re-publish every N records after that so tiles refresh
    // as the top-K evolves.
    let mut tile_initial_published = false;
    let mut records_since_last_tile_publish: usize = 0;
    const TILE_REPUBLISH_EVERY: usize = 2_000;

    let flush = |batch_files: &mut u64,
                 batch_dirs: &mut u64,
                 batch_bytes: &mut u64| {
        if *batch_files > 0 {
            shared_files.fetch_add(*batch_files, Ordering::Relaxed);
            *batch_files = 0;
        }
        if *batch_dirs > 0 {
            shared_dirs.fetch_add(*batch_dirs, Ordering::Relaxed);
            *batch_dirs = 0;
        }
        if *batch_bytes > 0 {
            shared_bytes.fetch_add(*batch_bytes, Ordering::Relaxed);
            *batch_bytes = 0;
        }
    };

    for rec in records {
        if rec.is_dir {
            local.dirs += 1;
            batch_dirs += 1;
            if let Some(tx) = &writer_tx {
                let _ = tx.send(IndexWriteMsg::Dir {
                    path: rec.name,
                    mtime: rec.mtime_ms,
                });
            }
        } else {
            let occupancy = if rec.extra_hardlink { 0 } else { rec.size };
            local.files += 1;
            local.bytes += occupancy;
            batch_files += 1;
            batch_bytes += occupancy;

            let path = rec.name;
            let (parent_path, file_name) = split_parent_and_name(&path);
            let extension = file_extension(&path);

            if !rec.extra_hardlink {
                upsert_ranked_file(
                    &mut local.largest_files,
                    ScanFileRecord {
                        path: path.clone(),
                        name: file_name.clone(),
                        parent_path: parent_path.clone(),
                        extension: extension.clone(),
                        size: rec.size,
                        modified_at: rec.mtime_ms,
                    },
                    top_file_limit,
                );
                rollup_directory_size_tallies_only(
                    root_path,
                    &parent_path,
                    rec.size,
                    &mut local.dir_totals,
                );
                rollup_extension(&mut local.ext_totals, &extension, rec.size);
            }

            if want_folder_tree {
                let list = local
                    .folder_tree_files
                    .entry(parent_path)
                    .or_insert_with(Vec::new);
                list.push((file_name, rec.size, rec.mtime_ms));
                if list.len() > FOLDER_TREE_FILES_PER_PARENT * 2 {
                    list.sort_by(|a, b| b.1.cmp(&a.1));
                    list.truncate(FOLDER_TREE_FILES_PER_PARENT);
                }
            }

            if let Some(tx) = &writer_tx {
                let _ = tx.send(IndexWriteMsg::File {
                    path,
                    size: rec.size,
                    mtime: rec.mtime_ms,
                    extra_hardlink: rec.extra_hardlink,
                    clone: None,
                });
            }
        }

        if batch_files + batch_dirs >= BATCH_SIZE {
            flush(&mut batch_files, &mut batch_dirs, &mut batch_bytes);
        }

        // Tile-slot publish (shard 0 only) — continuous streaming so
        // the treemap populates mid-scan and keeps refreshing as the
        // top-K evolves. Records are pre-sorted biggest-first, so
        // shard 0's first `TILE_PUBLISH_THRESHOLD` entries approximate
        // the global top-K from that moment on.
        //
        // Two triggers:
        //   1. Initial publish: as soon as we have TILE_PUBLISH_THRESHOLD
        //      records. Happens within ~0.1 s of emit start on fast drives.
        //   2. Re-publish: every TILE_REPUBLISH_EVERY records thereafter,
        //      so the top-K freshens as bigger candidates bubble up.
        //
        // We only publish a CAPPED copy (TILE_PUBLISH_CAP entries) — the
        // full top-K goes in the merge at scope-end. This keeps the
        // running-status stdout pipe traffic bounded.
        if let Some(slot) = tile_slot.as_ref() {
            records_since_last_tile_publish += 1;
            let should_publish = if !tile_initial_published {
                local.largest_files.len() >= TILE_PUBLISH_THRESHOLD
            } else {
                records_since_last_tile_publish >= TILE_REPUBLISH_EVERY
            };
            if should_publish {
                local
                    .largest_files
                    .sort_by(|a, b| b.size.cmp(&a.size));
                let snap: Vec<ScanFileRecord> = local
                    .largest_files
                    .iter()
                    .take(TILE_PUBLISH_CAP)
                    .cloned()
                    .collect();
                if let Ok(mut guard) = slot.lock() {
                    *guard = Some(snap);
                }
                tile_initial_published = true;
                records_since_last_tile_publish = 0;
            }
        }
    }

    // Final flush so the progress pump sees our last partial batch
    // before the scope ends.
    flush(&mut batch_files, &mut batch_dirs, &mut batch_bytes);

    // Last-chance tile publish — covers shard 0s that finished with
    // fewer than TILE_PUBLISH_THRESHOLD records or haven't republished
    // recently. Ensures at least ONE tile snapshot always lands so the
    // UI never sees an all-empty running-status sequence.
    if let Some(slot) = tile_slot.as_ref() {
        local
            .largest_files
            .sort_by(|a, b| b.size.cmp(&a.size));
        let snap: Vec<ScanFileRecord> = local
            .largest_files
            .iter()
            .take(TILE_PUBLISH_CAP)
            .cloned()
            .collect();
        if let Ok(mut guard) = slot.lock() {
            *guard = Some(snap);
        }
    }

    local
}

#[cfg(windows)]
fn split_parent_and_name(full_path: &str) -> (String, String) {
    match full_path.rfind(['\\', '/']) {
        Some(idx) => {
            let parent = full_path[..idx].to_string();
            let name = full_path[idx + 1..].to_string();
            (parent, name)
        }
        None => (String::new(), full_path.to_string()),
    }
}

/// Walks `stack` depth-first. A fresh scan passes just the root; the
/// parallel walker's fall-through passes what it left undone.
#[cfg(windows)]
fn scan_windows_sequential(
    state: &mut ScanState,
    mut stack: Vec<(PathBuf, Option<u64>)>,
) -> Result<(), String> {
    // The walker's own "indexing" phase starts here. UI uses
    // scan_phase to decide copy and which progress bar to show.
    // Pre-0.5.3 the walker left scan_phase at Starting, which made
    // the UI stay on "Scanning — first files should appear in a few
    // seconds" forever, then at the end flip straight to Done —
    // never reaching the files-indexed/total fraction copy that
    // actually reflected progress.
    state.scan_phase = ScanPhase::Indexing;
    // Expected-total-files is needed for the files-indexed fraction
    // display. We seed from the baseline file count when available
    // so the UI has a denominator. Baseline-less scans get None and
    // fall back to the generic byte-based percentage.
    if let Some(baseline) = state.baseline.as_ref() {
        // Sum all per-dir file counts for an approximate total. The
        // baseline's dir_file_counts is bubbled up, so the root's
        // value is the recursive total — read it directly when
        // present, or sum when not.
        let root_key = &state.root_path_string;
        if let Some(total) = baseline.dir_file_counts.get(root_key) {
            state.expected_total_files = Some(*total);
        }
    }

    // Each stack entry carries an optional mtime hint inherited from the
    // parent's FindFirstFileExW data. Populated for every subdirectory
    // during enumeration so we don't need to `metadata()` them again at
    // pop time. Only the initial root has no hint — we pay one syscall
    // for it, not 1.2 million.
    // Decide up front whether any directory has a chance of being
    // inheritance-matched. When the baseline is absent or carries no
    // dir_mtimes (the case when the prior scan was a USN-journal
    // incremental that dropped {t:"d"} entries), EVERY dir is walked
    // from scratch and the per-dir metadata() syscall for mtime is
    // pure waste — we still want the mtime to write into the new
    // index, but that now comes from the hint instead of an I/O call.
    let baseline_can_inherit = state
        .baseline
        .as_ref()
        .map(|b| !b.dir_mtimes.is_empty())
        .unwrap_or(false);
    let mut mtime_syscalls_saved: u64 = 0;

    while let Some((directory_path, mtime_hint)) = stack.pop() {
        if is_cancelled() {
            return Ok(());
        }
        state.directories_visited += 1;
        maybe_emit_progress(state)?;

        // Phase-1 mtime skip: before enumerating, check whether the directory's
        // mtime matches the baseline. If so, inherit the entire subtree from
        // the baseline's file records and don't walk further.
        let directory_path_str = normalize_path(&directory_path);
        // Prefer the hint from the parent enumeration. Only fall back to
        // the metadata syscall when we truly need a fresh number (root
        // dir, or we're going to compare against a baseline entry).
        let current_mtime = match mtime_hint {
            Some(m) => {
                mtime_syscalls_saved += 1;
                m
            }
            None if !baseline_can_inherit => 0, // nothing to compare against
            None => directory_mtime(&directory_path, &state.io).unwrap_or(0),
        };

        // Streaming-baseline inheritance path: if this dir's mtime matches
        // the baseline, we defer the actual file-record copying to a
        // post-walk streaming pass. During the walk we only:
        //   1. Record the prefix as "inherited" for later streaming.
        //   2. Emit dir entries for this dir + all its subtree dirs so
        //      the new index's directory structure is complete.
        //   3. Update counters that are cheap to get from per-dir
        //      aggregates (files_visited, bytes_seen, directory_totals).
        //
        // `largest_files` and `extension_totals` get filled in post-walk
        // during the actual file-record stream. Accept that snapshots
        // emitted during the walk are slightly incomplete for those —
        // they'll be corrected before the final `done` snapshot.
        let inheritance_plan = state.baseline.as_ref().and_then(|baseline| {
            let baseline_mtime = *baseline.dir_mtimes.get(&directory_path_str)?;
            if current_mtime.abs_diff(baseline_mtime) >= 2 {
                return None;
            }
            let inherited_file_count = baseline
                .dir_file_counts
                .get(&directory_path_str)
                .copied()
                .unwrap_or(0);
            let inherited_bytes = baseline
                .dir_total_sizes
                .get(&directory_path_str)
                .copied()
                .unwrap_or(0);
            let subtree_dir_entries: Vec<(String, u64)> = baseline
                .subtree_dirs(&directory_path_str)
                .into_iter()
                .filter_map(|sub| baseline.dir_mtimes.get(&sub).map(|m| (sub, *m)))
                .collect();
            Some((inherited_file_count, inherited_bytes, subtree_dir_entries))
        });

        if let Some((inherited_count, inherited_bytes, subtree_dir_entries)) = inheritance_plan {
            state.inherited_dirs += 1;
            state.inherited_files += inherited_count;
            state.files_visited += inherited_count;
            state.bytes_seen += inherited_bytes;
            // Credit the inherited subtree to directories_visited so the
            // "N dirs" status-bar stat reflects the full tree we scanned
            // (not just the handful of dirs we re-walked on a warm cache).
            // Without this, a fully-inherited scan of C:\ reported "1 dir"
            // despite covering millions of files under thousands of dirs.
            state.directories_visited += subtree_dir_entries.len() as u64;
            state.inherited_prefixes.push(directory_path_str.clone());

            // Roll up directory totals using the precomputed cumulative
            // size so the hottest-directories panel is accurate during
            // the walk, even though individual file records haven't
            // streamed in yet.
            rollup_directory_bytes(
                &state.root_path_string,
                &directory_path_str,
                inherited_bytes,
                inherited_count,
                &mut state.directory_totals,
                &mut state.hottest_directories,
                state.input.top_directory_limit,
            );

            // Re-emit dir entries from the subtree so the new index remains
            // a valid baseline for the next scan.
            if let Some(writer) = state.index_writer.as_mut() {
                let _ = writer.write_dir_entry(&directory_path_str, current_mtime);
                for (sub, m) in &subtree_dir_entries {
                    let _ = writer.write_dir_entry(sub, *m);
                }
            }

            // Populate directory_totals with each inherited subtree dir
            // so the folder-tree sidecar's `d` (subdir) arrays are
            // populated per parent. Without this, the inherited dirs
            // only exist in the index but not in directory_totals, and
            // the sidecar builder emits `"d":[]` for every parent —
            // user-visible symptom: Folders tab shows 21 files at C:\
            // with no directories (no C:\Users, C:\Windows, etc.),
            // despite the tree having 938k+ entries.
            //
            // We reach into the baseline's per-dir aggregates for
            // accurate size + file_count per subdir. Same memory was
            // already paid for the inheritance check above, so this is
            // cheap.
            if let Some(baseline) = state.baseline.as_ref() {
                let root_path_snapshot = state.root_path_string.clone();
                for (sub, _mtime) in &subtree_dir_entries {
                    let sub_size = baseline.dir_total_sizes.get(sub).copied().unwrap_or(0);
                    let sub_fc = baseline.dir_file_counts.get(sub).copied().unwrap_or(0);
                    state
                        .directory_totals
                        .entry(sub.clone())
                        .or_insert_with(|| DirectoryHotspot {
                            path: sub.clone(),
                            size: sub_size,
                            file_count: sub_fc,
                            depth: directory_depth(&root_path_snapshot, sub),
                        });
                }
            }

            maybe_emit_progress(state)?;
            continue;
        }

        // Emit dir entry for the re-walked directory so future scans can skip it.
        if let Some(writer) = state.index_writer.as_mut() {
            let _ = writer.write_dir_entry(&directory_path_str, current_mtime);
        }

        enumerate_windows_directory(&directory_path, state, &mut stack)?;
    }

    // Main walk is done — the UI can now show "Finalizing" copy
    // instead of the indeterminate-scanning copy. The post-walk
    // stream below does the remaining work (copying inherited file
    // records out of the baseline), which on a full-inherit scan
    // represents 90%+ of total files but doesn't need a visible
    // percentage (the walker's `filesVisited` counter is already
    // credited from the inheritance aggregates).
    state.scan_phase = ScanPhase::Finalizing;
    let _ = maybe_emit_progress(state);

    // Post-walk streaming pass: if any subtrees were inherited, stream the
    // baseline NDJSON one more time to copy file records + update top-N
    // and extension stats for those subtrees. This is where the memory
    // savings pay off — instead of holding every baseline file record in
    // memory throughout the walk, we touch each one exactly once right
    // here and release it.
    if !state.inherited_prefixes.is_empty() {
        let baseline_path = state.baseline.as_ref().map(|b| b.baseline_path.clone());
        let inherited_prefixes = state.inherited_prefixes.clone();
        if let Some(path) = baseline_path {
            let _ = stream_inherited_files_into(&path, &inherited_prefixes, state);
            maybe_emit_progress(state)?;
        }
    }

    // Emit a diagnostic so we can verify the fast path in production.
    if state.baseline.is_some() {
        eprintln!(
            "[diskhound-native-scanner] Phase-1 inheritance (streaming): {} dirs skipped, {} files inherited",
            state.inherited_dirs, state.inherited_files,
        );
    }
    // And how many mtime syscalls we avoided via parent-enum hints.
    eprintln!(
        "[diskhound-native-scanner] mtime syscalls saved via enum-hint: {} (baseline_can_inherit={})",
        mtime_syscalls_saved, baseline_can_inherit,
    );

    // Baseline maps are no longer needed once the walk + post-walk
    // stream are done. Drop them to release RAM before the final
    // Done snapshot is built — on a 1M-dir drive this frees ~100 MB
    // of the scanner's peak resident footprint before the process
    // exits.
    state.baseline = None;

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────
// Parallel scan machinery
//
// Channel-based architecture:
//   * N worker threads pop directories from a shared work queue,
//     enumerate them with FindFirstFileExW, and send file records +
//     directory entries to the main thread via a bounded crossbeam
//     channel.
//   * Worker threads also decide Phase-1 inheritance locally (checked
//     against an `Arc<Baseline>` read-only share) and send one
//     aggregate `Inheritance` message per matched subtree instead of
//     one message per inherited file.
//   * The main thread is the SOLE MUTATOR of ScanState — it pulls
//     messages from the channel and calls record_file / writes dir
//     entries / handles inheritance rollups exactly as the sequential
//     scanner does. No cross-thread state mutation, no merge step.
//   * A small WorkQueue wrapper coordinates the `pending` counter
//     (items in queue OR being processed) so workers can cleanly
//     detect "nothing left to do" without explicit shutdown signals.
//   * std::thread::scope gives us structured concurrency: if any
//     worker panics, the scope's Result carries it up and the scan
//     fails cleanly instead of hanging.
//
// Expected speedup on NVMe: ~2-4× (I/O bound on directory enumeration;
// the drive's queue depth services parallel FindFirstFileExW calls
// concurrently). On HDD: less benefit due to seek contention.

#[cfg(windows)]
enum ParallelDispatch {
    /// Parallel walker ran to completion (or cancellation). Use this result.
    Ran(Result<(), String>),
    /// Parallel walker decided threading wasn't worth it for this scan
    /// (root unchanged since the baseline, or too few direct subdirs).
    /// The sequential walker carries on from `stack`: the root itself
    /// with its mtime, or the root's subdirectories once the root has
    /// been recorded. Nothing in `stack` has been recorded yet.
    FellThrough { stack: Vec<(PathBuf, Option<u64>)> },
}

#[cfg(windows)]
struct ParallelWorkQueue {
    queue: std::sync::Mutex<std::collections::VecDeque<(PathBuf, Option<u64>)>>,
    cv: std::sync::Condvar,
    /// Count of items currently in the queue PLUS items being
    /// processed by a worker. When this hits zero the walk is done.
    /// Bumped by push_many (by pushed count) and by mark_done (-1).
    /// pop() does NOT decrement because the popped item is still
    /// "in flight" until mark_done.
    pending: std::sync::atomic::AtomicU64,
    shutting_down: std::sync::atomic::AtomicBool,
}

#[cfg(windows)]
impl ParallelWorkQueue {
    fn new(initial: Vec<(PathBuf, Option<u64>)>) -> Self {
        let count = initial.len() as u64;
        let mut queue = std::collections::VecDeque::new();
        queue.extend(initial);
        Self {
            queue: std::sync::Mutex::new(queue),
            cv: std::sync::Condvar::new(),
            pending: std::sync::atomic::AtomicU64::new(count),
            shutting_down: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn push_many(&self, items: Vec<(PathBuf, Option<u64>)>) {
        if items.is_empty() {
            return;
        }
        self.pending
            .fetch_add(items.len() as u64, std::sync::atomic::Ordering::AcqRel);
        let mut guard = self.queue.lock().unwrap();
        for item in items {
            guard.push_back(item);
        }
        drop(guard);
        self.cv.notify_all();
    }

    /// Pop a work item, blocking if the queue is empty but other
    /// workers still have items in flight. Returns None when all
    /// workers have marked their items done AND the queue is empty,
    /// OR when the shutdown flag has been raised (cancellation).
    fn pop(&self) -> Option<(PathBuf, Option<u64>)> {
        let mut guard = self.queue.lock().unwrap();
        loop {
            if self.shutting_down.load(std::sync::atomic::Ordering::Acquire) {
                return None;
            }
            if let Some(item) = guard.pop_front() {
                return Some(item);
            }
            if self.pending.load(std::sync::atomic::Ordering::Acquire) == 0 {
                // Nothing in flight anywhere — signal shutdown so any
                // other workers currently in the cv.wait below wake up
                // and exit cleanly.
                self.shutting_down
                    .store(true, std::sync::atomic::Ordering::Release);
                self.cv.notify_all();
                return None;
            }
            guard = self.cv.wait(guard).unwrap();
        }
    }

    /// Mark one work item as processed. Call exactly once per
    /// successful pop(). If this was the last outstanding item and the
    /// queue is empty, woken workers in pop() will see pending == 0
    /// and shut down.
    fn mark_done(&self) {
        let prev = self
            .pending
            .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
        if prev <= 1 {
            // Was the last in-flight item — wake any sleeping workers
            // so they can see pending == 0 and exit.
            self.cv.notify_all();
        }
    }

    fn request_shutdown(&self) {
        self.shutting_down
            .store(true, std::sync::atomic::Ordering::Release);
        self.cv.notify_all();
    }
}

/// Messages sent from parallel workers to the main thread. Main is the
/// sole owner of ScanState and the only thread that calls record_file,
/// writes to the index, or mutates rollup maps — workers are pure I/O
/// producers.
#[cfg(windows)]
enum ParallelWorkerMessage {
    /// A file discovered during enumeration. Main calls record_file on
    /// it exactly as the sequential path would.
    File(ScanFileRecord),
    /// A directory was successfully entered; its dir entry should be
    /// written to the index so the new scan is a valid baseline for
    /// the next one.
    DirEntered { path: String, mtime: u64 },
    /// An enumeration error occurred (FindFirstFileExW failed or we
    /// hit a race with a deletion). Main bumps skipped_entries.
    Skipped,
    /// A subtree inheritance hit: the dir's mtime matched the baseline
    /// so we don't need to walk into it. Main does the aggregate
    /// bookkeeping + writes dir entries for the inherited subtree.
    Inheritance {
        dir_path: String,
        current_mtime: u64,
        inherited_count: u64,
        inherited_bytes: u64,
        subtree_dir_entries: Vec<(String, u64)>,
    },
}

/// Everything workers need that's read-only or lock-free-shared.
#[cfg(windows)]
struct ParallelSharedCtx {
    queue: ParallelWorkQueue,
    baseline: Option<std::sync::Arc<Baseline>>,
    baseline_can_inherit: bool,
    // Counters visible to workers (for their own inheritance-path
    // mtime_syscalls_saved bumps + diagnostics). Main reads these only
    // post-walk; progress emissions use state.files_visited which is
    // maintained synchronously by main as it processes messages.
    mtime_syscalls_saved: std::sync::atomic::AtomicU64,
    io: Arc<IoStats>,
}

/// Top-level entry for the parallel Windows scanner. Returns
/// ParallelDispatch::FellThrough when threading wouldn't help (root
/// has ≤ 1 direct subdir); the caller then runs the sequential path.
#[cfg(windows)]
fn try_scan_windows_parallel(root_path: &Path, state: &mut ScanState) -> ParallelDispatch {
    // Step 1 — the root, on main. We need its direct subdirs to seed
    // the work queue, and root's direct *files* are bookkept on main
    // before any workers start (keeps the "root is the first thing
    // recorded" property the sequential path already has).
    //
    // Nothing is recorded until the root is known to need a walk, and
    // a fall-through hands the sequential walker only what is left, so
    // the root is statted, listed and counted once whichever walker
    // finishes the scan.
    let root_path_str = normalize_path(root_path);
    // Root's own mtime: cheap (one syscall), always needed for the
    // index's {t:"d"} entry so the next scan can inheritance-match.
    let root_mtime = directory_mtime(root_path, &state.io).unwrap_or(0);

    // Same mtime test as the sequential path's top-of-loop block. An
    // unchanged root inherits the whole drive: no walk, no threads. The
    // sequential path handles that and takes the mtime with it.
    let root_unchanged = state.baseline.as_ref().is_some_and(|baseline| {
        baseline
            .dir_mtimes
            .get(&root_path_str)
            .is_some_and(|baseline_mtime| root_mtime.abs_diff(*baseline_mtime) < 2)
    });
    if root_unchanged {
        eprintln!(
            "[diskhound-native-scanner] parallel: root unchanged since the baseline — inheriting it on the sequential path"
        );
        return ParallelDispatch::FellThrough {
            stack: vec![(root_path.to_path_buf(), Some(root_mtime))],
        };
    }

    state.directories_visited += 1;
    if let Err(err) = maybe_emit_progress(state) {
        eprintln!("[diskhound-native-scanner] parallel: progress emit failed pre-walk: {err}");
    }

    // Write root's own dir entry so the new index covers the root
    // itself + root's direct contents.
    if let Some(writer) = state.index_writer.as_mut() {
        let _ = writer.write_dir_entry(&root_path_str, root_mtime);
    }

    // Enumerate root, bookkeep direct files on main, collect subdirs.
    // Only a failed stdout write gets an Err here, and the sequential
    // walker would hit the same one.
    let mut root_children: Vec<(PathBuf, Option<u64>)> = Vec::new();
    if let Err(err) = enumerate_windows_directory(root_path, state, &mut root_children) {
        return ParallelDispatch::Ran(Err(err));
    }

    // Not worth threading overhead for tiny trees. The root is done;
    // the sequential walker takes its subdirectories from here.
    if root_children.len() < 2 {
        eprintln!(
            "[diskhound-native-scanner] parallel: root has {} subdir(s); the sequential walker takes it from here",
            root_children.len()
        );
        return ParallelDispatch::FellThrough { stack: root_children };
    }

    // Step 2 — set up parallel walk.
    let worker_count = std::env::var("DISKHOUND_PARALLEL_THREADS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| n >= 1)
        .unwrap_or_else(|| num_cpus::get().clamp(2, 8));
    // Don't clamp to root_children.len(). Extra workers block on the
    // Condvar waiting for subdirs to appear in the queue, then steal
    // them as the initial workers enumerate. Clamping here would starve
    // the walk whenever root has few direct subdirs but deep subtrees
    // (e.g., a drive where 95% of bytes live under Users\thoma).
    let worker_count = worker_count.max(1);

    let baseline_can_inherit = state
        .baseline
        .as_ref()
        .map(|b| !b.dir_mtimes.is_empty())
        .unwrap_or(false);

    // Level-2 pre-seed — enumerate every root child on main BEFORE
    // spawning workers. This replaces a ~10-entry seed queue with a
    // hundreds-entry grandchild queue, eliminating the startup
    // imbalance where one worker spends minutes walking a dominant
    // subtree while 7 others sit idle on the Condvar. Cost is ~0.5–1
    // second of serial pre-enumeration; benefit on an 18-minute cold
    // scan is multi-minute. We also handle inheritance-hits on main
    // here so inheritance-matched root-children don't take a queue
    // slot just to emit a synthetic Inheritance message.
    let preseed_started = Instant::now();
    let baseline_opt = state.baseline.take();
    let mut seed_queue: Vec<(PathBuf, Option<u64>)> = Vec::with_capacity(256);
    let mut preseed_inheritance_hits: u64 = 0;
    for (child_path, child_mtime_hint) in root_children.drain(..) {
        let child_path_str = normalize_path(&child_path);
        let current_mtime =
            child_mtime_hint.unwrap_or_else(|| directory_mtime(&child_path, &state.io).unwrap_or(0));

        // Inheritance check on main (mirrors the per-worker logic).
        let inheritance = if baseline_can_inherit {
            baseline_opt.as_ref().and_then(|baseline| {
                let baseline_mtime = *baseline.dir_mtimes.get(&child_path_str)?;
                if current_mtime.abs_diff(baseline_mtime) >= 2 {
                    return None;
                }
                let inherited_count = baseline
                    .dir_file_counts
                    .get(&child_path_str)
                    .copied()
                    .unwrap_or(0);
                let inherited_bytes = baseline
                    .dir_total_sizes
                    .get(&child_path_str)
                    .copied()
                    .unwrap_or(0);
                let subtree_dir_entries: Vec<(String, u64)> = baseline
                    .subtree_dirs(&child_path_str)
                    .into_iter()
                    .filter_map(|sub| baseline.dir_mtimes.get(&sub).map(|m| (sub, *m)))
                    .collect();
                Some((inherited_count, inherited_bytes, subtree_dir_entries))
            })
        } else {
            None
        };

        if let Some((inherited_count, inherited_bytes, subtree_dir_entries)) = inheritance {
            // Apply inheritance directly to state — same effect as the
            // main loop's Inheritance message handler.
            state.inherited_dirs += 1 + subtree_dir_entries.len() as u64;
            state.inherited_files += inherited_count;
            state.bytes_seen += inherited_bytes;
            state.files_visited += inherited_count;
            rollup_directory_bytes(
                &state.root_path_string,
                &child_path_str,
                inherited_bytes,
                inherited_count,
                &mut state.directory_totals,
                &mut state.hottest_directories,
                state.input.top_directory_limit,
            );
            if let Some(writer) = state.index_writer.as_mut() {
                let _ = writer.write_dir_entry(&child_path_str, current_mtime);
                for (sub_path, sub_mtime) in &subtree_dir_entries {
                    let _ = writer.write_dir_entry(sub_path, *sub_mtime);
                }
            }
            // Mirror of the sequential path fix: populate
            // directory_totals for each inherited subtree dir so the
            // folder-tree sidecar's `d` arrays are complete. Without
            // this, inherited dirs only live in the index and the
            // Folders tab shows empty subtrees.
            if let Some(baseline) = baseline_opt.as_ref() {
                let root_path_snapshot = state.root_path_string.clone();
                for (sub, _mtime) in &subtree_dir_entries {
                    let sub_size = baseline.dir_total_sizes.get(sub).copied().unwrap_or(0);
                    let sub_fc = baseline.dir_file_counts.get(sub).copied().unwrap_or(0);
                    state
                        .directory_totals
                        .entry(sub.clone())
                        .or_insert_with(|| DirectoryHotspot {
                            path: sub.clone(),
                            size: sub_size,
                            file_count: sub_fc,
                            depth: directory_depth(&root_path_snapshot, sub),
                        });
                }
            }
            // Record the subtree prefix so the post-walk streamer copies
            // its file records out of the baseline index into the new
            // index. Without this the inherited file content would be
            // correctly counted but absent from the index, breaking the
            // next rescan's baseline.
            state.inherited_prefixes.push(child_path_str.clone());
            preseed_inheritance_hits += 1;
            continue;
        }

        // Cache miss — enumerate this level-1 dir on main so we can
        // seed the queue with its grandchildren. Files go straight
        // into state via record_file (no channel hop).
        state.directories_visited += 1;
        if let Some(writer) = state.index_writer.as_mut() {
            let _ = writer.write_dir_entry(&child_path_str, current_mtime);
        }
        let mut grandchildren: Vec<(PathBuf, Option<u64>)> = Vec::new();
        if let Err(err) = enumerate_windows_directory(&child_path, state, &mut grandchildren) {
            eprintln!(
                "[diskhound-native-scanner] parallel: preseed enumerate of {:?} failed: {err} — falling back to queue-seed for this dir",
                child_path
            );
            // Fall back to pushing the child itself so a worker retries it.
            seed_queue.push((child_path, child_mtime_hint));
            continue;
        }
        if grandchildren.is_empty() {
            // Leaf directory — fully processed on main, nothing to seed.
            continue;
        }
        seed_queue.extend(grandchildren);
        if let Err(err) = maybe_emit_progress(state) {
            eprintln!(
                "[diskhound-native-scanner] parallel: preseed progress emit failed: {err}"
            );
        }
    }
    eprintln!(
        "[diskhound-native-scanner] parallel: preseed took {} ms ({} entries queued, {} inheritance hits)",
        preseed_started.elapsed().as_millis(),
        seed_queue.len(),
        preseed_inheritance_hits
    );

    // If seed_queue is empty (all root children inheritance-hit or
    // were leaf dirs fully processed on main), workers spawn and
    // immediately see pending==0, set the shutdown flag, and exit
    // without doing any work. The post-walk inheritance streamer below
    // then copies the inherited file records out of the baseline.

    // Wrap baseline in Arc so all workers can read it lock-free. The
    // baseline HashMaps are immutable after load.
    let baseline_arc: Option<std::sync::Arc<Baseline>> = baseline_opt.map(std::sync::Arc::new);

    let shared = std::sync::Arc::new(ParallelSharedCtx {
        queue: ParallelWorkQueue::new(seed_queue),
        baseline: baseline_arc.clone(),
        baseline_can_inherit,
        mtime_syscalls_saved: std::sync::atomic::AtomicU64::new(0),
        io: Arc::clone(&state.io),
    });

    // Bounded channel so workers throttle to main's processing rate
    // instead of piling unbounded messages into memory. 50k cap ≈
    // 10-20 MB of in-flight messages in the worst case — plenty of
    // headroom for main to drain between progress emissions, and
    // short enough that memory stays sane even on pathological drives.
    let (tx, rx) = crossbeam_channel::bounded::<ParallelWorkerMessage>(50_000);

    eprintln!(
        "[diskhound-native-scanner] parallel: walking with {} workers (baseline_can_inherit={})",
        worker_count, baseline_can_inherit
    );
    let walk_started = Instant::now();

    let result = std::thread::scope(|scope| -> Result<(), String> {
        // Spawn workers.
        for worker_id in 0..worker_count {
            let tx = tx.clone();
            let shared = std::sync::Arc::clone(&shared);
            scope.spawn(move || parallel_worker_loop(worker_id, shared, tx));
        }
        // Drop main's tx clone so the channel disconnects when all
        // workers exit (each worker owns its own clone).
        drop(tx);

        // Main thread consumes messages + emits progress.
        main_parallel_recv_loop(&shared, rx, state)
    });

    // Read the syscall counter BEFORE dropping `shared` — once
    // dropped, we can't deref it. Local snapshot is fine.
    let syscalls_saved = shared
        .mtime_syscalls_saved
        .load(std::sync::atomic::Ordering::Relaxed);

    // Drop `shared` BEFORE the try_unwrap below. ParallelSharedCtx holds
    // a clone of `baseline_arc` in its `baseline` field; while `shared`
    // is alive, that clone keeps the Arc's strong_count at 2, and
    // try_unwrap fails. The consequence was catastrophic: post-walk
    // streaming became a no-op, inherited baseline records never got
    // written into the new index, and the UI reported a handful of
    // dirs (only the freshly walked ones) for an entire drive. Explicit
    // drop here is the fix — after it, the only strong ref is
    // `baseline_arc` itself, and try_unwrap hits the success path.
    drop(shared);
    state.baseline = baseline_arc.and_then(|a| match std::sync::Arc::try_unwrap(a) {
        Ok(b) => Some(b),
        Err(arc) => {
            // Only reachable now if a worker leaks an Arc beyond the
            // scope. Emit a loud error because this WILL truncate the
            // visible scan results; we'd rather fail loudly than
            // silently ship 24 dirs.
            eprintln!(
                "[diskhound-native-scanner] parallel: BASELINE Arc STILL has strong_count={} AFTER dropping shared — post-walk stream disabled, scan results will be TRUNCATED",
                std::sync::Arc::strong_count(&arc)
            );
            None
        }
    });

    let elapsed_ms = walk_started.elapsed().as_millis();
    eprintln!(
        "[diskhound-native-scanner] parallel: walk complete in {} ms, mtime syscalls saved via enum-hint: {}",
        elapsed_ms, syscalls_saved
    );

    // Post-walk streaming pass for inherited subtrees — identical to
    // the sequential scanner's tail. Runs on main, reads main's
    // already-restored baseline.
    if let Err(err) = &result {
        eprintln!("[diskhound-native-scanner] parallel: walk error: {err}");
    }
    if !state.inherited_prefixes.is_empty() {
        let baseline_path = state.baseline.as_ref().map(|b| b.baseline_path.clone());
        let inherited_prefixes = state.inherited_prefixes.clone();
        if let Some(path) = baseline_path {
            let _ = stream_inherited_files_into(&path, &inherited_prefixes, state);
            let _ = maybe_emit_progress(state);
        }
    }
    if state.baseline.is_some() {
        eprintln!(
            "[diskhound-native-scanner] Phase-1 inheritance (streaming): {} dirs skipped, {} files inherited",
            state.inherited_dirs, state.inherited_files,
        );
    }

    // Drop baseline memory now that both the walk and the streaming
    // pass are done — mirrors the sequential scanner's cleanup and
    // frees ~100 MB on big-drive scans before the Done snapshot.
    state.baseline = None;

    ParallelDispatch::Ran(result)
}

/// Main-thread message pump. Single-threaded state mutation + periodic
/// progress emissions. Returns when the channel disconnects (all
/// workers exited and dropped their Sender clones) or cancellation is
/// requested.
#[cfg(windows)]
fn main_parallel_recv_loop(
    shared: &std::sync::Arc<ParallelSharedCtx>,
    rx: crossbeam_channel::Receiver<ParallelWorkerMessage>,
    state: &mut ScanState,
) -> Result<(), String> {
    loop {
        if is_cancelled() {
            shared.queue.request_shutdown();
            break;
        }

        match rx.recv_timeout(std::time::Duration::from_millis(50)) {
            Ok(msg) => handle_parallel_message(state, msg)?,
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                break;
            }
        }
        // Drain everything currently available. Workers produce files
        // faster than main can bookkeep if we throttle the drain —
        // with an earlier 32-per-tick cap, 8 workers at ~1k files/sec
        // each (8k/sec total) backed up against main's ~640/sec drain
        // rate, saturating the bounded channel and making tile updates
        // look like they stalled until a burst at the end. 16k per tick
        // keeps progress responsive (tick every 50ms means worst-case
        // 50ms before the next maybe_emit_progress) while matching or
        // beating steady-state worker throughput.
        let mut burst = 0;
        while burst < 16_384 {
            match rx.try_recv() {
                Ok(msg) => {
                    handle_parallel_message(state, msg)?;
                    burst += 1;
                }
                Err(crossbeam_channel::TryRecvError::Empty) => break,
                Err(crossbeam_channel::TryRecvError::Disconnected) => {
                    return Ok(());
                }
            }
        }
        maybe_emit_progress(state)?;
    }

    // Drain anything left in-channel after shutdown so counters stay
    // consistent with the index content.
    while let Ok(msg) = rx.try_recv() {
        let _ = handle_parallel_message(state, msg);
    }
    Ok(())
}

#[cfg(windows)]
fn handle_parallel_message(
    state: &mut ScanState,
    msg: ParallelWorkerMessage,
) -> Result<(), String> {
    match msg {
        ParallelWorkerMessage::File(record) => record_file(state, record),
        ParallelWorkerMessage::DirEntered { path, mtime } => {
            state.directories_visited += 1;
            if let Some(writer) = state.index_writer.as_mut() {
                let _ = writer.write_dir_entry(&path, mtime);
            }
            Ok(())
        }
        ParallelWorkerMessage::Skipped => {
            state.skipped_entries += 1;
            Ok(())
        }
        ParallelWorkerMessage::Inheritance {
            dir_path,
            current_mtime,
            inherited_count,
            inherited_bytes,
            subtree_dir_entries,
        } => {
            // Counters — authoritative on main. Matches the sequential
            // path's inheritance block exactly.
            state.inherited_dirs += 1;
            state.inherited_files += inherited_count;
            state.files_visited += inherited_count;
            state.bytes_seen += inherited_bytes;
            state.directories_visited += 1 + subtree_dir_entries.len() as u64;
            state.inherited_prefixes.push(dir_path.clone());

            // Rollup the subtree's bytes onto the directory_totals map
            // so hottest_directories surfaces it correctly before the
            // post-walk streaming pass fills in file records.
            rollup_directory_bytes(
                &state.root_path_string,
                &dir_path,
                inherited_bytes,
                inherited_count,
                &mut state.directory_totals,
                &mut state.hottest_directories,
                state.input.top_directory_limit,
            );

            if let Some(writer) = state.index_writer.as_mut() {
                let _ = writer.write_dir_entry(&dir_path, current_mtime);
                for (sub, m) in &subtree_dir_entries {
                    let _ = writer.write_dir_entry(sub, *m);
                }
            }
            Ok(())
        }
    }
}

/// Per-worker loop. Pops a dir, checks inheritance, either sends one
/// aggregate Inheritance message or enumerates + sends per-file File
/// messages + pushes discovered subdirs back onto the queue.
#[cfg(windows)]
fn parallel_worker_loop(
    _worker_id: usize,
    shared: std::sync::Arc<ParallelSharedCtx>,
    tx: crossbeam_channel::Sender<ParallelWorkerMessage>,
) {
    while let Some((directory_path, mtime_hint)) = shared.queue.pop() {
        if is_cancelled() {
            shared.queue.mark_done();
            break;
        }

        let directory_path_str = normalize_path(&directory_path);
        let current_mtime = match mtime_hint {
            Some(m) => {
                shared
                    .mtime_syscalls_saved
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                m
            }
            None if !shared.baseline_can_inherit => 0,
            None => directory_mtime(&directory_path, &shared.io).unwrap_or(0),
        };

        // Phase-1 inheritance check — same shape as the sequential
        // scanner. Baseline is Arc, HashMap::get is lock-free.
        let inheritance = shared.baseline.as_ref().and_then(|baseline| {
            let baseline_mtime = *baseline.dir_mtimes.get(&directory_path_str)?;
            if current_mtime.abs_diff(baseline_mtime) >= 2 {
                return None;
            }
            let inherited_count = baseline
                .dir_file_counts
                .get(&directory_path_str)
                .copied()
                .unwrap_or(0);
            let inherited_bytes = baseline
                .dir_total_sizes
                .get(&directory_path_str)
                .copied()
                .unwrap_or(0);
            let subtree_dir_entries: Vec<(String, u64)> = baseline
                .subtree_dirs(&directory_path_str)
                .into_iter()
                .filter_map(|sub| baseline.dir_mtimes.get(&sub).map(|m| (sub, *m)))
                .collect();
            Some((inherited_count, inherited_bytes, subtree_dir_entries))
        });

        if let Some((inherited_count, inherited_bytes, subtree_dir_entries)) = inheritance {
            let _ = tx.send(ParallelWorkerMessage::Inheritance {
                dir_path: directory_path_str,
                current_mtime,
                inherited_count,
                inherited_bytes,
                subtree_dir_entries,
            });
            shared.queue.mark_done();
            continue;
        }

        // Announce this directory to main so the index gets its
        // {t:"d"} entry. Increments directories_visited on main.
        let _ = tx.send(ParallelWorkerMessage::DirEntered {
            path: directory_path_str,
            mtime: current_mtime,
        });

        // Enumerate + forward files / new subdirs. Any I/O error is
        // reported once via a Skipped message (same semantics as the
        // sequential scanner).
        let mut children: Vec<(PathBuf, Option<u64>)> = Vec::new();
        if let Err(err) =
            enumerate_windows_directory_parallel(&directory_path, &tx, &mut children, &shared.io)
        {
            eprintln!(
                "[diskhound-native-scanner] parallel: enumerate {} failed: {err}",
                directory_path.display()
            );
            let _ = tx.send(ParallelWorkerMessage::Skipped);
        }
        shared.queue.push_many(children);
        shared.queue.mark_done();
    }
}

/// Parallel-mode analogue of enumerate_windows_directory. Structurally
/// identical except it sends file records + subdir pushes via the
/// channel / children vec instead of touching a shared ScanState. Kept
/// separate from the sequential version so that path stays a trivial
/// `&mut ScanState` mutation — no risk of accidentally adding
/// channel-sending code in the hot sequential loop.
#[cfg(windows)]
fn enumerate_windows_directory_parallel(
    directory_path: &Path,
    tx: &crossbeam_channel::Sender<ParallelWorkerMessage>,
    children: &mut Vec<(PathBuf, Option<u64>)>,
    io: &IoStats,
) -> Result<(), String> {
    let search_pattern = windows_search_pattern(directory_path);
    let wide_search_pattern = windows_wide_string(&search_pattern);
    let mut find_data = unsafe { std::mem::zeroed::<WIN32_FIND_DATAW>() };

    io.count_readdir();
    let handle = unsafe {
        FindFirstFileExW(
            wide_search_pattern.as_ptr(),
            FindExInfoBasic,
            &mut find_data as *mut WIN32_FIND_DATAW as *mut _,
            FindExSearchNameMatch,
            std::ptr::null(),
            FIND_FIRST_EX_LARGE_FETCH,
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        let _ = tx.send(ParallelWorkerMessage::Skipped);
        return Ok(());
    }

    loop {
        let file_name = win32_name_to_string(&find_data.cFileName);
        if file_name != "." && file_name != ".." {
            let attributes = find_data.dwFileAttributes;
            let is_directory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
            let is_reparse_point = (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
            let is_device = (attributes & FILE_ATTRIBUTE_DEVICE) != 0;

            if is_reparse_point || is_device {
                let _ = tx.send(ParallelWorkerMessage::Skipped);
            } else if is_directory {
                let child_mtime = windows_filetime_to_unix_ms(
                    find_data.ftLastWriteTime.dwHighDateTime,
                    find_data.ftLastWriteTime.dwLowDateTime,
                );
                children.push((directory_path.join(&file_name), Some(child_mtime)));
            } else {
                let file_size = windows_find_data_occupancy(directory_path, &file_name, &find_data, io);
                let file_record = ScanFileRecord {
                    path: normalize_path(&directory_path.join(&file_name)),
                    name: file_name.clone(),
                    parent_path: normalize_path(directory_path),
                    extension: file_extension(&file_name),
                    size: file_size,
                    modified_at: windows_filetime_to_unix_ms(
                        find_data.ftLastWriteTime.dwHighDateTime,
                        find_data.ftLastWriteTime.dwLowDateTime,
                    ),
                };
                if tx.send(ParallelWorkerMessage::File(file_record)).is_err() {
                    // Main dropped the receiver (cancellation / shutdown).
                    // Stop enumerating immediately.
                    unsafe { FindClose(handle) };
                    return Ok(());
                }
            }
        }

        let found_next = unsafe { FindNextFileW(handle, &mut find_data) };
        if found_next == 0 {
            let error_code = unsafe { GetLastError() };
            if error_code != ERROR_NO_MORE_FILES {
                let _ = tx.send(ParallelWorkerMessage::Skipped);
            }
            break;
        }
    }

    unsafe {
        FindClose(handle);
    }

    Ok(())
}

/// Roll up already-summed file-count + byte-count onto a directory and
/// all its ancestors. Used by the Phase-1 inherit path where we're
/// crediting a whole subtree at once rather than one file at a time.
fn rollup_directory_bytes(
    root_path: &str,
    directory_path: &str,
    bytes: u64,
    file_count: u64,
    directory_totals: &mut HashMap<String, DirectoryHotspot>,
    hottest_directories: &mut Vec<DirectoryHotspot>,
    dir_limit: usize,
) {
    let mut current_path = directory_path.to_string();

    loop {
        let next_record = {
            let entry = directory_totals
                .entry(current_path.clone())
                .or_insert_with(|| DirectoryHotspot {
                    path: current_path.clone(),
                    size: 0,
                    file_count: 0,
                    depth: directory_depth(root_path, &current_path),
                });

            entry.size += bytes;
            entry.file_count += file_count;
            entry.clone()
        };

        upsert_ranked_directory(hottest_directories, next_record, dir_limit);

        if current_path == root_path {
            return;
        }

        let parent = Path::new(&current_path)
            .parent()
            .map(normalize_path)
            .unwrap_or_else(|| root_path.to_string());

        if parent == current_path {
            return;
        }

        current_path = parent;
    }
}

/// Return a directory's last-write time in Unix ms, or None on failure.
#[cfg(windows)]
fn directory_mtime(dir: &Path, io: &IoStats) -> Option<u64> {
    io.count_stat();
    let metadata = std::fs::metadata(dir).ok()?;
    let modified = metadata.modified().ok()?;
    Some(unix_timestamp_ms(modified))
}

#[cfg(windows)]
fn enumerate_windows_directory(
    directory_path: &Path,
    state: &mut ScanState,
    stack: &mut Vec<(PathBuf, Option<u64>)>,
) -> Result<(), String> {
    let io = Arc::clone(&state.io);
    let search_pattern = windows_search_pattern(directory_path);
    let wide_search_pattern = windows_wide_string(&search_pattern);
    let mut find_data = unsafe { std::mem::zeroed::<WIN32_FIND_DATAW>() };

    io.count_readdir();
    let handle = unsafe {
        FindFirstFileExW(
            wide_search_pattern.as_ptr(),
            FindExInfoBasic,
            &mut find_data as *mut WIN32_FIND_DATAW as *mut _,
            FindExSearchNameMatch,
            std::ptr::null(),
            FIND_FIRST_EX_LARGE_FETCH,
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        state.skipped_entries += 1;
        maybe_emit_progress(state)?;
        return Ok(());
    }

    loop {
        let file_name = win32_name_to_string(&find_data.cFileName);

        if file_name != "." && file_name != ".." {
          let attributes = find_data.dwFileAttributes;
          let is_directory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
          let is_reparse_point = (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
          let is_device = (attributes & FILE_ATTRIBUTE_DEVICE) != 0;

          if is_reparse_point || is_device {
              state.skipped_entries += 1;
          } else if is_directory {
              // Capture the child's mtime from the FindFirstFileExW data
              // so we don't have to re-stat it when it's popped later.
              // Saves one metadata() syscall per directory, which on a
              // 1M-dir drive used to add ~30-60 s of pure I/O wait to
              // every cold-cache scan.
              let child_mtime = windows_filetime_to_unix_ms(
                  find_data.ftLastWriteTime.dwHighDateTime,
                  find_data.ftLastWriteTime.dwLowDateTime,
              );
              stack.push((directory_path.join(&file_name), Some(child_mtime)));
          } else {
              let file_size = windows_find_data_occupancy(directory_path, &file_name, &find_data, &io);
              let file_record = ScanFileRecord {
                  path: normalize_path(&directory_path.join(&file_name)),
                  name: file_name.clone(),
                  parent_path: normalize_path(directory_path),
                  extension: file_extension(&file_name),
                  size: file_size,
                  modified_at: windows_filetime_to_unix_ms(
                      find_data.ftLastWriteTime.dwHighDateTime,
                      find_data.ftLastWriteTime.dwLowDateTime,
                  ),
              };
              record_file(state, file_record)?;
          }
        }

        let found_next = unsafe { FindNextFileW(handle, &mut find_data) };
        if found_next == 0 {
            let error_code = unsafe { GetLastError() };
            if error_code != ERROR_NO_MORE_FILES {
                state.skipped_entries += 1;
                maybe_emit_progress(state)?;
            }
            break;
        }
    }

    unsafe {
        FindClose(handle);
    }

    Ok(())
}

/// Windows walkers can't read link counts, so they keep `h:1` on a path
/// the previous index flagged. The Unix walker decides from the inode.
/// Windows has no APFS clone attributes to pass.
#[cfg(windows)]
fn record_file(state: &mut ScanState, file_record: ScanFileRecord) -> Result<(), String> {
    let extra_hardlink = state
        .baseline
        .as_ref()
        .is_some_and(|baseline| baseline.extra_hardlink_paths.contains(&file_record.path));
    record_file_with_link_flag(state, file_record, extra_hardlink, None)
}

/// An extra hardlink still counts as a file in its folder and keeps its
/// size in the index and folder-tree rows, but adds 0 bytes and stays off
/// the largest-files and extension lists. `clone` carries APFS clone
/// attributes from the macOS walker (None elsewhere).
fn record_file_with_link_flag(
    state: &mut ScanState,
    file_record: ScanFileRecord,
    extra_hardlink: bool,
    clone: Option<CloneAttrs>,
) -> Result<(), String> {
    let occupancy = if extra_hardlink { 0 } else { file_record.size };
    state.files_visited += 1;
    state.bytes_seen += occupancy;
    if let (Some(attrs), false) = (clone.as_ref(), extra_hardlink) {
        state.clone_totals.add(occupancy, attrs);
    }
    let file_limit = state.input.top_file_limit;
    let dir_limit = state.input.top_directory_limit;
    if !extra_hardlink {
        upsert_ranked_file(&mut state.largest_files, file_record.clone(), file_limit);
    }
    if state.defer_hottest_dir_ranking {
        // Cheap path: just tally into the HashMap, skip the per-file
        // top-N sort. Finalized once at end of emit.
        rollup_directory_size_tallies_only(
            &state.root_path_string,
            &file_record.parent_path,
            occupancy,
            &mut state.directory_totals,
        );
    } else {
        rollup_directory_size(
            &state.root_path_string,
            &file_record.parent_path,
            occupancy,
            &mut state.directory_totals,
            &mut state.hottest_directories,
            dir_limit,
        );
    }
    if !extra_hardlink {
        rollup_extension(
            &mut state.extension_totals,
            &file_record.extension,
            occupancy,
        );
    }
    // Folder-tree sidecar accumulator. Only populate when the caller
    // requested an output path — otherwise this is pure waste. Bucket
    // by parent_path so Node can render each folder's top files
    // without re-streaming the index.
    if state.input.folder_tree_output.is_some() {
        let list = state
            .folder_tree_files
            .entry(file_record.parent_path.clone())
            .or_insert_with(Vec::new);
        list.push((
            file_record.name.clone(),
            file_record.size,
            file_record.modified_at,
        ));
        // Soft cap at 2x the final cap — sort+truncate only when we
        // exceed the soft bound, amortizing the sort cost across many
        // inserts so the common "folder with 50 files" case pays no
        // extra per-file overhead.
        if list.len() > FOLDER_TREE_FILES_PER_PARENT * 2 {
            list.sort_by(|a, b| b.1.cmp(&a.1));
            list.truncate(FOLDER_TREE_FILES_PER_PARENT);
        }
    }

    // Best-effort index write. If it fails partway through the scan
    // (e.g. disk full), drop the writer so we stop trying but let the
    // snapshot protocol keep working.
    if let Some(writer) = state.index_writer.as_mut() {
        if writer
            .write_entry(&file_record.path, file_record.size, file_record.modified_at, extra_hardlink, clone)
            .is_err()
        {
            state.index_writer = None;
        }
    }

    maybe_emit_progress(state)
}

impl ScanState {
    fn snapshot(&self, status: ScanStatus, error_message: Option<String>) -> ScanSnapshot {
        let now_ms = unix_timestamp_ms(SystemTime::now());
        let elapsed_ms = self.started_at_instant.elapsed().as_millis() as u64;

        // Lite mode: Running-status emissions skip the heavy top-N
        // collections. Without this, every progress emit clones ~5000
        // ScanFileRecord + 10000 DirectoryHotspot and serializes ~1-2
        // MB of JSON — at 5 emits/sec that's 11 MB/sec of pipe traffic,
        // which stalls the scanner on stdout backpressure on Windows
        // (64 KB pipe buffer × Node readline accumulating full lines).
        // Final "Done" snapshots always carry the full payload.
        let lite = self.emit_lite_snapshots && matches!(status, ScanStatus::Running);

        // Top extensions are included even in lite snapshots — the
        // payload is tiny (max 12 entries × ~60 B each = <1 KB), well
        // below the pipe backpressure threshold, and the extensions
        // sidebar is the one element that DOES evolve meaningfully
        // during emit (new extensions cross the size threshold as
        // smaller files are processed). Suppressing it made the UI
        // feel frozen for users who watched the sidebar mid-scan.
        let mut top_extensions = self
            .extension_totals
            .values()
            .cloned()
            .collect::<Vec<_>>();
        top_extensions.sort_by(|left, right| right.size.cmp(&left.size));
        top_extensions.truncate(TOP_EXTENSION_LIMIT);

        // largest_files: always included during Running, but CAPPED to
        // 500 entries (~75 KB of JSON). This is what makes tiles
        // stream into the treemap mid-scan on BOTH code paths:
        //   - MFT parallel emit: shards publish to tile_slot, pump
        //     swaps into state.largest_files. Always-capped emit now
        //     surfaces them continuously instead of relying on a
        //     lite-flip hack.
        //   - Non-elevated walker: upsert_ranked_file updates
        //     state.largest_files on every file. With lite-mode
        //     previously erasing largest_files from Running snapshots,
        //     the walker NEVER streamed tiles at all. Now it does.
        //
        // Why 500 and not 200: users reported the final "Done" snapshot
        // with 5000 tiles caused a visible jump at scan-end ("they
        // abruptly all updated"). 500 gets close enough to the full
        // set that the end transition feels like a polish rather than
        // a redraw. Pipe-traffic cost is modest: 500 records * ~400 B
        // JSON = ~200 KB/emit; at 5 emits/sec that's 1 MB/sec, well
        // within Node's readline drain rate.
        let largest_files = if matches!(status, ScanStatus::Running) {
            const RUNNING_LARGEST_FILES_CAP: usize = 500;
            self.largest_files
                .iter()
                .take(RUNNING_LARGEST_FILES_CAP)
                .cloned()
                .collect()
        } else {
            self.largest_files.clone()
        };
        let hottest_directories = if lite {
            // hottest_directories: still gated by lite mode. Running
            // snapshots emit [] to avoid the 10k-entry sort per tick.
            // Folder-level stats show up once the Done snapshot lands.
            Vec::new()
        } else {
            self.hottest_directories.clone()
        };

        ScanSnapshot {
            status,
            engine: ScanEngine::NativeSidecar,
            root_path: Some(self.root_path_string.clone()),
            scan_options: ScanOptions {},
            started_at: Some(self.started_at_ms),
            finished_at: matches!(status, ScanStatus::Done).then_some(now_ms),
            elapsed_ms,
            files_visited: self.files_visited,
            directories_visited: self.directories_visited,
            skipped_entries: self.skipped_entries,
            bytes_seen: self.bytes_seen,
            largest_files,
            hottest_directories,
            top_extensions,
            error_message,
            last_updated_at: now_ms,
            scan_phase: self.scan_phase,
            expected_total_files: self.expected_total_files,
            storage_accounting: self.storage_accounting(),
        }
    }

    fn storage_accounting(&self) -> Option<StorageAccountingOut> {
        let totals = &self.clone_totals;
        if totals.measured_files == 0 {
            return None;
        }
        // Groups are only tracked when an index writer ran; zero groups
        // with clone files present still means "no duplicates seen".
        let duplicate_bytes = match (&self.clone_group_summary, self.scan_phase) {
            (Some(summary), _) => Some(summary.duplicate_bytes),
            (None, ScanPhase::Complete) if self.input.index_output.is_some() => Some(0),
            _ => None,
        };
        Some(StorageAccountingOut {
            measured_files: totals.measured_files,
            measured_bytes: totals.measured_bytes,
            clone_files: totals.clone_files,
            clone_bytes: totals.clone_bytes,
            clone_private_bytes: totals.clone_private_bytes,
            clone_duplicate_bytes: duplicate_bytes,
            approximate: self.clone_group_summary.is_some_and(|s| s.truncated),
        })
    }
}

/// Minimal Progress snapshot emitted before ScanState is built — during
/// the baseline-load phase of a rescan. All counters are zero; the UI
/// uses `status = Running` and `started_at` so it can show "Preparing…"
/// and start its live elapsed ticker instead of looking frozen.
fn early_running_snapshot(root_path: &str, started_at_ms: u64, elapsed_ms: u64) -> ScanSnapshot {
    let now_ms = unix_timestamp_ms(SystemTime::now());
    ScanSnapshot {
        status: ScanStatus::Running,
        engine: ScanEngine::NativeSidecar,
        root_path: Some(root_path.to_string()),
        scan_options: ScanOptions {},
        started_at: Some(started_at_ms),
        finished_at: None,
        elapsed_ms,
        files_visited: 0,
        directories_visited: 0,
        skipped_entries: 0,
        bytes_seen: 0,
        largest_files: Vec::new(),
        hottest_directories: Vec::new(),
        top_extensions: Vec::new(),
        error_message: None,
        last_updated_at: now_ms,
        scan_phase: ScanPhase::Starting,
        expected_total_files: None,
        storage_accounting: None,
    }
}

fn maybe_emit_progress(state: &mut ScanState) -> Result<(), String> {
    let elapsed_ms = state.started_at_instant.elapsed().as_millis();
    if elapsed_ms.saturating_sub(state.last_emit_elapsed_ms) < SNAPSHOT_INTERVAL_MS {
        return Ok(());
    }

    state.last_emit_elapsed_ms = elapsed_ms;
    emit_message(&Message::Progress {
        snapshot: state.snapshot(ScanStatus::Running, None),
    })
    .map_err(|error| error.to_string())
}

fn emit_message(message: &Message) -> io::Result<()> {
    let stdout = io::stdout();
    let mut writer = BufWriter::new(stdout.lock());
    serde_json::to_writer(&mut writer, message)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn parse_args() -> Result<ScanInput, String> {
    let mut root_path: Option<PathBuf> = None;
    let mut top_file_limit: Option<usize> = None;
    let mut top_directory_limit: Option<usize> = None;
    let mut index_output: Option<PathBuf> = None;
    let mut baseline_index: Option<PathBuf> = None;
    let mut folder_tree_output: Option<PathBuf> = None;
    let mut dev_artifacts_output: Option<PathBuf> = None;
    let mut expected_total_files: Option<u64> = None;
    let mut args = std::env::args().skip(1);

    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--root" => {
                let value = args
                    .next()
                    .ok_or_else(|| String::from("Expected a path after --root"))?;
                root_path = Some(PathBuf::from(value));
            }
            "--top-file-limit" => {
                let value = args
                    .next()
                    .ok_or_else(|| String::from("Expected a number after --top-file-limit"))?;
                top_file_limit = Some(
                    value.parse::<usize>().map_err(|_| format!("Invalid --top-file-limit: {value}"))?,
                );
            }
            "--top-directory-limit" => {
                let value = args
                    .next()
                    .ok_or_else(|| String::from("Expected a number after --top-directory-limit"))?;
                top_directory_limit = Some(
                    value.parse::<usize>().map_err(|_| format!("Invalid --top-directory-limit: {value}"))?,
                );
            }
            "--index-output" => {
                let value = args
                    .next()
                    .ok_or_else(|| String::from("Expected a path after --index-output"))?;
                index_output = Some(PathBuf::from(value));
            }
            "--baseline-index" => {
                let value = args
                    .next()
                    .ok_or_else(|| String::from("Expected a path after --baseline-index"))?;
                baseline_index = Some(PathBuf::from(value));
            }
            "--folder-tree-output" => {
                let value = args
                    .next()
                    .ok_or_else(|| String::from("Expected a path after --folder-tree-output"))?;
                folder_tree_output = Some(PathBuf::from(value));
            }
            "--dev-artifacts-output" => {
                let value = args
                    .next()
                    .ok_or_else(|| String::from("Expected a path after --dev-artifacts-output"))?;
                dev_artifacts_output = Some(PathBuf::from(value));
            }
            "--expected-files" => {
                let value = args
                    .next()
                    .ok_or_else(|| String::from("Expected a number after --expected-files"))?;
                expected_total_files = Some(
                    value.parse::<u64>().map_err(|_| format!("Invalid --expected-files: {value}"))?,
                );
            }
            unknown => {
                return Err(format!("Unknown argument: {unknown}"));
            }
        }
    }

    let root_path = root_path.ok_or_else(|| String::from("Missing required --root argument"))?;
    if !root_path.exists() {
        return Err(format!("Root path does not exist: {}", root_path.to_string_lossy()));
    }

    Ok(ScanInput {
        root_path,
        top_file_limit: top_file_limit.unwrap_or(DEFAULT_TOP_FILE_LIMIT),
        top_directory_limit: top_directory_limit.unwrap_or(DEFAULT_TOP_DIRECTORY_LIMIT),
        index_output,
        baseline_index,
        folder_tree_output,
        dev_artifacts_output,
        expected_total_files,
    })
}

fn file_extension(file_name: &str) -> String {
    Path::new(file_name)
        .extension()
        .and_then(OsStr::to_str)
        .map(|extension| format!(".{}", extension.to_ascii_lowercase()))
        .unwrap_or_else(|| String::from("(no ext)"))
}

#[cfg(not(windows))]
fn allocated_size(metadata: &std::fs::Metadata) -> u64 {
    metadata.blocks().saturating_mul(512)
}

#[cfg(not(windows))]
fn metadata_modified_at_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .map(unix_timestamp_ms)
        .unwrap_or(0)
}

fn unix_timestamp_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().into_owned();

    #[cfg(windows)]
    {
        if let Some(without_prefix) = normalized.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{}", without_prefix);
        }

        if let Some(without_prefix) = normalized.strip_prefix(r"\\?\") {
            return without_prefix.to_string();
        }
    }

    normalized
}

fn upsert_ranked_file(ranked: &mut Vec<ScanFileRecord>, next_record: ScanFileRecord, limit: usize) {
    if let Some(index) = ranked.iter().position(|candidate| candidate.path == next_record.path) {
        ranked.remove(index);
    } else if ranked.len() >= limit && next_record.size <= ranked.last().map(|r| r.size).unwrap_or(0) {
        return; // Too small to make the list
    }

    ranked.push(next_record);
    ranked.sort_by(|left, right| right.size.cmp(&left.size));
    ranked.truncate(limit);
}

fn upsert_ranked_directory(
    ranked: &mut Vec<DirectoryHotspot>,
    next_record: DirectoryHotspot,
    limit: usize,
) {
    if let Some(index) = ranked.iter().position(|candidate| candidate.path == next_record.path) {
        ranked[index] = next_record;
    } else if ranked.len() >= limit && next_record.size <= ranked.last().map(|r| r.size).unwrap_or(0) {
        return; // Too small to make the list
    } else {
        ranked.push(next_record);
    }

    ranked.sort_by(|left, right| right.size.cmp(&left.size));
    ranked.truncate(limit);
}

fn rollup_directory_size(
    root_path: &str,
    directory_path: &str,
    file_size: u64,
    directory_totals: &mut HashMap<String, DirectoryHotspot>,
    hottest_directories: &mut Vec<DirectoryHotspot>,
    dir_limit: usize,
) {
    let mut current_path = directory_path.to_string();

    loop {
        let next_record = {
            let entry = directory_totals
                .entry(current_path.clone())
                .or_insert_with(|| DirectoryHotspot {
                    path: current_path.clone(),
                    size: 0,
                    file_count: 0,
                    depth: directory_depth(root_path, &current_path),
                });

            entry.size += file_size;
            entry.file_count += 1;
            entry.clone()
        };

        upsert_ranked_directory(hottest_directories, next_record, dir_limit);

        if current_path == root_path {
            return;
        }

        let parent = Path::new(&current_path)
            .parent()
            .map(normalize_path)
            .unwrap_or_else(|| root_path.to_string());

        if parent == current_path {
            return;
        }

        current_path = parent;
    }
}

/// Hot path used during MFT emit: walk ancestors updating the
/// `directory_totals` HashMap only. Skips `upsert_ranked_directory`,
/// which was doing a full O(dir_limit log dir_limit) sort on every
/// file's every ancestor — trillions of ops on a 7M-file drive.
/// Callers must run `finalize_hottest_directories` after the walk so
/// `state.hottest_directories` is populated from the finished tallies.
fn rollup_directory_size_tallies_only(
    root_path: &str,
    directory_path: &str,
    file_size: u64,
    directory_totals: &mut HashMap<String, DirectoryHotspot>,
) {
    let mut current_path = directory_path.to_string();
    loop {
        // Hot path: use get_mut to avoid the String clone for the key
        // when the entry already exists (which is the 99% case on a
        // 7M-file drive with ~1.2M unique dirs). Only the rare "vacant"
        // branch pays the allocation cost.
        if let Some(entry) = directory_totals.get_mut(&current_path) {
            entry.size += file_size;
            entry.file_count += 1;
        } else {
            let depth = directory_depth(root_path, &current_path);
            directory_totals.insert(
                current_path.clone(),
                DirectoryHotspot {
                    path: current_path.clone(),
                    size: file_size,
                    file_count: 1,
                    depth,
                },
            );
        }

        if current_path == root_path {
            return;
        }
        let parent = Path::new(&current_path)
            .parent()
            .map(normalize_path)
            .unwrap_or_else(|| root_path.to_string());
        if parent == current_path {
            return;
        }
        current_path = parent;
    }
}

/// Rebuild `state.hottest_directories` from the full `directory_totals`
/// HashMap via a single sort — O(N_dirs log N_dirs). Called once after
/// the tally-only rollup finishes. Equivalent output to the incremental
/// upsert path, ~100× less work in aggregate on large drives.
fn finalize_hottest_directories(state: &mut ScanState) {
    let dir_limit = state.input.top_directory_limit;
    let mut all: Vec<DirectoryHotspot> =
        state.directory_totals.values().cloned().collect();
    all.sort_by(|left, right| right.size.cmp(&left.size));
    all.truncate(dir_limit);
    state.hottest_directories = all;
}

/// One NDJSON line in the folder-tree sidecar. Matches the format
/// Node's existing `readFolderTreeSidecar` expects (see
/// src/main.ts:1457 for the canonical schema):
///
///   {"k":"<parent>","d":[["<childPath>",size,fileCount]],"f":[["<name>",size,mtime]]}
///
/// k: parent path (the Map key Node stores)
/// d: direct child dirs — each row is `[path, size, fileCount]`
/// f: direct files — each row is `[name, size, modifiedAt]`
///
/// Line-oriented rather than one giant JSON object because the
/// serialized sidecar on a 7M-file drive exceeds V8's 512 MB string
/// length limit; stream-parsing line-by-line avoids the `RangeError:
/// Invalid string length` Node throws on `gunzipSync().toString()`.
#[derive(Serialize)]
#[allow(dead_code)]
struct FolderTreeSidecarLine<'a> {
    k: &'a str,
    // [path, size, fileCount]
    d: Vec<(&'a str, u64, u64)>,
    // [name, size, mtime]
    f: Vec<(&'a str, u64, u64)>,
}

/// Serialize the in-memory folder-tree accumulator to a gzipped JSON
/// sidecar. Runs after `finalize_hottest_directories` and before the
/// Done snapshot so the renderer sees a complete-looking scan even if
/// the sidecar write fails (we log and swallow sidecar errors; the
/// user gets the slower legacy fallback path in that case).
///
/// Cost on a 7M-file drive:
///   * Memory: temporarily clones `directory_totals` for the per-parent
///     subdir grouping (~200 MB), then drops it after serialization.
///   * CPU: one pass over folder_tree_files + one pass over
///     directory_totals; both O(N_dirs) which is ~1M. <1s total.
///   * Disk: ~30-50 MB gzipped (vs ~300 MB for the full NDJSON index).
/// Derive the folder-tree sidecar path that sits next to an index
/// file. Mirrors the Node-side derivation in scanIndex.ts:
///   `<id>.ndjson.gz` → `<id>.folder-tree.ndjson.gz`
fn sidecar_path_next_to(index_path: &Path) -> PathBuf {
    let as_str = index_path.to_string_lossy();
    if let Some(stripped) = as_str.strip_suffix(".ndjson.gz") {
        return PathBuf::from(format!("{}.folder-tree.ndjson.gz", stripped));
    }
    // Fallback: append alongside whatever the caller gave us.
    let mut out = index_path.as_os_str().to_os_string();
    out.push(".folder-tree.ndjson.gz");
    PathBuf::from(out)
}

fn write_folder_tree_sidecar(state: &mut ScanState) -> io::Result<()> {
    let output_path = match state.input.folder_tree_output.as_ref() {
        Some(p) => p.clone(),
        None => return Ok(()), // feature not requested
    };

    let sidecar_started = Instant::now();

    // Empty-accumulator short-circuit: walker's inheritance path
    // (100% unchanged subtrees) never calls `record_file`, so
    // `folder_tree_files` stays empty AND `directory_totals` only has
    // the inherited rollup entries — no per-folder file rows and no
    // per-parent subdir groupings populated during the walk. Writing
    // an "empty" sidecar would poison the Folders tab: ensureFolderTree
    // reads it, sees zero entries, returns an empty FolderTree, and
    // every drill-in shows "This folder appears empty in the scan
    // index."
    //
    // Instead: if we have a baseline index (rescan), copy its sidecar
    // to the new scan's sidecar path. The tree contents are still
    // accurate since nothing changed. This preserves the Folders-tab
    // fast path across rescans without needing to rebuild from
    // scratch.
    if state.folder_tree_files.is_empty() {
        // Guard against the "empty sidecar copy-chain" pathology: if a
        // prior scan wrote an empty/near-empty sidecar (e.g. because
        // `stream_inherited_files_into` didn't populate
        // folder_tree_files before 0.4.1), copying it forward would
        // perpetuate the emptiness into every subsequent rescan. An
        // empty NDJSON.gz file is about 20 bytes (gzip framing only).
        // 1 KB is safely under any real tree and safely over framing.
        const MIN_BASELINE_SIDECAR_BYTES: u64 = 1024;
        if let Some(baseline_idx) = state.input.baseline_index.as_ref() {
            let baseline_sidecar = sidecar_path_next_to(baseline_idx);
            let baseline_size = std::fs::metadata(&baseline_sidecar)
                .map(|m| m.len())
                .unwrap_or(0);
            if baseline_size >= MIN_BASELINE_SIDECAR_BYTES {
                match std::fs::copy(&baseline_sidecar, &output_path) {
                    Ok(bytes) => {
                        eprintln!(
                            "[diskhound-native-scanner] folder-tree sidecar: reused baseline sidecar ({:?}) — {} bytes copied to {:?} in {} ms (no tree work done on inheritance-only scan)",
                            baseline_sidecar,
                            bytes,
                            output_path,
                            sidecar_started.elapsed().as_millis()
                        );
                        return Ok(());
                    }
                    Err(err) => {
                        eprintln!(
                            "[diskhound-native-scanner] folder-tree sidecar: baseline copy failed ({err}) — falling through to empty write"
                        );
                    }
                }
            } else if baseline_size > 0 {
                eprintln!(
                    "[diskhound-native-scanner] folder-tree sidecar: baseline sidecar at {:?} is {} bytes (stale/empty) — NOT copying, will skip this scan's sidecar so Folders tab rebuilds from NDJSON",
                    baseline_sidecar, baseline_size
                );
            } else {
                eprintln!(
                    "[diskhound-native-scanner] folder-tree sidecar: no baseline sidecar at {:?} — cannot reuse on inheritance scan",
                    baseline_sidecar
                );
            }
        }
        // Empty accumulator + no usable baseline: don't write an empty
        // sidecar (that would poison the Folders tab). Node's loader
        // will see the missing file and fall through to the streaming
        // worker, same as pre-0.3.16 scans. Better a slow-load than a
        // fast-load-of-nothing.
        eprintln!(
            "[diskhound-native-scanner] folder-tree sidecar: accumulator empty + no baseline to copy — skipping sidecar write (Folders tab will rebuild from NDJSON)"
        );
        return Ok(());
    }

    // Step 1 — finalize files_by_parent: sort+truncate each list to the
    // cap (same logic Node previously did during its streaming build).
    // Done in-place on state.folder_tree_files.
    for list in state.folder_tree_files.values_mut() {
        if list.len() > FOLDER_TREE_FILES_PER_PARENT {
            list.sort_by(|a, b| b.1.cmp(&a.1));
            list.truncate(FOLDER_TREE_FILES_PER_PARENT);
        } else {
            list.sort_by(|a, b| b.1.cmp(&a.1));
        }
    }

    // Step 2 — group directory_totals by parent path. Node expects the
    // shape: parent → list of (subdir_path, size, file_count).
    // directory_totals is flat (path → totals), so we group by dirname.
    //
    // Keys and subdir paths are lowercased + trailing-slash-stripped
    // here to match the tree-key convention that `normPath` establishes
    // on Node. The folder-children IPC handler calls normPath on user
    // input before tree.get(), so any Rust-emitted key that isn't
    // already normalized misses every lookup — which is how "This
    // folder appears empty in the scan index" turned up for every dir
    // on the first Rust-written sidecar. File NAMES inside `f` stay
    // case-preserved since the UI displays them directly and case
    // matters to the user there.
    let normalize_tree_key = |p: &str| -> String {
        let trimmed = p.trim_end_matches(['\\', '/']);
        #[cfg(windows)]
        {
            trimmed.to_ascii_lowercase()
        }
        #[cfg(not(windows))]
        {
            trimmed.to_string()
        }
    };

    let mut dirs_by_parent: HashMap<String, Vec<(String, u64, u64)>> =
        HashMap::with_capacity(state.directory_totals.len() / 4);
    for (path, totals) in state.directory_totals.iter() {
        let parent = match Path::new(path).parent() {
            Some(p) => normalize_path(p),
            None => continue,
        };
        if parent == *path {
            continue;
        }
        let parent_key = normalize_tree_key(&parent);
        let child_path_key = normalize_tree_key(path);
        dirs_by_parent
            .entry(parent_key)
            .or_insert_with(Vec::new)
            .push((child_path_key, totals.size, totals.file_count));
    }

    // Step 3 — re-key folder_tree_files with the normalized parent
    // path so files and dirs share the same key convention. Without
    // this, `C:\Users\thoma` (files, original MFT case) and
    // `c:\users\thoma` (dirs, normalized) would split into two
    // NDJSON lines → Node's Map ends up with one node containing
    // only files and one containing only dirs; drill-in shows
    // either no files or no subdirs.
    let mut files_by_parent_normalized: HashMap<String, Vec<(String, u64, u64)>> =
        HashMap::with_capacity(state.folder_tree_files.len());
    for (parent, files) in state.folder_tree_files.iter() {
        let key = normalize_tree_key(parent);
        let entry = files_by_parent_normalized
            .entry(key)
            .or_insert_with(Vec::new);
        for (name, size, mtime) in files {
            entry.push((name.clone(), *size, *mtime));
        }
    }

    // Step 4 — collect the union of parents from both normalized maps.
    let mut all_parents: Vec<String> = Vec::new();
    {
        use std::collections::HashSet;
        let mut seen: HashSet<&str> = HashSet::new();
        for k in dirs_by_parent.keys() {
            if seen.insert(k.as_str()) {
                all_parents.push(k.clone());
            }
        }
        for k in files_by_parent_normalized.keys() {
            if seen.insert(k.as_str()) {
                all_parents.push(k.clone());
            }
        }
    }

    // Step 5 — parallel sidecar write. Split `all_parents` across N
    // worker threads; each serializes its chunk to Vec<u8> NDJSON
    // buffers (hand-rolled, bypassing serde_json allocator churn)
    // and sends them through a bounded channel to one writer thread
    // that owns the single gzip stream. Gzip is inherently sequential
    // on one stream, so the writer stays single-threaded — but
    // serialization (the expensive part, 50s → 10s on 1M parents)
    // parallelizes across all cores.
    //
    // Output order doesn't matter: Node's readFolderTreeSidecar
    // builds a Map keyed by parent path; insertion order is irrelevant.
    let shard_count = std::env::var("DISKHOUND_SIDECAR_THREADS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| n >= 1)
        .unwrap_or_else(|| num_cpus::get().clamp(1, 8))
        .max(1);

    let (tx, rx) = crossbeam_channel::bounded::<Vec<u8>>(512);
    let file = File::create(&output_path)?;
    let writer_handle = std::thread::spawn(move || -> io::Result<()> {
        let buffered = BufWriter::with_capacity(1 << 20, file);
        let mut encoder = GzEncoder::new(buffered, Compression::fast());
        while let Ok(buf) = rx.recv() {
            encoder.write_all(&buf)?;
        }
        let mut buffered = encoder.finish()?;
        buffered.flush()?;
        Ok(())
    });

    // Chunk parents round-robin so each shard gets a mix of
    // small-and-large folders (dirs with 200 files each are rare;
    // even chunking keeps per-shard CPU balanced regardless of
    // how the HashMap ordering happened to sort).
    let chunk_base = all_parents.len() / shard_count;
    let chunk_extra = all_parents.len() % shard_count;
    let mut shards: Vec<Vec<String>> = Vec::with_capacity(shard_count);
    let mut parents_iter = all_parents.into_iter();
    for i in 0..shard_count {
        let size = chunk_base + if i < chunk_extra { 1 } else { 0 };
        let mut shard = Vec::with_capacity(size);
        for _ in 0..size {
            if let Some(p) = parents_iter.next() {
                shard.push(p);
            }
        }
        shards.push(shard);
    }

    let lines_written: u64 = std::thread::scope(|scope| {
        let dirs_ref = &dirs_by_parent;
        let files_ref = &files_by_parent_normalized;
        let mut handles: Vec<std::thread::ScopedJoinHandle<u64>> =
            Vec::with_capacity(shard_count);
        for shard in shards {
            let tx = tx.clone();
            handles.push(scope.spawn(move || -> u64 {
                // 64 KB flush boundary — amortizes channel overhead
                // across ~300 NDJSON lines (~200 bytes each).
                const FLUSH_AT: usize = 64 * 1024;
                let mut buf: Vec<u8> = Vec::with_capacity(FLUSH_AT + 8192);
                let mut count: u64 = 0;
                for parent in &shard {
                    append_folder_tree_line(
                        &mut buf,
                        parent,
                        dirs_ref.get(parent),
                        files_ref.get(parent),
                    );
                    count += 1;
                    if buf.len() >= FLUSH_AT {
                        let _ = tx.send(std::mem::replace(
                            &mut buf,
                            Vec::with_capacity(FLUSH_AT + 8192),
                        ));
                    }
                }
                if !buf.is_empty() {
                    let _ = tx.send(buf);
                }
                count
            }));
        }
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or(0))
            .sum()
    });

    // Drop the outer tx so the writer thread's rx.recv() returns
    // Disconnected once all shard senders have also dropped.
    drop(tx);
    match writer_handle.join() {
        Ok(result) => result?,
        Err(_) => {
            return Err(io::Error::other(
                "folder-tree sidecar writer thread panicked",
            ));
        }
    }

    eprintln!(
        "[diskhound-native-scanner] folder-tree sidecar: {} parents written to {:?} in {} ms (parallel: {} shards)",
        lines_written,
        output_path,
        sidecar_started.elapsed().as_millis(),
        shard_count,
    );

    // Free the accumulator memory now that it's on disk — otherwise
    // these bytes live until the process exits.
    state.folder_tree_files.clear();
    state.folder_tree_files.shrink_to_fit();

    Ok(())
}

fn rollup_extension(
    extension_totals: &mut HashMap<String, ExtensionBucket>,
    extension: &str,
    file_size: u64,
) {
    let entry = extension_totals
        .entry(extension.to_string())
        .or_insert_with(|| ExtensionBucket {
            extension: extension.to_string(),
            size: 0,
            count: 0,
        });

    entry.size += file_size;
    entry.count += 1;
}

/// Hand-rolled NDJSON emitter for one folder-tree sidecar line:
///   `{"k":"<parent>","d":[["<path>",size,count],...],"f":[["<name>",size,mtime],...]}\n`
///
/// Mirrors `FolderTreeSidecarLine`'s serde shape exactly. Bypasses
/// serde_json to avoid the per-object allocator overhead that
/// dominated the serial sidecar write path (~50 s on 1M parents).
#[inline]
fn append_folder_tree_line(
    buf: &mut Vec<u8>,
    parent: &str,
    dirs: Option<&Vec<(String, u64, u64)>>,
    files: Option<&Vec<(String, u64, u64)>>,
) {
    buf.extend_from_slice(br#"{"k":""#);
    append_json_escaped(buf, parent.as_bytes());
    buf.extend_from_slice(br#"","d":["#);
    let mut first = true;
    if let Some(dir_list) = dirs {
        // Sort in place would require &mut; instead we inline a
        // small sort via indices. For typical dirs with <50 subdirs
        // an unsorted emit is also acceptable — Node re-sorts on read
        // anyway for display — but we preserve the existing "biggest
        // first" convention so dumps look right in grep.
        let mut indices: Vec<usize> = (0..dir_list.len()).collect();
        indices.sort_by(|&a, &b| dir_list[b].1.cmp(&dir_list[a].1));
        for idx in indices {
            let (path, size, count) = &dir_list[idx];
            if !first {
                buf.push(b',');
            }
            first = false;
            buf.push(b'[');
            buf.push(b'"');
            append_json_escaped(buf, path.as_bytes());
            buf.extend_from_slice(br#"","#);
            append_u64_decimal(buf, *size);
            buf.push(b',');
            append_u64_decimal(buf, *count);
            buf.push(b']');
        }
    }
    buf.extend_from_slice(br#"],"f":["#);
    let mut first = true;
    if let Some(file_list) = files {
        for (name, size, mtime) in file_list {
            if !first {
                buf.push(b',');
            }
            first = false;
            buf.push(b'[');
            buf.push(b'"');
            append_json_escaped(buf, name.as_bytes());
            buf.extend_from_slice(br#"","#);
            append_u64_decimal(buf, *size);
            buf.push(b',');
            append_u64_decimal(buf, *mtime);
            buf.push(b']');
        }
    }
    buf.extend_from_slice(b"]}\n");
}

/// Append the JSON-escaped form of `bytes` to `out`. Handles the
/// four escapes that appear in practice on Windows paths:
/// - `"` → `\"`
/// - `\` → `\\` (every path separator)
/// - control chars (< 0x20) → `\uXXXX`
/// All other bytes passed through verbatim. This is narrower than
/// full JSON string escaping but covers 100% of real file paths on
/// NTFS, which is the only thing fed to this writer.
#[inline]
fn append_json_escaped(out: &mut Vec<u8>, bytes: &[u8]) {
    // Fast scan for bytes needing escape — most path segments are
    // plain ASCII + backslashes. If we hit a run of safe bytes,
    // extend_from_slice once rather than pushing byte-at-a-time.
    let mut last_flush = 0;
    for (i, &b) in bytes.iter().enumerate() {
        let esc: Option<&[u8]> = match b {
            b'"' => Some(br#"\""#),
            b'\\' => Some(br"\\"),
            b'\n' => Some(br"\n"),
            b'\r' => Some(br"\r"),
            b'\t' => Some(br"\t"),
            0..=0x1f => None, // generic \u00xx handled below
            _ => {
                continue;
            }
        };
        // Flush the run of safe bytes preceding this one.
        if last_flush < i {
            out.extend_from_slice(&bytes[last_flush..i]);
        }
        if let Some(seq) = esc {
            out.extend_from_slice(seq);
        } else {
            // Generic \u00xx escape for control chars other than the
            // named ones above (rare on paths, but cheap to handle).
            const HEX: &[u8; 16] = b"0123456789abcdef";
            out.extend_from_slice(br"\u00");
            out.push(HEX[((b >> 4) & 0xf) as usize]);
            out.push(HEX[(b & 0xf) as usize]);
        }
        last_flush = i + 1;
    }
    if last_flush < bytes.len() {
        out.extend_from_slice(&bytes[last_flush..]);
    }
}

/// Append a u64's decimal representation to `out`. Avoids the
/// `format!` / `write!` machinery's allocator churn — instead emits
/// digits in reverse into a stack buffer, then copies out. Roughly 4×
/// faster than `write!` for tight loops.
#[inline]
fn append_u64_decimal(out: &mut Vec<u8>, mut n: u64) {
    if n == 0 {
        out.push(b'0');
        return;
    }
    // u64 max is 20 digits; 24 bytes gives comfortable headroom.
    let mut buf = [0u8; 24];
    let mut i = buf.len();
    while n > 0 {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
    }
    out.extend_from_slice(&buf[i..]);
}

fn directory_depth(root_path: &str, directory_path: &str) -> usize {
    let root = Path::new(root_path);
    let directory = Path::new(directory_path);
    directory
        .strip_prefix(root)
        .ok()
        .map(|relative| relative.components().count())
        .unwrap_or(0)
}

#[cfg(windows)]
fn win32_name_to_string(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|value| *value == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

#[cfg(windows)]
fn windows_filetime_to_unix_ms(high: u32, low: u32) -> u64 {
    let ticks = ((high as u64) << 32) | (low as u64);
    ticks
        .saturating_sub(WINDOWS_TO_UNIX_EPOCH_TICKS)
        .saturating_div(10_000)
}

#[cfg(windows)]
fn windows_wide_string(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn windows_search_pattern(directory_path: &Path) -> String {
    let extended_path = windows_extended_path(directory_path);
    if extended_path.ends_with('\\') {
        format!("{extended_path}*")
    } else {
        format!("{extended_path}\\*")
    }
}

/// Cloud placeholders that look huge logically but occupy little locally.
#[cfg(windows)]
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;

#[cfg(windows)]
fn windows_find_data_occupancy(
    directory_path: &Path,
    file_name: &str,
    find_data: &WIN32_FIND_DATAW,
    io: &IoStats,
) -> u64 {
    let logical = ((find_data.nFileSizeHigh as u64) << 32) | (find_data.nFileSizeLow as u64);
    let attributes = find_data.dwFileAttributes;
    const NEED_ALLOCATED: u32 = FILE_ATTRIBUTE_SPARSE_FILE
        | FILE_ATTRIBUTE_COMPRESSED
        | FILE_ATTRIBUTE_OFFLINE
        | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
    if attributes & NEED_ALLOCATED == 0 {
        return logical;
    }
    io.count_stat();
    windows_allocated_size(&directory_path.join(file_name)).unwrap_or(logical)
}

/// Explorer "Size on disk" via GetCompressedFileSizeW (cluster-rounded
/// allocated bytes after sparse holes and compression). The walker only
/// calls this for sparse/compressed/offline/cloud files; ordinary files
/// stay at FindFirstFile logical size. Elevated MFT scans use $DATA
/// allocated_size for every non-resident file.
#[cfg(windows)]
fn windows_allocated_size(path: &Path) -> Option<u64> {
    let wide = windows_wide_string(&windows_extended_path(path));
    let mut high: u32 = 0;
    let low = unsafe { GetCompressedFileSizeW(wide.as_ptr(), &mut high) };
    if low == INVALID_FILE_SIZE {
        let err = unsafe { GetLastError() };
        if err != 0 {
            return None;
        }
    }
    Some(((high as u64) << 32) | (low as u64))
}

#[cfg(windows)]
fn windows_extended_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().into_owned();
    if normalized.starts_with(r"\\?\") {
        return normalized;
    }

    if let Some(without_unc) = normalized.strip_prefix(r"\\") {
        return format!(r"\\?\UNC\{}", without_unc);
    }

    format!(r"\\?\{}", normalized)
}

#[cfg(test)]
mod index_line_parse_tests {
    use super::index_line::parse_index_line;
    use super::{append_json_escaped, append_u64_decimal};

    fn writer_file_line(path: &str, size: u64, mtime: u64, extra_hardlink: bool) -> String {
        let mut line = Vec::new();
        line.extend_from_slice(br#"{"p":""#);
        append_json_escaped(&mut line, path.as_bytes());
        line.extend_from_slice(br#"","s":"#);
        append_u64_decimal(&mut line, size);
        line.extend_from_slice(br#","m":"#);
        append_u64_decimal(&mut line, mtime);
        if extra_hardlink {
            line.extend_from_slice(br#","h":1"#);
        }
        line.push(b'}');
        String::from_utf8(line).unwrap()
    }

    fn writer_dir_line(path: &str, mtime: u64) -> String {
        let mut line = Vec::new();
        line.extend_from_slice(br#"{"p":""#);
        append_json_escaped(&mut line, path.as_bytes());
        line.extend_from_slice(br#"","t":"d","m":"#);
        append_u64_decimal(&mut line, mtime);
        line.push(b'}');
        String::from_utf8(line).unwrap()
    }

    #[test]
    fn canonical_file_unescapes_windows_path() {
        let line = writer_file_line(r"C:\Users\foo.txt", 123, 456, false);
        let rec = parse_index_line(&line).unwrap();
        assert_eq!(rec.path, r"C:\Users\foo.txt");
        assert_eq!(rec.size, Some(123));
        assert_eq!(rec.mtime, Some(456));
        assert!(!rec.is_dir);
        assert!(!rec.extra_hardlink);
    }

    #[test]
    fn canonical_file_keeps_hardlink_flag() {
        let line = writer_file_line(r"C:\cache\a", 10, 1, true);
        let rec = parse_index_line(&line).unwrap();
        assert!(rec.extra_hardlink);
        assert_eq!(rec.size, Some(10));
    }

    #[test]
    fn canonical_dir_line() {
        let line = writer_dir_line(r"C:\Users", 99);
        let rec = parse_index_line(&line).unwrap();
        assert!(rec.is_dir);
        assert_eq!(rec.path, r"C:\Users");
        assert_eq!(rec.mtime, Some(99));
        assert_eq!(rec.size, None);
        assert!(!rec.extra_hardlink);
    }

    #[test]
    fn odd_field_order_still_parses() {
        let line = r#"{"m":9,"t":"d","p":"D:\\proj"}"#;
        let rec = parse_index_line(line).unwrap();
        assert!(rec.is_dir);
        assert_eq!(rec.path, r"D:\proj");
        assert_eq!(rec.mtime, Some(9));
    }

    #[test]
    fn odd_file_order_keeps_occupancy_flag() {
        let line = r#"{"h":1,"s":50,"p":"C:\\a.bin","m":3}"#;
        let rec = parse_index_line(line).unwrap();
        assert!(!rec.is_dir);
        assert_eq!(rec.path, r"C:\a.bin");
        assert_eq!(rec.size, Some(50));
        assert!(rec.extra_hardlink);
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_index_line("not json").is_none());
        assert!(parse_index_line("").is_none());
        assert!(parse_index_line(r#"{"s":1}"#).is_none());
    }
}

#[cfg(all(test, unix))]
mod unix_hardlink_scan_tests {
    use super::*;
    use crate::test_support::{test_state, TempTree};
    use std::fs;
    use std::os::unix::fs::MetadataExt;

    /// Scan `root` and return the state plus every file path the index
    /// flagged `h:1`, sorted.
    fn scan(root: &Path, index_output: &Path) -> (ScanState, Vec<String>) {
        let mut state = test_state(root, index_output);
        scan_generic(root, &mut state).unwrap();
        state.index_writer.take().unwrap().finish().0.unwrap();

        let reader = BufReader::new(GzDecoder::new(File::open(index_output).unwrap()));
        let mut extra: Vec<String> = reader
            .lines()
            .map(|line| line.unwrap())
            .filter_map(|line| index_line::parse_index_line(&line))
            .filter(|rec| rec.extra_hardlink)
            .map(|rec| rec.path)
            .collect();
        extra.sort();
        (state, extra)
    }

    fn occupancy(path: &Path) -> u64 {
        fs::metadata(path).unwrap().blocks() * 512
    }

    #[test]
    fn hardlinked_bytes_count_once_and_later_links_are_flagged() {
        let tree = TempTree::new("hardlinks");
        let root = tree.path("root");
        let shared = tree.write("root/a.bin", 64 * 1024);
        tree.link(&shared, "root/sub/b.bin");
        tree.link(&shared, "root/sub/deeper/c.bin");
        let solo = tree.write("root/solo.bin", 16 * 1024);
        // Other name lives outside the scan root: the link inside owns it.
        let outside = tree.write("elsewhere/lib.so", 32 * 1024);
        tree.link(&outside, "root/vendor/lib.so");
        let index = tree.path("index.ndjson.gz");

        let (state, extra) = scan(&root, &index);

        let root_s = normalize_path(&root);
        assert_eq!(state.files_visited, 5);
        assert_eq!(
            state.bytes_seen,
            occupancy(&shared) + occupancy(&solo) + occupancy(&outside)
        );
        assert_eq!(
            extra,
            vec![
                format!("{root_s}/sub/b.bin"),
                format!("{root_s}/sub/deeper/c.bin"),
            ]
        );

        let sub = &state.directory_totals[&format!("{root_s}/sub")];
        assert_eq!(sub.size, 0, "a folder of extra links adds no bytes");
        assert_eq!(sub.file_count, 2, "extra links still count as files");
        assert_eq!(state.directory_totals[&root_s].size, state.bytes_seen);

        let largest: Vec<&str> = state.largest_files.iter().map(|f| f.path.as_str()).collect();
        assert!(largest.contains(&format!("{root_s}/a.bin").as_str()));
        assert!(!largest.iter().any(|p| p.contains("/sub/")));
        assert_eq!(state.largest_files.len(), 3);
    }

    #[test]
    fn owner_is_the_first_link_in_walk_order_not_creation_order() {
        let tree = TempTree::new("hardlink-owner");
        let root = tree.path("root");
        // Created first, but deeper: a file in the root is reached first.
        let original = tree.write("root/aaa/original.bin", 8 * 1024);
        tree.link(&original, "root/zzz.bin");
        tree.link(&original, "root/bbb/copy.bin");
        // Subdirectories go by name, not creation or readdir order.
        let made_first = tree.write("root/zeta/made-first.bin", 4 * 1024);
        tree.link(&made_first, "root/alpha/made-second.bin");
        let root_s = normalize_path(&root);

        for run in 0..2 {
            let index = tree.path(&format!("index-{run}.ndjson.gz"));
            let (state, extra) = scan(&root, &index);
            assert_eq!(state.bytes_seen, occupancy(&original) + occupancy(&made_first));
            assert_eq!(
                extra,
                vec![
                    format!("{root_s}/aaa/original.bin"),
                    format!("{root_s}/bbb/copy.bin"),
                    format!("{root_s}/zeta/made-first.bin"),
                ],
                "scan {run} picked a different owner"
            );
        }
    }
}

/// Each directory is read once, each entry statted once, and each path
/// lands in the index once. Budgets live in io-budgets.json.
#[cfg(all(test, unix))]
mod unix_visit_once_tests {
    use super::*;
    use crate::index_line::IndexLineRec;
    use crate::test_support::*;
    use std::os::unix::fs::symlink;

    const DIRS: u64 = 4;
    const FILES: u64 = 4;

    /// Directories root, b, b/d and g (empty). Files a.txt, b/c.txt,
    /// b/d/e.txt, and b/d/f.txt, a second link to a.txt. Two symlinks the
    /// walker must neither follow nor stat.
    fn fixture(tree: &TempTree) -> PathBuf {
        let a = tree.write("root/a.txt", 1024);
        tree.write("root/b/c.txt", 2048);
        tree.write("root/b/d/e.txt", 4096);
        tree.link(&a, "root/b/d/f.txt");
        tree.mkdir("root/g");
        symlink(tree.path("root/b"), tree.path("root/link-dir")).unwrap();
        symlink(&a, tree.path("root/link-file")).unwrap();
        tree.path("root")
    }

    fn assert_walked_once(state: &ScanState, index: &[IndexLineRec]) {
        assert_eq!(state.directories_visited, DIRS);
        assert_eq!(state.files_visited, FILES);
        assert_eq!(state.io.readdir_calls(), DIRS, "one read_dir per directory");
        assert_eq!(
            state.io.stat_calls(),
            FILES + DIRS,
            "one lstat per file, and one per directory for its index mtime"
        );
        let (dirs, files) = assert_listed_once(index);
        assert_eq!(dirs.len() as u64, DIRS);
        assert_eq!(files.len() as u64, FILES);
        assert_each_inode_owned_once(index);
    }

    #[test]
    fn walk_reads_each_directory_once_and_stats_each_entry_once() {
        let tree = TempTree::new("visit-once");
        let root = fixture(&tree);
        let index_path = tree.path("index.ndjson.gz");

        let mut state = test_state(&root, &index_path);
        scan_generic(&root, &mut state).unwrap();
        let index = finish_index(&mut state, &index_path);

        assert_walked_once(&state, &index);
        expect_io_budget(
            "native-unix/walk",
            measured(
                "4 dirs, 4 files (one a second hardlink), 2 symlinks: 1 read_dir per dir, \
                 1 lstat per dir (its index mtime) and per file, nothing for symlinks",
                &state.io,
                None,
            ),
        );
    }

    #[test]
    fn rescan_takes_the_file_count_without_reading_the_baseline() {
        let tree = TempTree::new("visit-once-rescan");
        let root = fixture(&tree);
        let first_index = tree.path("first.ndjson.gz");
        let mut first = test_state(&root, &first_index);
        scan_generic(&root, &mut first).unwrap();
        finish_index(&mut first, &first_index);

        let index_path = tree.path("rescan.ndjson.gz");
        let input = ScanInput {
            baseline_index: Some(first_index.clone()),
            expected_total_files: Some(FILES),
            ..scan_input(&root, &index_path)
        };
        let io = Arc::new(IoStats::default());
        let baseline = load_baseline(&input, &io, &normalize_path(&root), 0, Instant::now());
        assert!(baseline.is_none(), "the Unix walker never inherits, so it never loads one");
        let mut state = state_for(input, baseline, io);
        scan_generic(&root, &mut state).unwrap();
        let index = finish_index(&mut state, &index_path);

        assert_eq!(state.expected_total_files, Some(FILES));
        assert_walked_once(&state, &index);
        expect_io_budget(
            "native-unix/rescan-with-baseline",
            measured(
                "same tree, --baseline-index and --expected-files given: the walk's cost and \
                 0 baseline passes (was 1 full decompress and parse, only to read the root's \
                 file count)",
                &state.io,
                Some(&first_index),
            ),
        );
    }
}

/// The FindFirstFile walkers: each directory listed once, the root
/// statted once, and each path in the index once, whichever walker
/// finishes the scan.
#[cfg(all(test, windows))]
mod windows_visit_once_tests {
    use super::*;
    use crate::index_line::IndexLineRec;
    use crate::test_support::*;

    fn walk(state: &mut ScanState, root: &Path, index_path: &Path) -> Vec<IndexLineRec> {
        walk_windows(root, state, true).unwrap();
        finish_index(state, index_path)
    }

    fn assert_walked_once(state: &ScanState, index: &[IndexLineRec], dirs: u64, files: u64) {
        assert_eq!(state.directories_visited, dirs);
        assert_eq!(state.files_visited, files);
        let (listed_dirs, listed_files) = assert_listed_once(index);
        assert_eq!(listed_dirs.len() as u64, dirs);
        assert_eq!(listed_files.len() as u64, files);
    }

    #[test]
    fn root_without_subfolders_is_listed_and_recorded_once() {
        let tree = TempTree::new("win-flat-root");
        tree.write("root/a.txt", 1024);
        tree.write("root/b.txt", 2048);
        tree.write("root/c.txt", 4096);
        let root = tree.path("root");
        let index_path = tree.path("index.ndjson.gz");

        let mut state = test_state(&root, &index_path);
        let index = walk(&mut state, &root, &index_path);

        assert_walked_once(&state, &index, 1, 3);
        assert_eq!(state.bytes_seen, 1024 + 2048 + 4096);
        let txt = state.extension_totals.get(".txt").map(|b| b.count);
        assert_eq!(txt, Some(3));
        assert_eq!(state.io.readdir_calls(), 1);
        expect_io_budget(
            "native-windows/root-without-subfolders",
            measured(
                "root with 3 files and no subfolders: 1 listing, 1 stat (root mtime). \
                 Was 2 listings, with every root file counted and indexed twice",
                &state.io,
                None,
            ),
        );
    }

    #[test]
    fn root_with_one_subfolder_is_listed_and_recorded_once() {
        let tree = TempTree::new("win-one-subfolder");
        tree.write("root/a.txt", 1024);
        tree.write("root/sub/b.txt", 2048);
        tree.write("root/sub/deeper/c.txt", 4096);
        let root = tree.path("root");
        let index_path = tree.path("index.ndjson.gz");

        let mut state = test_state(&root, &index_path);
        let index = walk(&mut state, &root, &index_path);

        assert_walked_once(&state, &index, 3, 3);
        assert_eq!(state.bytes_seen, 1024 + 2048 + 4096);
        assert_eq!(state.io.readdir_calls(), 3);
        expect_io_budget(
            "native-windows/root-with-one-subfolder",
            measured(
                "3 dirs in a chain, 1 file each: 1 listing per dir, 1 stat (root mtime; \
                 subfolders take theirs from the parent listing). Was 4 listings, root files twice",
                &state.io,
                None,
            ),
        );
    }

    fn parallel_fixture(tree: &TempTree) -> PathBuf {
        tree.write("root/a.txt", 1024);
        tree.write("root/x/one.txt", 2048);
        tree.write("root/y/two.txt", 4096);
        tree.write("root/y/z/three.txt", 8192);
        tree.path("root")
    }

    #[test]
    fn parallel_walk_lists_each_directory_once() {
        let tree = TempTree::new("win-parallel");
        let root = parallel_fixture(&tree);
        let index_path = tree.path("index.ndjson.gz");

        let mut state = test_state(&root, &index_path);
        let index = walk(&mut state, &root, &index_path);

        assert_walked_once(&state, &index, 4, 4);
        assert_eq!(state.io.readdir_calls(), 4);
        expect_io_budget(
            "native-windows/parallel",
            measured(
                "4 dirs (2 under the root), 4 files: the parallel walker runs; 1 listing per \
                 dir, 1 stat (root mtime)",
                &state.io,
                None,
            ),
        );
    }

    #[test]
    fn unchanged_root_is_inherited_with_one_stat() {
        let tree = TempTree::new("win-unchanged-root");
        let root = parallel_fixture(&tree);
        let first_index = tree.path("first.ndjson.gz");
        let mut first = test_state(&root, &first_index);
        let first_lines = walk(&mut first, &root, &first_index);
        let (_, first_files) = assert_listed_once(&first_lines);

        let index_path = tree.path("rescan.ndjson.gz");
        let input = ScanInput {
            baseline_index: Some(first_index.clone()),
            ..scan_input(&root, &index_path)
        };
        let io = Arc::new(IoStats::default());
        let baseline = Baseline::load_metadata(&first_index, &io, |_| {});
        assert!(baseline.is_some());
        let mut state = state_for(input, baseline, io);
        let index = walk(&mut state, &root, &index_path);

        assert_eq!(state.inherited_dirs, 1, "the root is inherited whole");
        assert_walked_once(&state, &index, 4, 4);
        assert_eq!(assert_listed_once(&index).1, first_files);
        assert_eq!(state.io.readdir_calls(), 0);
        expect_io_budget(
            "native-windows/unchanged-root",
            measured(
                "rescan of the parallel tree with nothing changed: 1 stat (root mtime, handed \
                 to the sequential walker, which used to stat it again), no listings, 2 baseline \
                 passes (load, then copy the inherited files)",
                &state.io,
                Some(&first_index),
            ),
        );
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_mount_tests {
    use super::{duplicate_mount_paths, foreign_mount_points, parse_mountinfo, unescape_mountinfo};
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
