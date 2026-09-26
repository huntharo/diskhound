//! Folds USN journal records into one entry per file.
//!
//! One file change leaves several records: a write session logs
//! `DATA_EXTEND`, then `DATA_EXTEND | CLOSE`, and a busy file logs a
//! pair per session. The journal reader resolves each file with
//! `OpenFileById`, two `GetFileInformationByHandleEx` calls and
//! `GetFinalPathNameByHandleW`, so resolving per record did that work
//! several times per file and printed a line each time, only for the
//! Node side to keep the last. Records are folded here first, and each
//! file is resolved once.
//!
//! Platform-neutral so the folding and its scaling test run everywhere;
//! the Windows reader in `usn_journal.rs` feeds it.

#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::HashMap;
use std::collections::hash_map::Entry;

/// One journal record's fields the reader needs after folding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JournalEntry {
    pub file_ref: u64,
    pub parent_ref: u64,
    pub usn: i64,
    /// Every reason bit the file's records carried, OR-ed together.
    pub reason: u32,
    /// Unix ms of the latest record.
    pub timestamp: u64,
    pub attributes: u32,
}

/// Journal records folded by file reference, in first-seen order.
#[derive(Default)]
pub struct JournalAggregate {
    order: Vec<u64>,
    by_ref: HashMap<u64, JournalEntry>,
    records: u64,
}

impl JournalAggregate {
    /// Adds a record. A file seen before keeps its place, gains the
    /// record's reasons and takes its latest USN, time and parent.
    pub fn add(&mut self, record: JournalEntry) {
        crate::work::step();
        self.records += 1;
        match self.by_ref.entry(record.file_ref) {
            Entry::Occupied(mut seen) => {
                let entry = seen.get_mut();
                entry.reason |= record.reason;
                entry.usn = record.usn;
                entry.timestamp = record.timestamp;
                entry.parent_ref = record.parent_ref;
                entry.attributes = record.attributes;
            }
            Entry::Vacant(slot) => {
                self.order.push(record.file_ref);
                slot.insert(record);
            }
        }
    }

    /// Journal records added so far.
    pub fn records(&self) -> u64 {
        self.records
    }

    /// One entry per file, in the order each first appeared.
    pub fn into_files(mut self) -> impl Iterator<Item = JournalEntry> {
        self.order.into_iter().map(move |file_ref| {
            crate::work::step();
            self.by_ref.remove(&file_ref).expect("every ordered ref has an entry")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::work;

    const DATA_EXTEND: u32 = 0x0000_0002;
    const FILE_CREATE: u32 = 0x0000_0100;
    const FILE_DELETE: u32 = 0x0000_0200;
    const CLOSE: u32 = 0x8000_0000;

    fn record(file_ref: u64, usn: i64, reason: u32) -> JournalEntry {
        JournalEntry {
            file_ref,
            parent_ref: 5,
            usn,
            reason,
            timestamp: usn as u64 * 10,
            attributes: 0x20,
        }
    }

    #[test]
    fn folds_a_files_records_into_one_entry() {
        let mut journal = JournalAggregate::default();
        journal.add(record(7, 1, FILE_CREATE));
        journal.add(record(9, 2, DATA_EXTEND));
        journal.add(record(7, 3, DATA_EXTEND));
        journal.add(record(7, 4, DATA_EXTEND | CLOSE));
        journal.add(record(9, 5, FILE_DELETE));

        assert_eq!(journal.records(), 5);
        let files: Vec<_> = journal.into_files().collect();
        assert_eq!(
            files,
            vec![
                JournalEntry { reason: FILE_CREATE | DATA_EXTEND | CLOSE, ..record(7, 4, 0) },
                JournalEntry { reason: DATA_EXTEND | FILE_DELETE, ..record(9, 5, 0) },
            ]
        );
    }

    /// The reader resolves each entry `into_files` yields, so the number
    /// of resolves is the number of files, not of records.
    fn fold(files: u64, records_per_file: u64) -> (u64, u64) {
        work::take();
        let mut journal = JournalAggregate::default();
        let mut usn = 0;
        for round in 0..records_per_file {
            for file_ref in 0..files {
                usn += 1;
                let reason = if round + 1 == records_per_file { DATA_EXTEND | CLOSE } else { DATA_EXTEND };
                journal.add(record(file_ref, usn, reason));
            }
        }
        let resolves = journal.into_files().count() as u64;
        (work::take(), resolves)
    }

    #[test]
    fn resolves_each_file_once_and_scales_linearly() {
        let (small_steps, small_resolves) = fold(2_000, 4);
        let (large_steps, large_resolves) = fold(16_000, 4);
        assert_eq!(small_resolves, 2_000, "one resolve per file, not per record");
        assert_eq!(large_resolves, 16_000, "one resolve per file, not per record");
        let growth = large_steps as f64 / small_steps as f64;
        eprintln!("usn fold: {small_steps} -> {large_steps} steps ({growth:.1}x)");
        assert!(growth <= 16.0, "folding grew {growth:.1}x from N to 8N records");
        // One step per record and one per file.
        assert!(large_steps <= 2 * (16_000 * 4 + 16_000), "folding took {large_steps} steps");
    }
}
