use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;

/// Global cancellation flag — set by signal handlers.
static CANCELLED: AtomicBool = AtomicBool::new(false);

// dua-core hands out std's Metadata on Linux and its own on macOS.
#[cfg(all(unix, not(target_os = "macos")))]
use std::os::unix::fs::MetadataExt;
use serde::Serialize;

#[cfg(windows)]
mod usn_journal;
mod usn_aggregate;

#[cfg(windows)]
mod mft;

mod sample;
mod dev_artifacts;
mod index_line;
#[cfg(not(windows))]
mod hardlinks;
#[cfg(not(windows))]
mod walk_prune;
#[cfg(test)]
mod test_support;

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

/// Folder-tree file rows: biggest first, ties by name, so the rows kept
/// under the cap are the same whatever order the walk found them in.
fn folder_tree_file_order(a: &(String, u64, u64), b: &(String, u64, u64)) -> std::cmp::Ordering {
    b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0))
}

/// Step counter for the scaling tests: one step per comparison or per
/// entry a loop examines. Compiles to nothing outside `cargo test`.
mod work {
    #[cfg(test)]
    thread_local! {
        static STEPS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    }

    #[inline(always)]
    pub(crate) fn step() {
        #[cfg(test)]
        STEPS.with(|steps| steps.set(steps.get() + 1));
    }

