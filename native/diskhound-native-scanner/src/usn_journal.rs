//! NTFS USN Journal reader (Windows only).
//!
//! The USN Journal is an append-only log of every filesystem change on an
//! NTFS volume. By remembering a cursor (the last USN we processed), we can
//! reread just what's new since the last check — typical cost is a few
//! milliseconds for thousands of changes, vs. walking the whole drive.
//!
//! This module provides:
//! 1. `open_volume()` — opens a raw volume handle (requires read access)
//! 2. `query_journal()` — reads journal metadata (id, first/next USN)
//! 3. `read_journal()` — streams USN records starting at a cursor
//! 4. `resolve_file()` — turns a FileReferenceNumber into a full path via
//!    OpenFileById + GetFinalPathNameByHandleW
//! 5. `run_journal_mode()` — CLI entry point that folds the records per
//!    file (`usn_aggregate`), resolves each file once, emits one NDJSON
//!    line per current file and deleted name, plus a final cursor line
//!    for the caller to persist.
//!
//! Output format (one JSON object per line):
//!   {"type":"journal-record","op":"create"|"modify"|"delete"|"rename",
//!    "path":"...","size":N,"mtime":ms,"usn":N,"parentRef":N}
//!   {"type":"journal-cursor","cursor":N,"journalId":N,
//!    "recordsEmitted":N,"recordsDropped":N,"journalRecords":N}
//!
//! Unresolved current files and removed names with unresolved parents are
//! counted in recordsDropped; a failed lookup alone never proves deletion.

#![cfg(windows)]

use std::collections::HashMap;
use std::ffi::c_void;
use std::io::{self, Write};
use std::os::windows::ffi::OsStrExt;

use serde::Serialize;

use crate::usn_aggregate::{JournalAggregate, JournalEntry, RENAME_OLD_NAME};

use windows_sys::Win32::Foundation::{
    CloseHandle, GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FileBasicInfo, FileStandardInfo, GetFileInformationByHandleEx,
    GetFinalPathNameByHandleW, OpenFileById, FILE_ATTRIBUTE_DIRECTORY, FILE_BASIC_INFO,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_ID_DESCRIPTOR, FILE_ID_DESCRIPTOR_0, FILE_ID_TYPE,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_STANDARD_INFO, OPEN_EXISTING,
};
use windows_sys::Win32::System::Ioctl::{
    FSCTL_QUERY_USN_JOURNAL, FSCTL_READ_USN_JOURNAL, USN_JOURNAL_DATA_V0,
    USN_RECORD_V2,
};
use windows_sys::Win32::System::IO::DeviceIoControl;

// ── USN reason flag bits (subset we care about). See winioctl.h ────────────
const USN_REASON_DATA_OVERWRITE: u32 = 0x0000_0001;
const USN_REASON_DATA_EXTEND: u32 = 0x0000_0002;
const USN_REASON_DATA_TRUNCATION: u32 = 0x0000_0004;
const USN_REASON_FILE_CREATE: u32 = 0x0000_0100;
const USN_REASON_FILE_DELETE: u32 = 0x0000_0200;
const USN_REASON_RENAME_NEW_NAME: u32 = 0x0000_2000;
const USN_REASON_CLOSE: u32 = 0x8000_0000;

/// The reasons that change what the index holds for a file: its bytes,
/// its existence or its path. Node acts on create, modify, delete and
/// rename, and drops every other record, so the journal is asked for
/// only these. A record carries every reason since its file was opened,
/// so `DATA_EXTEND | CLOSE` still matches, while a close after a
/// security or timestamp change no longer counts as a change.
const RELEVANT_REASONS: u32 = USN_REASON_DATA_OVERWRITE
    | USN_REASON_DATA_EXTEND
    | USN_REASON_DATA_TRUNCATION
    | USN_REASON_FILE_CREATE
    | USN_REASON_FILE_DELETE
    | USN_REASON_RENAME_NEW_NAME
    | RENAME_OLD_NAME;

