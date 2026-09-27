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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalEntry {
    pub file_ref: u64,
    pub parent_ref: u64,
    pub name: String,
    pub usn: i64,
    /// Every reason bit the file's records carried, OR-ed together.
    pub reason: u32,
    /// Unix ms of the latest record.
    pub timestamp: u64,
    pub attributes: u32,
}

pub const FILE_DELETE: u32 = 0x0000_0200;
pub const RENAME_OLD_NAME: u32 = 0x0000_1000;

/// Latest state plus every distinct name removed during this interval.
/// Folding by file ID alone loses the old name and parent after a rename.
#[derive(Debug)]
pub struct JournalFile {
    pub latest: JournalEntry,
    pub removed_names: HashMap<(u64, String), JournalEntry>,
}

impl JournalFile {
    fn remember_removed_name(&mut self, record: &JournalEntry) {
        crate::work::step();
        if record.reason & (FILE_DELETE | RENAME_OLD_NAME) != 0 {
            self.removed_names.insert((record.parent_ref, record.name.clone()), record.clone());
        }
    }
}

/// Journal records folded by file reference, in first-seen order.
#[derive(Default)]
pub struct JournalAggregate {
    order: Vec<u64>,
    by_ref: HashMap<u64, JournalFile>,
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
                let file = seen.get_mut();
                file.remember_removed_name(&record);
                let entry = &mut file.latest;
                entry.reason |= record.reason;
                entry.usn = record.usn;
                entry.timestamp = record.timestamp;
                entry.parent_ref = record.parent_ref;
                entry.name = record.name;
                entry.attributes = record.attributes;
            }
            Entry::Vacant(slot) => {
                self.order.push(record.file_ref);
                let mut file = JournalFile { latest: record.clone(), removed_names: HashMap::new() };
                file.remember_removed_name(&record);
                slot.insert(file);
            }
        }
    }

    /// Journal records added so far.
    pub fn records(&self) -> u64 {
        self.records
    }

    /// One entry per file, in the order each first appeared.
    pub fn into_files(mut self) -> impl Iterator<Item = JournalFile> {
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
            name: format!("file-{file_ref}"),
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
        let files: Vec<_> = journal.into_files().map(|file| file.latest).collect();
        assert_eq!(
            files,
            vec![
                JournalEntry { reason: FILE_CREATE | DATA_EXTEND | CLOSE, ..record(7, 4, 0) },
                JournalEntry { reason: DATA_EXTEND | FILE_DELETE, ..record(9, 5, 0) },
            ]
        );
    }

    #[test]
    fn keeps_old_names_and_parents_through_multiple_renames_and_delete() {
        let mut journal = JournalAggregate::default();
        for (usn, parent_ref, name, reason) in [
            (1, 5, "old", RENAME_OLD_NAME),
            (2, 6, "middle", 0x2000),
            (3, 6, "middle", RENAME_OLD_NAME),
            (4, 7, "last", 0x2000),
            (5, 7, "last", FILE_DELETE),
            (6, 7, "last", FILE_DELETE | CLOSE),
        ] {
            journal.add(JournalEntry { parent_ref, name: name.into(), ..record(7, usn, reason) });
        }
        let file = journal.into_files().next().unwrap();
        assert_eq!(file.latest.name, "last");
        assert_eq!(file.removed_names.len(), 3, "delete/close is folded by name");
        assert_eq!(file.removed_names[&(5, "old".into())].usn, 1);
        assert_eq!(file.removed_names[&(6, "middle".into())].usn, 3);
        assert_eq!(file.removed_names[&(7, "last".into())].usn, 6);
    }

    #[test]
    fn removed_names_scale_linearly_with_files_and_renames() {
        fn run(files: u64, renames: u64) -> u64 {
            work::take();
            let mut journal = JournalAggregate::default();
            for file_ref in 0..files {
                for rename in 0..renames {
                    journal.add(JournalEntry {
                        name: format!("name-{rename}"),
                        parent_ref: file_ref % (files / 100).max(1),
                        ..record(file_ref, rename as i64, RENAME_OLD_NAME)
                    });
                }
            }
            for file in journal.into_files() {
                assert_eq!(file.removed_names.len(), renames as usize);
            }
            work::take()
        }
        // Grow files and the parent directory count by 8x.
        let small = run(2_000, 4);
        let large = run(16_000, 4);
        assert!(large <= small * 16);
        assert!(large <= 3 * 16_000 * 4);
        // Also grow the number of names held for a single busy file.
        let small = run(1, 2_000);
        let large = run(1, 16_000);
        assert!(large <= small * 16);
        assert!(large <= 3 * 16_000);
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
        // Two steps per record and one per file.
        assert!(large_steps <= 2 * (16_000 * 4 + 16_000), "folding took {large_steps} steps");
    }
}