    /// Steps counted on this thread since the last call.
    #[cfg(test)]
    pub(crate) fn take() -> u64 {
        STEPS.with(|steps| steps.replace(0))
    }
}

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
/// - `readdir_calls`: directory listings (dua-core's reads, `FindFirstFileExW`).
/// - `stat_calls`: per-path metadata reads (`symlink_metadata`, `metadata`,
///   `GetCompressedFileSizeW`). The Unix walker's happen inside dua-core;
///   `count_walker_stat` says how they are counted.
/// - `baseline_bytes_read`: compressed bytes read from `--baseline-index`.
///   Divided by the file's size, it is the number of passes over it.
///
/// Not counted: `canonicalize` of the root and the MFT read.
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
    handle: Option<std::thread::JoinHandle<io::Result<()>>>,
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
            .spawn(move || -> io::Result<()> {
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
                let mut run = SortedRun::new(SORTED_RUN_BYTES);
                while let Ok(msg) = rx.recv() {
                    match msg {
                        IndexWriteMsg::File {
                            path,
                            size,
                            mtime,
                            extra_hardlink,
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
                            line.extend_from_slice(b"}\n");
                            run.write(&mut encoder, &line)?;
                            if let Some(acc) = &dev_acc_thread {
                                acc.lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .add(&path, size, extra_hardlink);
                            }
                        }
                        IndexWriteMsg::Dir { path, mtime } => {
                            line.clear();
                            line.extend_from_slice(br#"{"p":""#);
                            append_json_escaped(&mut line, path.as_bytes());
                            line.extend_from_slice(br#"","t":"d","m":"#);
                            append_u64_decimal(&mut line, mtime);
                            line.extend_from_slice(b"}\n");
                            run.write(&mut encoder, &line)?;
                        }
                        IndexWriteMsg::Finish => break,
                    }
                }
                run.flush(&mut encoder)?;
                let mut buffered = encoder.finish()?;
                buffered.flush()?;
                Ok(())
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

    fn write_entry(&mut self, path: &str, size: u64, mtime: u64, extra_hardlink: bool) -> io::Result<()> {
        if let Some(tx) = self.tx.as_ref() {
            tx.send(IndexWriteMsg::File {
                path: path.to_string(),
                size,
                mtime,
                extra_hardlink,
            })
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "index writer thread exited"))?;
        }
        Ok(())
    }

    /// Signal the writer thread to finish pending messages, close the
    /// gzip stream cleanly, and flush to disk. Blocks on the join so
    /// the caller knows the file is complete before returning.
    fn finish(mut self) -> io::Result<()> {
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(IndexWriteMsg::Finish);
            drop(tx);
        }
        let join_err = if let Some(handle) = self.handle.take() {
            match handle.join() {
                Ok(result) => result.err(),
                Err(_) => Some(io::Error::other("index writer thread panicked")),
            }
        } else {
            None
        };
        // Write the Dev sidecar even if gzip finish failed — classify
        // already ran on every file the writer accepted.
        if let (Some(out), Some(acc)) = (self.dev_output.take(), self.dev_acc.take()) {
            let guard = acc.lock().unwrap_or_else(|e| e.into_inner());
            match dev_artifacts::write_sidecar(&out, &self.scan_root, &guard) {
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
        match join_err {
            Some(err) => Err(err),
            None => Ok(()),
        }
    }
}

/// The Unix walker yields entries in the order its parallel reads finish,
/// and APFS lists a folder's names in hash order. gzip finds repeats only
/// within 32 KB, so the index writer sorts its lines in runs of this many
/// bytes before compressing them. On a warm ~/github (625k files, 112 MB
/// of lines) the index took 24.5 MB in arrival order, 14.6 MB in 16 MB
/// sorted runs, and 13.6 MB from jwalk, which walked in sorted order.
/// Windows walkers keep their order.
const SORTED_RUN_BYTES: usize = if cfg!(windows) { 0 } else { 16 << 20 };

/// Index lines held for sorting, up to `cap` bytes (0 writes them
/// through). See `SORTED_RUN_BYTES`.
struct SortedRun {
    cap: usize,
    bytes: Vec<u8>,
    lines: Vec<std::ops::Range<usize>>,
}

impl SortedRun {
    fn new(cap: usize) -> Self {
        SortedRun { cap, bytes: Vec::new(), lines: Vec::new() }
    }

    fn write(&mut self, out: &mut impl Write, line: &[u8]) -> io::Result<()> {
        if self.cap == 0 {
            return out.write_all(line);
        }
        let start = self.bytes.len();
        self.bytes.extend_from_slice(line);
        self.lines.push(start..self.bytes.len());
        if self.bytes.len() >= self.cap {
            self.flush(out)?;
        }
        Ok(())
    }

    fn flush(&mut self, out: &mut impl Write) -> io::Result<()> {
        let bytes = &self.bytes;
        self.lines.sort_unstable_by(|a, b| {
            work::step();
            bytes[a.clone()].cmp(&bytes[b.clone()])
        });
        for range in self.lines.drain(..) {
            work::step();
            out.write_all(&bytes[range])?;
        }
        self.bytes.clear();
        Ok(())
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
    /// Mount points below the root the walk left out because they are
    /// another disk. The UI links the ones with a drive pill.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    skipped_mounts: Vec<String>,
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
    largest_files: LargestFiles,
    /// Ranked from `directory_totals` by `finalize_hottest_directories`
    /// at the end of a scan and by `refresh_hottest_directories` for
    /// progress snapshots. Rollups only update the tallies.
    hottest_directories: Vec<DirectoryHotspot>,
    /// `files_visited` at which a progress snapshot may re-rank
    /// `hottest_directories`. See `refresh_hottest_directories`.
    hottest_directories_due_at: u64,
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
    /// Disk touches so far. Shared with walker threads.
    io: Arc<IoStats>,
    /// Other disks the walk left out. See walk_prune.
    skipped_mounts: Vec<String>,
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
            largest_files: LargestFiles::new(input.top_file_limit),
            hottest_directories: Vec::with_capacity(input.top_directory_limit),
            hottest_directories_due_at: 0,
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
            io,
            skipped_mounts: Vec::new(),
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
    /// Every dir path in the baseline, sorted, so the dirs under one
    /// folder are a single run found by binary search. Used to re-emit dir
    /// entries under inherited subtrees in the new index.
    dirs: Vec<String>,
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

        let mut dirs: Vec<String> = dirs.into_iter().collect();
        dirs.sort_unstable();

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

    /// Return all directory paths under the given dir, not the dir itself.
    /// Used when we inherit a subtree so we can re-emit dir entries in the
    /// new index. O(log dirs + subtree): it runs once per inherited folder,
    /// and scanning every baseline dir each time was O(folders²).
    fn subtree_dirs(&self, dir_path: &str) -> Vec<String> {
        let prefix = if dir_path.ends_with(std::path::MAIN_SEPARATOR) {
            dir_path.to_string()
        } else {
            format!("{}{}", dir_path, std::path::MAIN_SEPARATOR)
        };
        let start = self.dirs.partition_point(|d| {
            work::step();
            d.as_str() < prefix.as_str()
        });
        self.dirs[start..]
            .iter()
            .take_while(|d| {
                work::step();
                d.starts_with(&prefix)
            })
            .filter(|d| d.as_str() != dir_path)
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

    let inherited = InheritedPrefixes::new(inherited_prefixes);

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
        if !inherited.covers(&normalized) {
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
            let _ = writer.write_entry(&normalized, size, mtime, extra_hardlink);
        }

        // Update top-N + extension aggregates. Note: directory_totals +
        // bytes_seen were updated at inherit time in the walk using the
        // precomputed dir aggregates, so we skip those here to avoid
        // double-counting.
        let parent = Path::new(path_str)
            .parent()
            .map(normalize_path)
            .unwrap_or_default();
        if !extra_hardlink {
            if state.largest_files.would_keep(size, &normalized) {
                state.largest_files.offer(ScanFileRecord {
                    path: normalized,
                    name: name.clone(),
                    parent_path: parent.clone(),
                    extension: extension.clone(),
                    size,
                    modified_at: mtime,
                });
            }
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
                list.sort_by(folder_tree_file_order);
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

/// The folders `stream_inherited_files_into` copies from the baseline.
/// Kept sorted, each ending in a separator and none inside another, so a
/// path is under one of them exactly when it starts with the last prefix
/// that sorts at or before it: O(log folders) per baseline line instead
/// of a scan of every folder.
#[cfg_attr(not(windows), allow(dead_code))]
struct InheritedPrefixes(Vec<String>);

#[cfg_attr(not(windows), allow(dead_code))]
impl InheritedPrefixes {
    fn new(dirs: &[String]) -> Self {
        let mut sorted: Vec<String> = dirs
            .iter()
            .map(|dir| {
                if dir.ends_with(std::path::MAIN_SEPARATOR) {
                    dir.clone()
                } else {
                    format!("{dir}{}", std::path::MAIN_SEPARATOR)
                }
            })
            .collect();
        sorted.sort_unstable();
        // A folder inside another adds nothing, and leaving it in could
        // hide its parent from the lookup. Anything that sorts between a
        // prefix and a path under it is also under that prefix, so a
        // nested prefix always follows its kept parent.
        let mut prefixes: Vec<String> = Vec::with_capacity(sorted.len());
        for prefix in sorted {
            if prefixes.last().is_some_and(|kept| prefix.starts_with(kept.as_str())) {
                continue;
            }
            prefixes.push(prefix);
        }
        Self(prefixes)
    }

    fn covers(&self, path: &str) -> bool {
        let after = self.0.partition_point(|prefix| {
            work::step();
            prefix.as_str() <= path
        });
        after > 0 && path.starts_with(self.0[after - 1].as_str())
    }
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
        if let Err(err) = writer.finish() {
            eprintln!("[diskhound-native-scanner] index writer finish failed ({err})");
        }
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

#[cfg(not(windows))]
fn scan_generic(root_path: &Path, state: &mut ScanState) -> Result<(), String> {
    scan_generic_with_plan(root_path, state, walk_prune::plan_for(root_path))
}

#[cfg(not(windows))]
fn scan_generic_with_plan(
    root_path: &Path,
    state: &mut ScanState,
    plan: walk_prune::PrunePlan,
) -> Result<(), String> {
    state.scan_phase = ScanPhase::Indexing;
    state.expected_total_files = state.input.expected_total_files;

    // Parallelism: dua-core reads directories on a work-stealing pool.
    // Directory enumeration is embarrassingly parallel at the I/O layer,
    // since reads of separate directories hit different inode blocks.
    //
    // At most 8 threads, like the Windows walker. On an 18-core M5 Max a
    // full `/` scan (21.4M files) took 2m 51s at 16 threads and 3m 22s at
    // 8, but 16 used 31% more CPU time (995 s vs 759 s) and peaked near
    // 1,000% CPU instead of 650%. Past 8, extra threads mostly add kernel
    // time. DISKHOUND_PARALLEL_THREADS overrides it.
    let thread_override = std::env::var("DISKHOUND_PARALLEL_THREADS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| n >= 1);
    let thread_count = thread_override.unwrap_or_else(|| {
        let logical = num_cpus::get().max(1);
        if logical <= 2 {
            logical
        } else {
            logical.clamp(4, 8)
        }
    });

    // Pseudo filesystems, other disks mounted under the root, second
    // copies through a Linux bind mount, and on macOS the Data-volume twins
    // of firmlinked folders. See walk_prune.
    if !plan.other_mounts.is_empty()
        || !plan.duplicate_mounts.is_empty()
        || !plan.firmlink_twins.is_empty()
    {
        let sorted = |set: &HashSet<String>| {
            let mut paths: Vec<String> = set.iter().cloned().collect();
            paths.sort();
            paths
        };
        eprintln!(
            "[diskhound-native-scanner] prune: {} firmlink twins, other mounts {:?}, second copies through another mount {:?}",
            plan.firmlink_twins.len(),
            sorted(&plan.other_mounts),
            sorted(&plan.duplicate_mounts),
        );
    }
    let plan = Arc::new(plan);
    let plan_for_walk = Arc::clone(&plan);
    let pruned = Arc::new(walk_prune::PruneLog::default());
    let pruned_for_walk = Arc::clone(&pruned);
    let io_for_walk = Arc::clone(&state.io);

    // dua-core asks once about every directory it could read, the root
    // included, and reads exactly the ones it gets `true` for. Prune there,
    // BEFORE descending: /proc and /dev hold kernel-generated entries (a
    // scan of `/` used to hang on /proc/kcore), another disk has its own
    // drive pill, and a bind mount's source or a firmlink twin would count
    // the same files twice. The pruned directory itself is still yielded;
    // the loop below leaves it out.
    let mut walker = dua_core::walk(
        root_path,
        thread_count,
        dua_core::Order::Completion,
        dua_core::Options::default(),
        move |entry| {
            if entry.depth > 0 {
                let path = entry.path();
                let path = path.to_string_lossy();
                if let Some(reason) = plan_for_walk.skip_reason(&path, true) {
                    pruned_for_walk.note(reason, &path);
                    return false;
                }
            }
            io_for_walk.count_readdir();
            true
        },
    );

    eprintln!(
        "[diskhound-native-scanner] unix: walking with dua-core, {} threads",
        thread_count
    );
    let walk_started = Instant::now();
    let mut hardlinks = hardlinks::HardlinkTracker::default();

    while let Some(entry) = walker.next_cancellable(&CANCELLED) {
        let entry = match entry {
            Ok(entry) => entry,
            // A directory that could not be listed, or an entry in one
            // that could not be read.
            Err(_) => {
                state.skipped_entries += 1;
                maybe_emit_progress(state)?;
                continue;
            }
        };

        let is_dir = entry.file_type.is_dir();
        count_walker_stat(&state.io, &entry);
        if !is_dir && !entry.file_type.is_file() {
            maybe_emit_progress(state)?;
            continue;
        }
        let path = entry.path();
        // Only a folder, or a child of the root, can be pruned: anything
        // deeper sits in a folder the walk entered, so not a pruned one.
        let may_be_pruned = if is_dir { entry.depth > 0 } else { entry.depth == 1 };
        if may_be_pruned && plan.skip_reason(&path.to_string_lossy(), is_dir).is_some() {
            continue;
        }
        let metadata = entry.metadata.and_then(Result::ok);

        if is_dir {
            state.directories_visited += 1;
            // Emit dir mtime entry so this scan is a valid baseline for the
            // next one. The Phase-1 inherit optimization isn't wired into
            // the Unix walker — it always walks — but we at least keep the
            // output format consistent so the JS worker (which does
            // implement Phase 1) can read it back.
            if let (Some(writer), Some(Ok(modified))) = (
                state.index_writer.as_mut(),
                metadata.as_ref().map(|meta| meta.modified()),
            ) {
                let _ = writer.write_dir_entry(&normalize_path(&path), unix_timestamp_ms(modified));
            }
            maybe_emit_progress(state)?;
            continue;
        }

        let Some(metadata) = metadata else {
            state.skipped_entries += 1;
            maybe_emit_progress(state)?;
            continue;
        };

        let link = hardlinks::Link {
            path,
            size: allocated_size(&metadata),
            modified_at: metadata_modified_at_ms(&metadata),
        };
        if metadata.nlink() <= 1 {
            record_file_with_link_flag(state, unix_file_record(link), false)?;
            continue;
        }
        // Held until every name of the inode is in, so the owner is the
        // same name on every scan whatever order the reads finish in.
        let mut result = Ok(());
        hardlinks.add(metadata.dev(), metadata.ino(), metadata.nlink(), link, |link, extra| {
            record_released(state, &mut result, link, extra)
        });
        result?;
        // A folder of held names releases nothing until their twins turn up.
        maybe_emit_progress(state)?;
    }

    if is_cancelled() {
        finalize_hottest_directories(state);
        return Ok(());
    }

    let mut result = Ok(());
    hardlinks.finish(|link, extra| record_released(state, &mut result, link, extra));
    result?;

    state.skipped_mounts = pruned.other_mounts();
    eprintln!(
        "[diskhound-native-scanner] unix: walk done in {} ms (files={}, dirs={}, skipped={}, foreign_mounts_pruned={}, duplicate_mounts_pruned={}, firmlink_twins_pruned={}, readdir_calls={}, stat_calls={})",
        walk_started.elapsed().as_millis(),
        state.files_visited,
        state.directories_visited,
        state.skipped_entries,
        state.skipped_mounts.len(),
        pruned.duplicate_mounts(),
        pruned.firmlink_twins(),
        state.io.readdir_calls(),
        state.io.stat_calls(),
    );
    eprintln!(
        "[diskhound-native-scanner] hardlinks: {} extra links counted once ({} bytes), {} inodes with links outside the scan, at most {} names held",
        hardlinks.extra_links(),
        hardlinks.extra_link_bytes(),
        hardlinks.inodes_with_unseen_links(),
        hardlinks.peak_held(),
    );
    finalize_hottest_directories(state);
    Ok(())
}

/// A file record from the path and metadata the walker read. Held
/// hardlinks keep only these three, so a held name costs one path.
#[cfg(not(windows))]
fn unix_file_record(link: hardlinks::Link) -> ScanFileRecord {
    let name = link
        .path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let parent_path = link.path.parent().map(normalize_path).unwrap_or_default();
    ScanFileRecord {
        extension: file_extension(&name),
        name,
        parent_path,
        size: link.size,
        modified_at: link.modified_at,
        path: normalize_path(&link.path),
    }
}

/// Records a hardlink name the tracker released. After an error (stdout
/// closed), later names are dropped and the error is returned.
#[cfg(not(windows))]
fn record_released(
    state: &mut ScanState,
    result: &mut Result<(), String>,
    link: hardlinks::Link,
    extra: bool,
) {
    if result.is_ok() {
        *result = record_file_with_link_flag(state, unix_file_record(link), extra);
    }
}

/// Counts the metadata reads dua-core made for `entry` into `stat_calls`.
/// They happen inside the library, so this follows where it gets metadata:
/// on Linux an `fstatat` for every entry, and the root's `lstat`; on macOS
/// `getattrlistbulk` covers files and symlinks, and each directory (the
/// root too) takes an `lstat`, because the bulk attributes do not fill a
/// directory's `stat` fields. Not counted: when a folder's bulk
/// reads spend more time waiting than executing, dua-core lists it again
/// and stats each entry; that decision is made on timing.
#[cfg(not(windows))]
fn count_walker_stat(io: &IoStats, entry: &dua_core::Entry) {
    if entry.metadata.is_none() {
        return;
    }
    if cfg!(target_os = "macos") && !entry.file_type.is_dir() {
        return;
    }
    io.count_stat();
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
        state.expected_total_files = None;
    }

    // The walkers only tally folder sizes. Progress snapshots re-rank as
    // they go; this ranks the final list, cancelled or not.
    let result = walk_windows(root_path, state, std::env::var("DISKHOUND_NO_PARALLEL").is_err());
    finalize_hottest_directories(state);
    result
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
                state.largest_files.clear();
                for tile in tiles {
                    state.largest_files.offer(tile);
                }
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
        state.largest_files.absorb(local.largest_files);

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

    // Folder-tree file lists may have grown past the cap during merge
    // (two shards each capped at 200 = up to 1600 entries per parent
    // after 8-way merge). Sort+truncate each list once globally.
    if want_folder_tree {
        for list in state.folder_tree_files.values_mut() {
            if list.len() > FOLDER_TREE_FILES_PER_PARENT {
                list.sort_by(folder_tree_file_order);
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
    // Rank the folder tallies once, then turn lite snapshots off so the
    // Done snapshot the caller emits later carries the full top-N payload.
    let finalize_started = Instant::now();
    finalize_hottest_directories(state);
    eprintln!(
        "[diskhound-native-scanner] mft: finalize hottest_directories took {} ms ({} dirs in totals)",
        finalize_started.elapsed().as_millis(),
        state.directory_totals.len(),
    );
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
    largest_files: LargestFiles,
    folder_tree_files: HashMap<String, Vec<(String, u64, u64)>>,
    files: u64,
    dirs: u64,
    bytes: u64,
}

#[cfg(windows)]
impl EmitLocal {
    fn new(top_file_limit: usize) -> Self {
        Self {
            dir_totals: HashMap::new(),
            ext_totals: HashMap::new(),
            largest_files: LargestFiles::new(top_file_limit),
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

    let mut local = EmitLocal::new(top_file_limit);
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
                if local.largest_files.would_keep(rec.size, &path) {
                    local.largest_files.offer(ScanFileRecord {
                        path: path.clone(),
                        name: file_name.clone(),
                        parent_path: parent_path.clone(),
                        extension: extension.clone(),
                        size: rec.size,
                        modified_at: rec.mtime_ms,
                    });
                }
                rollup_directory_bytes(root_path, &parent_path, rec.size, 1, &mut local.dir_totals);
                rollup_extension(&mut local.ext_totals, &extension, rec.size);
            }

            if want_folder_tree {
                let list = local
                    .folder_tree_files
                    .entry(parent_path)
                    .or_insert_with(Vec::new);
                list.push((file_name, rec.size, rec.mtime_ms));
                if list.len() > FOLDER_TREE_FILES_PER_PARENT * 2 {
                    list.sort_by(folder_tree_file_order);
                    list.truncate(FOLDER_TREE_FILES_PER_PARENT);
                }
            }

            if let Some(tx) = &writer_tx {
                let _ = tx.send(IndexWriteMsg::File {
                    path,
                    size: rec.size,
                    mtime: rec.mtime_ms,
                    extra_hardlink: rec.extra_hardlink,
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
                let snap = local.largest_files.largest(TILE_PUBLISH_CAP);
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
        let snap = local.largest_files.largest(TILE_PUBLISH_CAP);
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
    // Rank the finished tallies now. The inherited stream below doesn't
    // change them, and snapshots during it would otherwise show the
    // last in-walk ranking.
    finalize_hottest_directories(state);
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
    // As in the sequential tail: rank before the stream, which doesn't
    // change the tallies.
    finalize_hottest_directories(state);
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

/// Add `bytes` and `file_count` to a directory and each of its ancestors
/// up to the root. Walkers call this once per file; the Phase-1 inherit
/// path calls it once per inherited subtree with the subtree's sums.
///
/// Tallies only. `hottest_directories` is ranked from these totals when a
/// snapshot needs it (`refresh_hottest_directories`) and at the end of the
/// scan (`finalize_hottest_directories`). Re-sorting the 10k ranking at
/// every ancestor of every file cost O(files × depth × limit).
fn rollup_directory_bytes(
    root_path: &str,
    directory_path: &str,
    bytes: u64,
    file_count: u64,
    directory_totals: &mut HashMap<String, DirectoryHotspot>,
) {
    let mut current_path = directory_path.to_string();
    loop {
        work::step();
        // get_mut first: almost every folder already has a row, and this
        // skips cloning the key for it.
        if let Some(entry) = directory_totals.get_mut(&current_path) {
            entry.size += bytes;
            entry.file_count += file_count;
        } else {
            let depth = directory_depth(root_path, &current_path);
            directory_totals.insert(
                current_path.clone(),
                DirectoryHotspot {
                    path: current_path.clone(),
                    size: bytes,
                    file_count,
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
#[cfg(windows)]
fn record_file(state: &mut ScanState, file_record: ScanFileRecord) -> Result<(), String> {
    let extra_hardlink = state
        .baseline
        .as_ref()
        .is_some_and(|baseline| baseline.extra_hardlink_paths.contains(&file_record.path));
    record_file_with_link_flag(state, file_record, extra_hardlink)
}

/// An extra hardlink still counts as a file in its folder and keeps its
/// size in the index and folder-tree rows, but adds 0 bytes and stays off
/// the largest-files and extension lists.
fn record_file_with_link_flag(
    state: &mut ScanState,
    file_record: ScanFileRecord,
    extra_hardlink: bool,
) -> Result<(), String> {
    let occupancy = if extra_hardlink { 0 } else { file_record.size };
    state.files_visited += 1;
    state.bytes_seen += occupancy;
    if !extra_hardlink && state.largest_files.would_keep(file_record.size, &file_record.path) {
        state.largest_files.offer(file_record.clone());
    }
    rollup_directory_bytes(
        &state.root_path_string,
        &file_record.parent_path,
        occupancy,
        1,
        &mut state.directory_totals,
    );
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
            list.sort_by(folder_tree_file_order);
            list.truncate(FOLDER_TREE_FILES_PER_PARENT);
        }
    }

    // Best-effort index write. If it fails partway through the scan
    // (e.g. disk full), drop the writer so we stop trying but let the
    // snapshot protocol keep working.
    if let Some(writer) = state.index_writer.as_mut() {
        if writer
            .write_entry(&file_record.path, file_record.size, file_record.modified_at, extra_hardlink)
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
            self.largest_files.largest(RUNNING_LARGEST_FILES_CAP)
        } else {
            self.largest_files.to_vec()
        };
        let hottest_directories = if lite {
            // hottest_directories: still gated by lite mode. Lite
            // snapshots emit [] and skip the re-rank; folder-level stats
            // show up once the Done snapshot lands.
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
            skipped_mounts: self.skipped_mounts.clone(),
        }
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
        skipped_mounts: Vec::new(),
    }
}

fn maybe_emit_progress(state: &mut ScanState) -> Result<(), String> {
    let elapsed_ms = state.started_at_instant.elapsed().as_millis();
    if elapsed_ms.saturating_sub(state.last_emit_elapsed_ms) < SNAPSHOT_INTERVAL_MS {
        return Ok(());
    }

    state.last_emit_elapsed_ms = elapsed_ms;
    refresh_hottest_directories(state);
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

/// `st_blocks` × 512. On macOS dua-core reads it from the bulk attributes,
/// rounded to 512-byte blocks as `stat` rounds it.
#[cfg(not(windows))]
fn allocated_size(metadata: &dua_core::Metadata) -> u64 {
    metadata.blocks().saturating_mul(512)
}

#[cfg(not(windows))]
fn metadata_modified_at_ms(metadata: &dua_core::Metadata) -> u64 {
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

/// The `limit` largest files seen so far, ties broken by path so the list
/// is the same whatever order a walk finds files in. A min-heap: the
/// smallest kept file is on top, so a file that doesn't make the list
/// costs one compare and one that does costs O(log limit). Every scan path
/// offers each path once, so there's no duplicate check.
struct LargestFiles {
    limit: usize,
    heap: BinaryHeap<Reverse<BySize>>,
}

/// Orders files by size; of two the same size, the smaller path ranks
/// higher.
struct BySize(ScanFileRecord);

impl Ord for BySize {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        work::step();
        self.0
            .size
            .cmp(&other.0.size)
            .then_with(|| other.0.path.cmp(&self.0.path))
    }
}

impl PartialOrd for BySize {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for BySize {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other).is_eq()
    }
}

impl Eq for BySize {}

impl LargestFiles {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            heap: BinaryHeap::with_capacity(limit),
        }
    }

    /// Whether this file would make the list, so callers can skip building
    /// a record for one that won't.
    fn would_keep(&self, size: u64, path: &str) -> bool {
        if self.heap.len() < self.limit {
            return true;
        }
        work::step();
        self.heap.peek().is_some_and(|smallest| {
            let smallest = &smallest.0.0;
            size > smallest.size || (size == smallest.size && path < smallest.path.as_str())
        })
    }

    fn offer(&mut self, record: ScanFileRecord) {
        if !self.would_keep(record.size, &record.path) {
            return;
        }
        if self.heap.len() < self.limit {
            self.heap.push(Reverse(BySize(record)));
        } else if let Some(mut smallest) = self.heap.peek_mut() {
            // Dropping the PeekMut sifts the new entry down.
            *smallest = Reverse(BySize(record));
        }
    }

    /// Keep whatever another list kept that also makes this one: merges
    /// the MFT emit shards.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn absorb(&mut self, other: LargestFiles) {
        for Reverse(BySize(record)) in other.heap.into_vec() {
            self.offer(record);
        }
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    fn len(&self) -> usize {
        self.heap.len()
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    fn clear(&mut self) {
        self.heap.clear();
    }

    /// The `count` largest files, biggest first. O(len) to select plus
    /// O(count log count) to order.
    fn largest(&self, count: usize) -> Vec<ScanFileRecord> {
        if count == 0 {
            return Vec::new();
        }
        let biggest_first = |a: &&BySize, b: &&BySize| b.cmp(a);
        let mut ranked: Vec<&BySize> = self.heap.iter().map(|entry| &entry.0).collect();
        if ranked.len() > count {
            ranked.select_nth_unstable_by(count - 1, biggest_first);
            ranked.truncate(count);
        }
        ranked.sort_unstable_by(biggest_first);
        ranked.into_iter().map(|entry| entry.0.clone()).collect()
    }

    fn to_vec(&self) -> Vec<ScanFileRecord> {
        self.largest(self.heap.len())
    }
}

/// The `limit` biggest folders in `totals`, biggest first, ties by path.
/// O(folders) to select plus O(limit log limit) to order.
fn top_directories(
    totals: &HashMap<String, DirectoryHotspot>,
    limit: usize,
) -> Vec<DirectoryHotspot> {
    if limit == 0 {
        return Vec::new();
    }
    let biggest_first = |a: &&DirectoryHotspot, b: &&DirectoryHotspot| {
        work::step();
        b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path))
    };
    let mut ranked: Vec<&DirectoryHotspot> = totals.values().inspect(|_| work::step()).collect();
    if ranked.len() > limit {
        ranked.select_nth_unstable_by(limit - 1, biggest_first);
        ranked.truncate(limit);
    }
    ranked.sort_unstable_by(biggest_first);
    ranked.into_iter().cloned().collect()
}

/// Rank `state.hottest_directories` from the folder tallies. Every scan
/// path calls this once when its walk or emit ends.
fn finalize_hottest_directories(state: &mut ScanState) {
    state.hottest_directories =
        top_directories(&state.directory_totals, state.input.top_directory_limit);
    state.hottest_directories_due_at =
        state.files_visited + state.directory_totals.len() as u64;
}

/// Re-rank the hottest folders for a progress snapshot. A ranking costs
/// O(folders), so it waits until as many files as there are folders have
/// been recorded since the last one: the total stays linear in files
/// however often snapshots fire. Lite snapshots carry no folders.
fn refresh_hottest_directories(state: &mut ScanState) {
    if !state.emit_lite_snapshots && state.files_visited >= state.hottest_directories_due_at {
        finalize_hottest_directories(state);
    }
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

/// Gives `dest` the bytes of `source` without writing them again: a
/// hard link, or a copy on a volume without hard links (FAT32, exFAT).
fn link_or_copy(source: &Path, dest: &Path) -> io::Result<&'static str> {
    match std::fs::hard_link(source, dest) {
        Ok(()) => Ok("linked"),
        Err(_) => std::fs::copy(source, dest).map(|_| "copied"),
    }
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
    // Instead: if we have a baseline index (rescan), give the new
    // scan's sidecar path the baseline sidecar's bytes. The tree
    // contents are still accurate since nothing changed. This
    // preserves the Folders-tab fast path across rescans without
    // needing to rebuild from scratch. A hard link, so the ~50 MB a
    // 7M-file drive's sidecar holds are not written again; Node
    // replaces sidecars by rename, which leaves the other name alone.
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
                match link_or_copy(&baseline_sidecar, &output_path) {
                    Ok(how) => {
                        eprintln!(
                            "[diskhound-native-scanner] folder-tree sidecar: reused baseline sidecar ({:?}) — {} bytes {how} to {:?} in {} ms (no tree work done on inheritance-only scan)",
                            baseline_sidecar,
                            baseline_size,
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
            list.sort_by(folder_tree_file_order);
            list.truncate(FOLDER_TREE_FILES_PER_PARENT);
        } else {
            list.sort_by(folder_tree_file_order);
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

/// Scaling tests: they count `work::step()`s (comparisons and entries
/// examined), not time, at N and 8N. Where a cost also grows with a list
/// limit L or a folder count K, that grows 8× too: with it fixed, an
/// O(N·L) loop looks linear from N to 8N.
#[cfg(test)]
mod scaling_tests {
    use super::*;
    use std::path::MAIN_SEPARATOR as SEP;

    /// From N to 8N (and L or K to 8L or 8K), linear work grows 8×. Allow
    /// 2× that for the log factors; the quadratic loops these replace grew
    /// 60-64×.
    const MAX_GROWTH: f64 = 16.0;

    fn root() -> String {
        format!("{SEP}scan")
    }

    /// Ten files per leaf folder, ten leaves per group: root/gG/dD/fI.bin.
    fn leaf(d: usize) -> String {
        format!("{}{SEP}g{}{SEP}d{d}", root(), d / 10)
    }

    fn group(g: usize) -> String {
        format!("{}{SEP}g{g}", root())
    }

    /// Sizes ascend, so every file makes the top-N list: the worst case
    /// for ranking.
    fn file(i: usize) -> ScanFileRecord {
        let parent = leaf(i / 10);
        ScanFileRecord {
            path: format!("{parent}{SEP}f{i}.bin"),
            name: format!("f{i}.bin"),
            parent_path: parent,
            extension: ".bin".into(),
            size: i as u64 + 1,
            modified_at: 0,
        }
    }

    fn state(limit: usize) -> ScanState {
        let root = root();
        let input = ScanInput {
            root_path: PathBuf::from(&root),
            top_file_limit: limit,
            top_directory_limit: limit,
            index_output: None,
            baseline_index: None,
            folder_tree_output: None,
            dev_artifacts_output: None,
            expected_total_files: None,
        };
        let mut state = ScanState::new(input, root, None, None, Arc::new(IoStats::default()));
        // Never emit: tests call refresh_hottest_directories directly.
        state.last_emit_elapsed_ms = u128::MAX;
        state.scan_phase = ScanPhase::Indexing;
        state
    }

    fn assert_scales(label: &str, small: u64, large: u64, cap: u64) {
        let growth = large as f64 / small as f64;
        eprintln!("{label}: {small} -> {large} steps ({growth:.1}x), cap {cap}");
        assert!(growth <= MAX_GROWTH, "{label} grew {growth:.1}x from N to 8N");
        assert!(large <= cap, "{label} took {large} steps at 8N, over {cap}");
    }

    /// The per-file path every walker shares (FindFirstFile, dua-core,
    /// inherited streams), with a progress snapshot after every file.
    fn walk(files: usize, limit: usize) -> (u64, ScanState) {
        let mut state = state(limit);
        work::take();
        for i in 0..files {
            record_file_with_link_flag(&mut state, file(i), false).unwrap();
            refresh_hottest_directories(&mut state);
        }
        finalize_hottest_directories(&mut state);
        (work::take(), state)
    }

    #[test]
    fn walker_ranking_is_n_log_l() {
        // Before: 324,747 steps -> 20,015,138 (61.6x). Every ancestor of
        // every file searched and re-sorted the folder ranking, and every
        // file searched the file ranking for its own path.
        let (small, _) = walk(1_000, 50);
        let (large, state) = walk(8_000, 400);
        // Per file: 3 ancestors, a heap sift, and its share of re-ranks.
        assert_scales("walker ranking", small, large, 8_000 * 40);

        let sizes: Vec<u64> = state.largest_files.to_vec().iter().map(|f| f.size).collect();
        assert_eq!(sizes, (7_601..=8_000).rev().collect::<Vec<u64>>());
        let mut every_folder: Vec<DirectoryHotspot> =
            state.directory_totals.values().cloned().collect();
        every_folder.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));
        every_folder.truncate(400);
        let paths = |dirs: &[DirectoryHotspot]| dirs.iter().map(|d| d.path.clone()).collect::<Vec<_>>();
        assert_eq!(paths(&state.hottest_directories), paths(&every_folder));
        assert_eq!(state.hottest_directories[0].path, root());
        assert_eq!(state.hottest_directories[0].file_count, 8_000);
    }

    #[test]
    fn progress_snapshots_rank_folders_during_the_walk() {
        let mut state = state(10);
        record_file_with_link_flag(&mut state, file(0), false).unwrap();
        refresh_hottest_directories(&mut state);
        let first: Vec<String> = state.hottest_directories.iter().map(|d| d.path.clone()).collect();
        assert_eq!(first, vec![root(), group(0), leaf(0)]);

        // Not due again until 3 more files (one per folder ranked) are in.
        for i in [10, 20] {
            record_file_with_link_flag(&mut state, file(i), false).unwrap();
            refresh_hottest_directories(&mut state);
            assert_eq!(state.hottest_directories.len(), 3);
        }
        record_file_with_link_flag(&mut state, file(30), false).unwrap();
        refresh_hottest_directories(&mut state);
        assert_eq!(state.hottest_directories.len(), 6);

        // Lite snapshots carry no folders, so they don't re-rank.
        state.emit_lite_snapshots = true;
        for i in 4..20 {
            record_file_with_link_flag(&mut state, file(10 * i), false).unwrap();
        }
        refresh_hottest_directories(&mut state);
        assert_eq!(state.hottest_directories.len(), 6);
        state.emit_lite_snapshots = false;
        refresh_hottest_directories(&mut state);
        assert_eq!(state.hottest_directories.len(), 10);
    }

    fn offer_all(order: &[usize], limit: usize) -> (u64, LargestFiles) {
        let mut list = LargestFiles::new(limit);
        work::take();
        for &i in order {
            list.offer(file(i));
        }
        (work::take(), list)
    }

    #[test]
    fn largest_files_cost_is_n_log_l_in_any_order() {
        // Before, ascending: 146,156 steps -> 9,359,381 (64.0x).
        for (label, reverse) in [("ascending", false), ("descending (MFT)", true)] {
            let order = |n: usize| -> Vec<usize> {
                let mut order: Vec<usize> = (0..n).collect();
                if reverse {
                    order.reverse();
                }
                order
            };
            let (small, _) = offer_all(&order(1_000), 50);
            let (large, list) = offer_all(&order(8_000), 400);
            assert_scales(label, small, large, 8_000 * 20);
            let sizes: Vec<u64> = list.to_vec().iter().map(|f| f.size).collect();
            assert_eq!(sizes, (7_601..=8_000).rev().collect::<Vec<u64>>());
        }
    }

    #[test]
    fn largest_files_breaks_size_ties_by_path_in_any_order_and_merges_shards() {
        let sized = |name: &str, size: u64| ScanFileRecord {
            path: format!("{SEP}{name}"),
            name: name.into(),
            parent_path: SEP.to_string(),
            extension: "(no ext)".into(),
            size,
            modified_at: 0,
        };
        let names = |list: &LargestFiles| list.to_vec().into_iter().map(|f| f.name).collect::<Vec<_>>();
        let mut list = LargestFiles::new(2);
        for order in [["c", "b", "a"], ["a", "b", "c"], ["b", "c", "a"]] {
            list.clear();
            for name in order {
                list.offer(sized(name, 5));
            }
            assert_eq!(names(&list), vec!["a", "b"], "offered {order:?}");
        }
        assert!(!list.would_keep(5, &format!("{SEP}c")));
        assert!(list.would_keep(5, &format!("{SEP}0")));
        assert!(list.would_keep(6, &format!("{SEP}z")));

        let mut other = LargestFiles::new(2);
        other.offer(sized("d", 9));
        other.offer(sized("e", 1));
        list.absorb(other);
        assert_eq!(names(&list), vec!["d", "a"]);
        assert_eq!(list.largest(1).len(), 1);
        assert!(LargestFiles::new(0).to_vec().is_empty());
    }

    fn baseline_with_groups(groups: usize) -> Baseline {
        let mut dirs = vec![root()];
        for g in 0..groups {
            dirs.push(group(g));
            dirs.extend((g * 10..g * 10 + 10).map(leaf));
        }
        dirs.sort();
        Baseline {
            baseline_path: PathBuf::new(),
            dir_mtimes: HashMap::new(),
            dir_file_counts: HashMap::new(),
            dir_total_sizes: HashMap::new(),
            dirs,
            #[cfg(windows)]
            extra_hardlink_paths: HashSet::new(),
        }
    }

    fn subtrees(groups: usize) -> u64 {
        let baseline = baseline_with_groups(groups);
        work::take();
        for g in 0..groups {
            assert_eq!(baseline.subtree_dirs(&group(g)).len(), 10);
        }
        work::take()
    }

    #[test]
    fn subtree_dirs_is_log_d_plus_subtree_per_folder() {
        // Before: 110,100 steps -> 7,040,800 (63.9x): every inherited
        // folder scanned every baseline folder.
        let small = subtrees(100);
        let large = subtrees(800);
        assert_scales("subtree_dirs", small, large, 800 * 40);
    }

    #[test]
    fn subtree_dirs_matches_whole_names_only() {
        let mut baseline = baseline_with_groups(0);
        let a = format!("{}{SEP}a", root());
        baseline.dirs = vec![
            root(),
            a.clone(),
            format!("{a}{SEP}x"),
            format!("{a}{SEP}x{SEP}y"),
            format!("{a} b"),
            format!("{a}-b{SEP}z"),
            format!("{a}b"),
        ];
        baseline.dirs.sort();
        assert_eq!(baseline.subtree_dirs(&a), vec![format!("{a}{SEP}x"), format!("{a}{SEP}x{SEP}y")]);
        assert_eq!(baseline.subtree_dirs(&root()).len(), 6);
        assert_eq!(baseline.subtree_dirs(&format!("{a}{SEP}x{SEP}y")), Vec::<String>::new());
    }

    /// Baseline of `files` files with half the leaf folders inherited:
    /// K = files / 20 prefixes.
    fn stream(files: usize) -> u64 {
        let dir = std::env::temp_dir().join(format!(
            "diskhound-scaling-{}-{files}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("baseline.ndjson.gz");
        let mut gz = GzEncoder::new(File::create(&path).unwrap(), Compression::fast());
        for i in 0..files {
            let f = file(i);
            writeln!(gz, "{{\"p\":{},\"s\":{},\"m\":0}}", serde_json::to_string(&f.path).unwrap(), f.size)
                .unwrap();
        }
        gz.finish().unwrap();
        let prefixes: Vec<String> = (0..files / 10).filter(|d| d % 2 == 0).map(leaf).collect();
        let mut state = state(files / 20);
        work::take();
        stream_inherited_files_into(&path, &prefixes, &mut state).unwrap();
        let steps = work::take();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(state.largest_files.len(), files / 20);
        assert_eq!(state.extension_totals[".bin"].count as usize, files / 2);
        steps
    }

    #[test]
    fn inherited_stream_is_n_log_k() {
        // Before: 108,906 steps -> 6,961,381 (63.9x): every baseline line
        // was checked against every inherited folder.
        let small = stream(1_000);
        let large = stream(8_000);
        assert_scales("inherited stream", small, large, 8_000 * 30);
    }

    #[cfg(not(windows))]
    fn held(path: String) -> hardlinks::Link {
        hardlinks::Link { path: path.into(), size: 4096, modified_at: 0 }
    }

    /// `inodes` files with two names each, in two folders the walk reads
    /// in parallel (cargo's target/debug/deps and incremental): every name
    /// is held until its twin arrives. Then one inode with `names` names,
    /// most of them outside the scan, released at the end.
    #[cfg(not(windows))]
    fn hold_links(inodes: usize, names: usize) -> u64 {
        let mut tracker = hardlinks::HardlinkTracker::default();
        let mut owners = 0;
        let mut extras = 0;
        let mut count = |extra: bool| if extra { extras += 1 } else { owners += 1 };
        work::take();
        for folder in ["deps", "incremental"] {
            for i in 0..inodes {
                let path = format!("{}{SEP}{folder}{SEP}f{i}", root());
                tracker.add(1, i as u64, 2, held(path), |_, extra| count(extra));
            }
        }
        for i in 0..names {
            let path = format!("{}{SEP}shared{SEP}n{}", root(), names - i);
            tracker.add(2, 0, names as u64 * 4, held(path), |_, extra| count(extra));
        }
        tracker.finish(|_, extra| count(extra));
        let steps = work::take();
        assert_eq!((owners, extras), (inodes + 1, inodes + names - 1));
        steps
    }

    #[test]
    #[cfg(not(windows))]
    fn held_hardlinks_are_released_in_n_log_links() {
        let small = hold_links(1_000, 1_000);
        let large = hold_links(8_000, 8_000);
        // Per two-name inode: one comparison and two releases. The big
        // inode sorts its names once.
        assert_scales("held hardlinks", small, large, 8_000 * 30);
    }

    /// `lines` index lines written scrambled (7919 is prime, so `i * 7919`
    /// visits every index once) through one sorted run.
    #[cfg(not(windows))]
    fn sorted_run(lines: usize) -> u64 {
        let mut run = SortedRun::new(SORTED_RUN_BYTES);
        let mut out = Vec::new();
        work::take();
        for i in (0..lines).map(|i| i * 7919 % lines) {
            run.write(&mut out, format!("{{\"p\":\"{}{SEP}f{i:06}\"}}\n", root()).as_bytes())
                .unwrap();
        }
        run.flush(&mut out).unwrap();
        let steps = work::take();
        let written: Vec<&[u8]> = out.split_inclusive(|&b| b == b'\n').collect();
        assert_eq!(written.len(), lines);
        assert!(written.is_sorted(), "a run goes out sorted");
        steps
    }

    #[test]
    #[cfg(not(windows))]
    fn index_runs_sort_in_n_log_n() {
        let small = sorted_run(1_000);
        let large = sorted_run(8_000);
        assert_scales("sorted index run", small, large, 8_000 * 20);
    }

    #[test]
    fn a_full_run_goes_out_sorted_and_the_next_starts_empty() {
        let mut run = SortedRun::new(8);
        let mut out = Vec::new();
        for line in ["c\n", "a\n", "d\n", "b\n", "f\n", "e\n"] {
            run.write(&mut out, line.as_bytes()).unwrap();
        }
        assert_eq!(out, b"a\nb\nc\nd\n", "the run filled at 8 bytes");
        run.flush(&mut out).unwrap();
        assert_eq!(out, b"a\nb\nc\nd\ne\nf\n");
        let mut through = Vec::new();
        SortedRun::new(0).write(&mut through, b"z\n").unwrap();
        assert_eq!(through, b"z\n", "cap 0 writes through");
    }

    #[test]
    fn inherited_prefixes_match_whole_folder_names() {
        let a = format!("{}{SEP}a", root());
        let inherited = InheritedPrefixes::new(&[
            a.clone(),
            format!("{a}{SEP}nested"),
            format!("{a} b"),
            format!("{}{SEP}c", root()),
        ]);
        assert_eq!(inherited.0.len(), 3, "the nested prefix is dropped");
        assert!(inherited.covers(&format!("{a}{SEP}f.txt")));
        assert!(inherited.covers(&format!("{a}{SEP}nested{SEP}f.txt")));
        assert!(inherited.covers(&format!("{a} b{SEP}f.txt")));
        assert!(!inherited.covers(&format!("{a}bc{SEP}f.txt")));
        assert!(!inherited.covers(&format!("{}{SEP}b{SEP}f.txt", root())));
        assert!(!inherited.covers(&format!("{}{SEP}f.txt", root())));

        let everything = InheritedPrefixes::new(&[SEP.to_string()]);
        assert!(everything.covers(&format!("{a}{SEP}f.txt")));
        assert!(!InheritedPrefixes::new(&[]).covers(&a));
    }
}

#[cfg(test)]
mod folder_tree_sidecar_reuse_tests {
    use super::*;
    use crate::test_support::{test_state, TempTree};
    use std::fs;

    /// A rescan that inherited every folder has no tree of its own and
    /// reuses the baseline's sidecar, without writing its bytes again.
    #[test]
    fn inheritance_only_scan_links_the_baseline_sidecar() {
        let tree = TempTree::new("sidecar-reuse");
        tree.write("root/a.txt", 1);
        let baseline_index = tree.write("scan-indexes/base.ndjson.gz", 64);
        let baseline_sidecar = tree.write("scan-indexes/base.folder-tree.ndjson.gz", 4096);
        let output = tree.path("scan-indexes/pending.folder-tree.ndjson.gz");
        let mut state = test_state(&tree.path("root"), &tree.path("scan-indexes/pending.ndjson.gz"));
        state.input.baseline_index = Some(baseline_index);
        state.input.folder_tree_output = Some(output.clone());

        write_folder_tree_sidecar(&mut state).unwrap();

        assert_eq!(fs::read(&output).unwrap(), fs::read(&baseline_sidecar).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(fs::metadata(&output).unwrap().nlink(), 2, "the sidecar was copied, not linked");
        }
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
        state.index_writer.take().unwrap().finish().unwrap();

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

        let largest_files = state.largest_files.to_vec();
        let largest: Vec<&str> = largest_files.iter().map(|f| f.path.as_str()).collect();
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
    const SYMLINKS: u64 = 2;

    /// dua-core's metadata reads (see `count_walker_stat`): on macOS an
    /// lstat per directory, because getattrlistbulk covers files and
    /// symlinks; on Linux an fstatat per entry, symlinks included.
    const STATS: u64 = if cfg!(target_os = "macos") { DIRS } else { DIRS + FILES + SYMLINKS };

    /// The walker's stat counts differ by OS, so each has its own budgets.
    const OS: &str = if cfg!(target_os = "macos") { "native-macos" } else { "native-linux" };

    /// Directories root, b, b/d and g (empty). Files a.txt, b/c.txt,
    /// b/d/e.txt, and b/d/f.txt, a second link to a.txt. Two symlinks the
    /// walker must not follow.
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
        assert_eq!(state.io.stat_calls(), STATS);
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
        let note = if cfg!(target_os = "macos") {
            "4 dirs, 4 files (one a second hardlink), 2 symlinks: 1 listing per dir, 1 lstat \
             per dir (its index mtime); getattrlistbulk gives files and symlinks theirs. \
             jwalk took 8 stats: it also lstat'ed every file"
        } else {
            "4 dirs, 4 files (one a second hardlink), 2 symlinks: 1 listing per dir, 1 fstatat \
             per entry, symlinks included (jwalk took 8: no stat for symlinks)"
        };
        expect_io_budget(&format!("{OS}/walk"), measured(note, &state.io, None));
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
            &format!("{OS}/rescan-with-baseline"),
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

#[cfg(all(test, unix))]
mod unix_prune_scan_tests {
    use super::*;
    use crate::test_support::*;
    use crate::walk_prune::PrunePlan;
    use std::os::unix::fs::MetadataExt;

    fn occupancy(path: &Path) -> u64 {
        std::fs::metadata(path).unwrap().blocks() * 512
    }

    /// A small `/` on macOS. `Users` is the firmlinked name and `Data/Users`
    /// its twin; a hardlink stands in for the firmlink, which a test can't
    /// create. `Data/.Spotlight-V100` exists only on the Data volume, and
    /// `Volumes/USB` is another disk.
    #[test]
    fn scan_skips_twins_and_other_disks_and_walks_data_only_folders_once() {
        let tree = TempTree::new("prune-scan");
        let home_file = tree.write("root/Users/me/a.bin", 8 * 1024);
        tree.link(&home_file, "root/Data/Users/me/a.bin");
        let data_only = tree.write("root/Data/.Spotlight-V100/store.db", 4 * 1024);
        tree.write("root/Volumes/USB/photo.jpg", 16 * 1024);
        let root = tree.path("root");
        let root_s = normalize_path(&root);
        let plan = PrunePlan {
            other_mounts: [format!("{root_s}/Volumes/USB")].into(),
            firmlink_twins: [format!("{root_s}/Data/Users")].into(),
            ..PrunePlan::default()
        };
        let index_path = tree.path("index.ndjson.gz");

        let mut state = test_state(&root, &index_path);
        scan_generic_with_plan(&root, &mut state, plan).unwrap();
        let snapshot = serde_json::to_value(state.snapshot(ScanStatus::Done, None)).unwrap();
        let index = finish_index(&mut state, &index_path);

        let (dirs, files) = assert_listed_once(&index);
        assert_each_inode_owned_once(&index);
        assert_eq!(
            files,
            [normalize_path(&home_file), normalize_path(&data_only)].into(),
        );
        assert!(index.iter().all(|rec| !rec.extra_hardlink), "the twin is never reached");
        assert!(dirs.contains(&format!("{root_s}/Data/.Spotlight-V100")));
        assert!(!dirs.iter().any(|d| d.starts_with(&format!("{root_s}/Data/Users"))));
        assert!(!dirs.iter().any(|d| d.starts_with(&format!("{root_s}/Volumes/USB"))));
        assert_eq!(state.bytes_seen, occupancy(&home_file) + occupancy(&data_only));
        assert_eq!(state.io.readdir_calls(), dirs.len() as u64, "pruned folders are never listed");

        assert_eq!(state.skipped_mounts, vec![format!("{root_s}/Volumes/USB")]);
        assert_eq!(snapshot["skippedMounts"], serde_json::json!([format!("{root_s}/Volumes/USB")]));
    }

    #[test]
    fn snapshot_omits_skipped_mounts_when_there_are_none() {
        let tree = TempTree::new("prune-none");
        tree.write("root/a.txt", 10);
        let root = tree.path("root");
        let index_path = tree.path("index.ndjson.gz");
        let mut state = test_state(&root, &index_path);
        scan_generic_with_plan(&root, &mut state, PrunePlan::default()).unwrap();
        let snapshot = serde_json::to_value(state.snapshot(ScanStatus::Done, None)).unwrap();
        assert!(snapshot.get("skippedMounts").is_none());
    }
}