/// UTF-16 units for the longest path GetFinalPathNameByHandleW returns.
const MAX_PATH_UNITS: usize = 32_768;

const WINDOWS_TO_UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;

// ── IDs for the FILE_ID_DESCRIPTOR type discriminator ──────────────────────
// Rust bindgen names this FILE_ID_TYPE with variants FileIdType (0), etc.
const FILE_ID_TYPE_FILE_ID: FILE_ID_TYPE = 0;

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub struct JournalInfo {
    pub journal_id: u64,
    pub first_usn: i64,
    pub next_usn: i64,
    pub lowest_valid_usn: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
pub enum JournalOp {
    Create,
    Modify,
    Delete,
    Rename,
    Close,
    Other,
}

impl JournalOp {
    fn from_reason(reason: u32) -> Self {
        if reason & USN_REASON_FILE_DELETE != 0 {
            return JournalOp::Delete;
        }
        if reason & (USN_REASON_RENAME_NEW_NAME | RENAME_OLD_NAME) != 0 {
            return JournalOp::Rename;
        }
        if reason & USN_REASON_FILE_CREATE != 0 {
            return JournalOp::Create;
        }
        if reason
            & (USN_REASON_DATA_OVERWRITE | USN_REASON_DATA_EXTEND | USN_REASON_DATA_TRUNCATION)
            != 0
        {
            return JournalOp::Modify;
        }
        if reason & USN_REASON_CLOSE != 0 {
            return JournalOp::Close;
        }
        JournalOp::Other
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum OutputLine {
    JournalRecord {
        op: JournalOp,
        path: String,
        #[serde(rename = "fileRef")]
        file_ref: u64,
        #[serde(rename = "parentRef")]
        parent_ref: u64,
        usn: i64,
        #[serde(rename = "reasonMask")]
        reason_mask: u32,
        timestamp: u64,
        /// Allocated size when FileStandardInfo succeeded. Omitted so the
        /// Node side can stat instead of recording a false 0-byte file.
        #[serde(skip_serializing_if = "Option::is_none")]
        size: Option<u64>,
        mtime: u64,
        #[serde(rename = "isDirectory")]
        is_directory: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[serde(rename = "linkCount")]
        link_count: Option<u32>,
    },
    JournalCursor {
        cursor: i64,
        #[serde(rename = "journalId")]
        journal_id: u64,
        /// Operations printed, including deletes for old names.
        #[serde(rename = "recordsEmitted")]
        records_emitted: u64,
        /// Operations whose required current-file or removed-name path did not resolve.
        #[serde(rename = "recordsDropped")]
        records_dropped: u64,
        /// Journal records read, before folding them per file.
        #[serde(rename = "journalRecords")]
        journal_records: u64,
    },
    JournalError {
        message: String,
    },
    CursorQuery {
        #[serde(rename = "journalId")]
        journal_id: u64,
        #[serde(rename = "nextUsn")]
        next_usn: i64,
        #[serde(rename = "firstUsn")]
        first_usn: i64,
        volume: String,
    },
}

/// Open a raw volume handle like `\\.\C:` with read access. Requires the
/// process token to have the `SeManageVolumePrivilege` is NOT strictly
/// required for read-only access — GENERIC_READ is sufficient for USN
/// journal queries on most volumes, though some operations may require
/// Administrator depending on the journal's ACL.
fn open_volume(drive_letter: char) -> io::Result<HANDLE> {
    let path = format!(r"\\.\{}:", drive_letter);
    let wide: Vec<u16> = std::ffi::OsStr::new(&path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(handle)
}

fn query_journal(volume: HANDLE) -> io::Result<JournalInfo> {
    let mut data: USN_JOURNAL_DATA_V0 = unsafe { std::mem::zeroed() };
    let mut bytes_returned: u32 = 0;

    let ok = unsafe {
        DeviceIoControl(
            volume,
            FSCTL_QUERY_USN_JOURNAL,
            std::ptr::null(),
            0,
            &mut data as *mut _ as *mut c_void,
            std::mem::size_of::<USN_JOURNAL_DATA_V0>() as u32,
            &mut bytes_returned,
            std::ptr::null_mut(),
        )
    };

    if ok == 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(JournalInfo {
        journal_id: data.UsnJournalID,
        first_usn: data.FirstUsn,
        next_usn: data.NextUsn,
        lowest_valid_usn: data.LowestValidUsn,
    })
}

/// Read USN records with a `RELEVANT_REASONS` bit from `start_usn` up to
/// `end_usn` (the journal's NextUsn when the read began, so a busy volume
/// cannot keep it going), calling `handle_record` for each. Returns the
/// cursor to resume from: the `NextUsn` of the last batch.
fn read_journal<F>(
    volume: HANDLE,
    journal_id: u64,
    start_usn: i64,
    end_usn: i64,
    mut handle_record: F,
) -> io::Result<i64>
where
    F: FnMut(&USN_RECORD_V2, String),
{
    #[repr(C)]
    struct ReadUsnJournalDataV0 {
        start_usn: i64,
        reason_mask: u32,
        return_only_on_close: u32,
        timeout: u64,
        bytes_to_wait_for: u64,
        usn_journal_id: u64,
    }

    let mut request = ReadUsnJournalDataV0 {
        start_usn,
        reason_mask: RELEVANT_REASONS,
        return_only_on_close: 0,
        timeout: 0,
        bytes_to_wait_for: 0,
        usn_journal_id: journal_id,
    };

    let mut buffer = vec![0u8; 64 * 1024]; // 64KB buffer per read
    let mut last_cursor: i64 = start_usn;

    loop {
        let mut bytes_returned: u32 = 0;
        let ok = unsafe {
            DeviceIoControl(
                volume,
                FSCTL_READ_USN_JOURNAL,
                &request as *const _ as *const c_void,
                std::mem::size_of::<ReadUsnJournalDataV0>() as u32,
                buffer.as_mut_ptr() as *mut c_void,
                buffer.len() as u32,
                &mut bytes_returned,
                std::ptr::null_mut(),
            )
        };

        if ok == 0 {
            return Err(io::Error::last_os_error());
        }

        // First 8 bytes of the returned buffer is the next USN to resume from.
        if (bytes_returned as usize) < 8 {
            break;
        }
        let next_usn = i64::from_ne_bytes(buffer[0..8].try_into().unwrap());

        let mut offset = 8;
        while offset + std::mem::size_of::<USN_RECORD_V2>() <= bytes_returned as usize {
            let record_ptr = unsafe { buffer.as_ptr().add(offset) as *const USN_RECORD_V2 };
            let record = unsafe { &*record_ptr };
            let record_length = record.RecordLength as usize;
            if record_length == 0 || offset + record_length > bytes_returned as usize {
                break;
            }

            // Only process V2 records for now. V3/V4 have 128-bit file IDs
            // and require a different parse; on NTFS V2 covers everything.
            if record.MajorVersion == 2 {
                let name_start = record.FileNameOffset as usize;
                let name_len = record.FileNameLength as usize;
                if name_start < 60 || name_len % 2 != 0 || name_start + name_len > record_length {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid USN filename"));
                }
                let units: Vec<u16> = buffer[offset + name_start..offset + name_start + name_len]
                    .chunks_exact(2)
                    .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                    .collect();
                handle_record(record, String::from_utf16_lossy(&units));
            }

            offset += record_length;
        }

        // Follow NextUsn, not the record count: with a reason mask a
        // batch can skip a stretch of records and return none of them.
        // Stop when it stops moving (the tail) or passes where the
        // journal ended when this read began.
        if next_usn <= last_cursor {
            break;
        }
        last_cursor = next_usn;
        if next_usn >= end_usn {
            break;
        }
        request.start_usn = next_usn;
    }

    Ok(last_cursor)
}

struct ResolvedFile {
    path: String,
    allocated_size: Option<u64>,
    mtime_ms: u64,
    is_directory: Option<bool>,
    number_of_links: Option<u32>,
}

fn file_standard_info(handle: HANDLE) -> Option<FILE_STANDARD_INFO> {
    let mut info = unsafe { std::mem::zeroed::<FILE_STANDARD_INFO>() };
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileStandardInfo,
            &mut info as *mut _ as *mut c_void,
            std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
        )
    };
    if ok == 0 {
        None
    } else {
        Some(info)
    }
}

fn file_basic_info(handle: HANDLE) -> Option<FILE_BASIC_INFO> {
    let mut info = unsafe { std::mem::zeroed::<FILE_BASIC_INFO>() };
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileBasicInfo,
            &mut info as *mut _ as *mut c_void,
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        )
    };
    if ok == 0 {
        None
    } else {
        Some(info)
    }
}

/// Best-effort path + occupancy via OpenFileById.
/// Returns None for files that can't be opened (deleted, insufficient
/// permissions, race conditions). Callers should expect a meaningful
/// fraction to fail on system volumes.
fn resolve_file(volume: HANDLE, file_ref: u64, path_buffer: &mut [u16]) -> Option<ResolvedFile> {
    let descriptor = FILE_ID_DESCRIPTOR {
        dwSize: std::mem::size_of::<FILE_ID_DESCRIPTOR>() as u32,
        Type: FILE_ID_TYPE_FILE_ID,
        Anonymous: FILE_ID_DESCRIPTOR_0 {
            FileId: file_ref as i64,
        },
    };

    let handle = unsafe {
        OpenFileById(
            volume,
            &descriptor,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            FILE_FLAG_BACKUP_SEMANTICS,
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        return None;
    }

    let standard = file_standard_info(handle);
    let basic = file_basic_info(handle);
    let allocated_size = standard
        .as_ref()
        .map(|info| info.AllocationSize.max(0) as u64);
    let is_directory = standard.as_ref().map(|info| info.Directory != 0);
    let number_of_links = standard.as_ref().map(|info| info.NumberOfLinks);
    let mtime_ms = basic
        .map(|info| windows_filetime_to_unix_ms(info.LastWriteTime))
        .unwrap_or(0);

    let chars_written = unsafe {
        GetFinalPathNameByHandleW(handle, path_buffer.as_mut_ptr(), path_buffer.len() as u32, 0)
    };

    unsafe { CloseHandle(handle) };

    if chars_written == 0 || chars_written as usize >= path_buffer.len() {
        return None;
    }

    let path = String::from_utf16_lossy(&path_buffer[..chars_written as usize]);
    // Strip the `\\?\` extended-length prefix for consistency with the scanner.
    Some(ResolvedFile {
        path: path
            .strip_prefix(r"\\?\")
            .map(str::to_string)
            .unwrap_or(path),
        allocated_size,
        mtime_ms,
        is_directory,
        number_of_links,
    })
}

fn windows_filetime_to_unix_ms(ticks: i64) -> u64 {
    let unsigned = ticks.max(0) as u64;
    unsigned
        .saturating_sub(WINDOWS_TO_UNIX_EPOCH_TICKS)
        .saturating_div(10_000)
}

fn emit(line: &OutputLine) -> io::Result<()> {
    let stdout = io::stdout();
    let mut writer = stdout.lock();
    serde_json::to_writer(&mut writer, line)?;
    writer.write_all(b"\n")
}

/// CLI entry point for `--mode journal`. Opens the volume, streams new
/// records since `start_cursor`, emits one NDJSON line per resolvable
/// record, then a final cursor line.
///
/// Arguments:
/// - `drive_letter`: e.g. 'C' for `C:`
/// - `start_cursor`: None for "from the beginning of the journal";
///    otherwise a USN from a previous run.
pub fn run_journal_mode(drive_letter: char, start_cursor: Option<i64>) -> Result<(), String> {
    let volume = open_volume(drive_letter)
        .map_err(|e| format!("Failed to open volume {drive_letter}: {e}"))?;

    let info = query_journal(volume)
        .map_err(|e| format!("Failed to query USN journal on {drive_letter}: {e}"))?;

    // If the caller's cursor is older than `first_usn`, the journal has
    // wrapped and older records are gone. Caller must fall back to a full
    // scan. We emit an error line and exit cleanly.
    let effective_start = start_cursor.unwrap_or(info.next_usn);
    if effective_start < info.first_usn {
        let _ = emit(&OutputLine::JournalError {
            message: format!(
                "Cursor {} predates journal start {}; full rescan required",
                effective_start, info.first_usn
            ),
        });
        unsafe { CloseHandle(volume) };
        return Ok(());
    }

    let lines = collect_changes(volume, info.journal_id, effective_start, info.next_usn);
    unsafe { CloseHandle(volume) };
    for line in lines.map_err(|e| format!("Failed to read USN journal on {drive_letter}: {e}"))? {
        let _ = emit(&line);
    }
    Ok(())
}

/// Reads the journal from `start` to `end` and folds the records per
/// file first, so each file is opened and resolved once however many
/// records it left. Keeps deleted/old names as separate delete operations,
/// then emits the current state and the `JournalCursor` line.
fn collect_changes(volume: HANDLE, journal_id: u64, start: i64, end: i64) -> io::Result<Vec<OutputLine>> {
    let mut journal = JournalAggregate::default();
    let final_cursor = read_journal(volume, journal_id, start, end, |record, name| {
        journal.add(JournalEntry {
            file_ref: record.FileReferenceNumber,
            parent_ref: record.ParentFileReferenceNumber,
            name,
            usn: record.Usn,
            reason: record.Reason,
            timestamp: windows_filetime_to_unix_ms(record.TimeStamp),
            attributes: record.FileAttributes,
        });
    })?;

    let journal_records = journal.records();
    let mut path_buffer = vec![0u16; MAX_PATH_UNITS];
    let (mut lines, dropped) = resolve_changes(journal, |file_ref| {
        resolve_file(volume, file_ref, &mut path_buffer)
    });
    let records_emitted = lines.len() as u64;
    lines.push(OutputLine::JournalCursor {
        cursor: final_cursor,
        journal_id,
        records_emitted,
        records_dropped: dropped,
        journal_records,
    });
    Ok(lines)
}

/// Cache successes and failures, including parent directories shared by
/// many deleted files. A reference used as both a file and a parent still
/// incurs only one OpenFileById during this read.
fn resolve_changes(
    journal: JournalAggregate,
    mut resolve: impl FnMut(u64) -> Option<ResolvedFile>,
) -> (Vec<OutputLine>, u64) {
    let mut cache: HashMap<u64, Option<ResolvedFile>> = HashMap::new();
    let mut lines = Vec::new();
    let mut dropped = 0;
    for file in journal.into_files() {
        for removed in file.removed_names.values() {
            crate::work::step();
            emit_removed(removed, &mut cache, &mut resolve, &mut lines, &mut dropped);
        }
        let entry = file.latest;
        // The deleted name has already been emitted. Resolving its ID
        // can fail, or return a surviving hard link at a different path.
        if entry.reason & USN_REASON_FILE_DELETE != 0 {
            continue;
        }
        let resolved = cache.entry(entry.file_ref).or_insert_with(|| resolve(entry.file_ref));
        if let Some(resolved) = resolved {
            lines.push(record_line(&entry, JournalOp::from_reason(entry.reason), resolved));
        } else if !file.removed_names.contains_key(&(entry.parent_ref, entry.name.clone())) {
            // A lookup can fail for a live file (access denied, sharing
            // restrictions, or a path-query error). Only FILE_DELETE and
            // RENAME_OLD_NAME justify removing a name from the index.
            dropped += 1;
        }
    }
    (lines, dropped)
}

fn emit_removed(
    entry: &JournalEntry,
    cache: &mut HashMap<u64, Option<ResolvedFile>>,
    resolve: &mut impl FnMut(u64) -> Option<ResolvedFile>,
    lines: &mut Vec<OutputLine>,
    dropped: &mut u64,
) {
    let parent = cache.entry(entry.parent_ref).or_insert_with(|| resolve(entry.parent_ref));
    if let Some(parent) = parent.as_ref().filter(|_| !entry.name.is_empty()) {
        let removed = ResolvedFile {
            path: format!("{}\\{}", parent.path.trim_end_matches('\\'), entry.name),
            allocated_size: None,
            mtime_ms: 0,
            is_directory: None,
            number_of_links: None,
        };
        lines.push(record_line(entry, JournalOp::Delete, &removed));
    } else {
        *dropped += 1;
    }
}

fn record_line(entry: &JournalEntry, op: JournalOp, resolved: &ResolvedFile) -> OutputLine {
    OutputLine::JournalRecord {
        op,
        path: resolved.path.clone(),
        file_ref: entry.file_ref,
        parent_ref: entry.parent_ref,
        usn: entry.usn,
        reason_mask: entry.reason,
        timestamp: entry.timestamp,
        size: resolved.allocated_size,
        mtime: resolved.mtime_ms,
        is_directory: resolved.is_directory.unwrap_or(
            (entry.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0,
        ),
        link_count: resolved.number_of_links,
    }
}

/// Cheap query of the current journal state. Used right after a full scan
/// completes so we can anchor the next incremental read to a cursor that
/// represents "everything up to now." Emits a single JSON line and exits.
pub fn query_cursor(drive_letter: char) -> Result<(), String> {
    let volume = open_volume(drive_letter)
        .map_err(|e| format!("Failed to open volume {drive_letter}: {e}"))?;

    let info = query_journal(volume)
        .map_err(|e| format!("Failed to query USN journal on {drive_letter}: {e}"))?;

    let _ = emit(&OutputLine::CursorQuery {
        journal_id: info.journal_id,
        next_usn: info.next_usn,
        first_usn: info.first_usn,
        volume: format!("{drive_letter}:"),
    });

    unsafe { CloseHandle(volume) };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(size: Option<u64>) -> OutputLine {
        OutputLine::JournalRecord {
            op: JournalOp::Modify,
            path: r"C:\tmp\file.bin".into(),
            file_ref: 1,
            parent_ref: 2,
            usn: 3,
            reason_mask: 0,
            timestamp: 0,
            size,
            mtime: 0,
            is_directory: false,
            link_count: None,
        }
    }

    #[test]
    fn journal_record_omits_size_when_standard_info_failed() {
        let json = serde_json::to_string(&record(None)).unwrap();
        assert!(!json.contains("\"size\""), "unexpected size in {json}");
    }

    #[test]
    fn journal_record_keeps_zero_allocated_size() {
        let json = serde_json::to_string(&record(Some(0))).unwrap();
        assert!(json.contains("\"size\":0"), "missing zero size in {json}");
    }

    /// Reads the real journal of the temp dir's volume. Needs the rights
    /// to open the volume (an elevated process, as on CI runners) and an
    /// active journal, and skips without them.
    #[test]
    fn a_file_written_in_several_sessions_comes_back_as_one_line() {
        use std::io::Write;

        let dir = std::env::temp_dir().join(format!("diskhound-usn-fold-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let name = format!("fold-{}.bin", std::process::id());
        let file = dir.join(&name);
        let dir_text = dir.to_string_lossy().to_string();
        let drive = dir_text.split(':').next().and_then(|head| head.chars().last()).unwrap();

        let volume = match open_volume(drive) {
            Ok(volume) => volume,
            Err(err) => {
                eprintln!("skipped: cannot open volume {drive}: ({err})");
                return;
            }
        };
        let before = match query_journal(volume) {
            Ok(info) => info,
            Err(err) => {
                eprintln!("skipped: no USN journal on {drive}: ({err})");
                unsafe { CloseHandle(volume) };
                return;
            }
        };
        // Five write sessions: create, then an extend and a close each.
        for session in 0..5u8 {
            let mut out = std::fs::OpenOptions::new().create(true).append(true).open(&file).unwrap();
            out.write_all(&[session; 8192]).unwrap();
        }
        let after = query_journal(volume).unwrap();
        let lines = collect_changes(volume, before.journal_id, before.next_usn, after.next_usn).unwrap();
        unsafe { CloseHandle(volume) };
        let _ = std::fs::remove_dir_all(&dir);

        let mine: Vec<&OutputLine> = lines
            .iter()
            .filter(|line| matches!(line, OutputLine::JournalRecord { path, .. } if path.ends_with(&name)))
            .collect();
        assert_eq!(mine.len(), 1, "one line for the file, not one per record: {mine:?}");
        let OutputLine::JournalRecord { op, reason_mask, size, .. } = mine[0] else { unreachable!() };
        assert!(matches!(op, JournalOp::Create), "{op:?}");
        assert_ne!(reason_mask & USN_REASON_FILE_CREATE, 0);
        assert_ne!(reason_mask & USN_REASON_DATA_EXTEND, 0);
        assert!(size.unwrap_or(0) >= 5 * 8192, "allocated size {size:?}");

        let Some(OutputLine::JournalCursor { cursor, records_emitted, journal_records, .. }) = lines.last() else {
            panic!("no cursor line");
        };
        assert!(journal_records > records_emitted, "{journal_records} records, {records_emitted} lines");
        assert!(*cursor >= after.next_usn);
    }

    #[test]
    fn deleted_and_renamed_files_keep_their_recorded_paths() {
        let dir = std::env::temp_dir().join(format!("diskhound-usn-remove-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Windows runners can supply an 8.3 TEMP path (RUNNER~1), while
        // OpenFileById resolves long names. Normalize the existing parent
        // before any files disappear, using the reader's prefix convention.
        let canonical_dir = std::fs::canonicalize(&dir).unwrap();
        let canonical_text = canonical_dir.to_str().unwrap();
        let dir = std::path::PathBuf::from(
            canonical_text.strip_prefix(r"\\?\").unwrap_or(canonical_text),
        );
        let dest = dir.join("destination");
        std::fs::create_dir_all(&dest).unwrap();
        let deleted = dir.join("deleted.bin");
        let old = dir.join("old-名前.bin");
        let middle = dest.join("middle.bin");
        let new = dest.join("new-名前.bin");
        std::fs::write(&deleted, [1; 8192]).unwrap();
        std::fs::write(&old, [2; 8192]).unwrap();
        let drive = dir.to_string_lossy().split(':').next().unwrap().chars().last().unwrap();
        let volume = match open_volume(drive) {
            Ok(volume) => volume,
            Err(err) => {
                eprintln!("skipped: cannot open volume {drive}: ({err})");
                let _ = std::fs::remove_dir_all(&dir);
                return;
            }
        };
        let before = match query_journal(volume) {
            Ok(info) => info,
            Err(err) => {
                eprintln!("skipped: no USN journal on {drive}: ({err})");
                unsafe { CloseHandle(volume) };
                let _ = std::fs::remove_dir_all(&dir);
                return;
            }
        };
        std::fs::remove_file(&deleted).unwrap();
        std::fs::rename(&old, &middle).unwrap();
        std::fs::rename(&middle, &new).unwrap();
        let created = dir.join("created.bin");
        std::fs::write(&created, [3; 8192]).unwrap();
        let after = query_journal(volume).unwrap();
        let lines = collect_changes(volume, before.journal_id, before.next_usn, after.next_usn).unwrap();
        unsafe { CloseHandle(volume) };
        let _ = std::fs::remove_dir_all(&dir);

        for (path, expected) in [
            (&deleted, "delete"), (&old, "delete"), (&middle, "delete"),
            (&new, "rename"), (&created, "create"),
        ] {
            let path_text = path.to_string_lossy();
            let mine: Vec<_> = lines.iter().filter(|line| matches!(line,
                OutputLine::JournalRecord { path, .. } if path.eq_ignore_ascii_case(&path_text)
            )).collect();
            assert_eq!(mine.len(), 1, "expected one {expected} at {path_text}: {mine:?}");
            let json = serde_json::to_value(mine[0]).unwrap();
            assert_eq!(json["op"], expected, "{path_text}: {json}");
        }
    }

    #[test]
    fn failed_current_file_lookup_does_not_infer_deletion() {
        for reason in [USN_REASON_FILE_CREATE, USN_REASON_DATA_EXTEND, USN_REASON_RENAME_NEW_NAME] {
            let mut journal = JournalAggregate::default();
            journal.add(JournalEntry {
                file_ref: 7,
                parent_ref: 5,
                name: "still-present.bin".into(),
                usn: 1,
                reason,
                timestamp: 0,
                attributes: 0,
            });
            let (lines, dropped) = resolve_changes(journal, |id| {
                // Model an inaccessible live file whose parent is accessible.
                // OpenFileById and path-query failures share the same None.
                if id == 7 { return None; }
                assert_eq!(id, 5);
                Some(ResolvedFile {
                    path: r"C:\accessible-parent".into(),
                    allocated_size: None,
                    mtime_ms: 0,
                    is_directory: Some(true),
                    number_of_links: None,
                })
            });
            assert!(lines.is_empty(), "lookup failure emitted an operation: {lines:?}");
            assert_eq!(dropped, 1, "uncertainty must remain visible to the caller");
        }
    }

    #[test]
    fn removed_names_and_parent_cache_scale_with_files_and_parents() {
        fn run(files: u64, parents: u64) -> u64 {
            let mut journal = JournalAggregate::default();
            for id in 0..files {
                journal.add(JournalEntry {
                    file_ref: id + parents,
                    parent_ref: id % parents,
                    name: format!("old-{id}"),
                    usn: 1,
                    reason: RENAME_OLD_NAME,
                    timestamp: 0,
                    attributes: 0,
                });
                journal.add(JournalEntry {
                    file_ref: id + parents,
                    parent_ref: id % parents,
                    name: format!("new-{id}"),
                    usn: 2,
                    reason: USN_REASON_RENAME_NEW_NAME,
                    timestamp: 0,
                    attributes: 0,
                });
            }
            let mut calls = HashMap::<u64, u64>::new();
            crate::work::take();
            let (lines, dropped) = resolve_changes(journal, |id| {
                *calls.entry(id).or_default() += 1;
                // Missing parent paths are cached too. Unresolved current
                // file IDs remain dropped, even when their parent resolves.
                if id >= parents || id == 0 { return None; }
                Some(ResolvedFile {
                    path: format!(r"C:\parent-{id}"),
                    allocated_size: None,
                    mtime_ms: 0,
                    is_directory: Some(true),
                    number_of_links: None,
                })
            });
            assert!(calls.values().all(|count| *count == 1));
            assert_eq!(calls.len() as u64, files + parents);
            assert_eq!(dropped, files + files / parents);
            assert_eq!(lines.len() as u64 + dropped, 2 * files);
            assert!(lines.iter().all(|line| matches!(line,
                OutputLine::JournalRecord { op: JournalOp::Delete, .. }
            )));
            crate::work::take() + calls.values().sum::<u64>()
        }
        let small = run(2_000, 20);
        let large = run(16_000, 160);
        assert!(large <= small * 16);
        assert!(large <= 5 * 16_000);
    }

    #[test]
    fn journal_record_omits_link_count_when_unknown() {
        let json = serde_json::to_string(&record(Some(1))).unwrap();
        assert!(!json.contains("linkCount"), "unexpected linkCount in {json}");
    }
}
