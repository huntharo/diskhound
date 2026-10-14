//! Where the bytes of `$MFT` itself live.
//!
//! Record 0 is `$MFT`. Its unnamed `$DATA` run list is only the first
//! piece of the table. When that piece is not the whole file, NTFS adds
//! an `$ATTRIBUTE_LIST` (0x20) and stores the rest of the run list in
//! extension records. Those records are read through the runs gathered
//! so far and appended in starting-VCN order.

use std::io::{self, Read, Seek, SeekFrom};

/// One extent of a non-resident attribute. `lcn == -1` is a sparse hole.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DataRun {
    pub lcn: i64,
    pub cluster_count: u64,
}

/// Unnamed `$DATA` fragment: the logical cluster where it starts, then
/// its own run list (offsets in that list are relative to this fragment).
pub type DataSegment = (u64, Vec<DataRun>);

/// A non-resident `$ATTRIBUTE_LIST` whose bytes live in these runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalAttributeList {
    pub runs: Vec<DataRun>,
    pub byte_length: u64,
}

/// What record 0 says about `$MFT`'s own mapping.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record0Map {
    pub segments: Vec<DataSegment>,
    /// Extension records that hold further unnamed `$DATA` (never 0).
    pub extension_records: Vec<u64>,
    pub external_attribute_list: Option<ExternalAttributeList>,
}

const FILE_RECORD_MAGIC: &[u8; 4] = b"FILE";
const FLAG_IN_USE: u16 = 0x0001;
const ATTR_ATTRIBUTE_LIST: u32 = 0x20;
const ATTR_DATA: u32 = 0x80;
const ATTR_END_MARKER: u32 = 0xFFFF_FFFF;
const FILE_REF_MASK: u64 = 0x0000_FFFF_FFFF_FFFF;

/// Run list of an unnamed non-resident attribute, absolute LCNs.
pub fn parse_data_runs(mut runs: &[u8]) -> Vec<DataRun> {
    let mut out = Vec::new();
    let mut current_lcn: i64 = 0;
    while !runs.is_empty() {
        let header = runs[0];
        if header == 0 {
            break;
        }
        let offset_len = (header >> 4) as usize;
        let count_len = (header & 0x0F) as usize;
        if count_len == 0 || 1 + count_len + offset_len > runs.len() {
            break;
        }
        let mut count: u64 = 0;
        for i in 0..count_len {
            count |= (runs[1 + i] as u64) << (8 * i);
        }
        if offset_len == 0 {
            out.push(DataRun {
                lcn: -1,
                cluster_count: count,
            });
        } else {
            let mut offset_delta: i64 = 0;
            let delta_bytes = &runs[1 + count_len..1 + count_len + offset_len];
            for (i, byte) in delta_bytes.iter().enumerate() {
                offset_delta |= (*byte as i64) << (8 * i);
            }
            let sign_bit = 1_i64 << (8 * offset_len - 1);
            if offset_delta & sign_bit != 0 {
                offset_delta |= !((1_i64 << (8 * offset_len)) - 1);
            }
            current_lcn = current_lcn.wrapping_add(offset_delta);
            out.push(DataRun {
                lcn: current_lcn,
                cluster_count: count,
            });
        }
        runs = &runs[1 + count_len + offset_len..];
    }
    out
}

/// Record 0's unnamed `$DATA` pieces, plus where the rest of the run
/// list lives. `None` when this is not an in-use FILE record.
pub fn record_0_mft_map(record: &[u8]) -> Option<Record0Map> {
    let mut map = Record0Map {
        segments: Vec::new(),
        extension_records: Vec::new(),
        external_attribute_list: None,
    };
    if !walk_attributes(record, &mut map, true) {
        return None;
    }
    if map.segments.is_empty()
        && map.extension_records.is_empty()
        && map.external_attribute_list.is_none()
    {
        return None;
    }
    Some(map)
}

/// Unnamed `$DATA` fragments stored in one extension record.
pub fn unnamed_data_segments(record: &[u8]) -> Vec<DataSegment> {
    let mut map = Record0Map {
        segments: Vec::new(),
        extension_records: Vec::new(),
        external_attribute_list: None,
    };
    if !walk_attributes(record, &mut map, false) {
        return Vec::new();
    }
    map.segments
}

/// Extension record numbers named by an `$ATTRIBUTE_LIST` value.
/// Entries for record 0, named attributes, and anything other than
/// `$DATA` are ignored.
pub fn extension_records_from_attribute_list(list: &[u8]) -> Vec<u64> {
    let mut out = Vec::new();
    let mut offset = 0;
    while offset + 26 <= list.len() {
        let rec_len = u16::from_le_bytes([list[offset + 4], list[offset + 5]]) as usize;
        if rec_len < 26 || offset + rec_len > list.len() {
            break;
        }
        let attr_type = u32::from_le_bytes([
            list[offset],
            list[offset + 1],
            list[offset + 2],
            list[offset + 3],
        ]);
        let name_len = list[offset + 6];
        let file_ref = u64::from_le_bytes(list[offset + 16..offset + 24].try_into().unwrap());
        let record_number = file_ref & FILE_REF_MASK;
        if attr_type == ATTR_DATA
            && name_len == 0
            && record_number != 0
            && !out.contains(&record_number)
        {
            out.push(record_number);
        }
        offset += rec_len;
    }
    out
}

/// Concatenate fragments in starting-VCN order. A hole becomes a sparse
/// run so later extents keep their real record numbers. Overlapping
/// fragments are dropped. `had_gap` is set for either.
pub fn join_run_segments(segments: &[DataSegment]) -> (Vec<DataRun>, bool) {
    let mut ordered: Vec<&DataSegment> = segments.iter().collect();
    ordered.sort_by_key(|(vcn, _)| *vcn);
    let mut runs = Vec::new();
    let mut cursor: u64 = 0;
    let mut had_gap = false;
    for (vcn, frag_runs) in ordered {
        let clusters = cluster_span(frag_runs);
        if clusters == 0 {
            continue;
        }
        if *vcn < cursor {
            had_gap = true;
            continue;
        }
        if *vcn > cursor {
            runs.push(DataRun {
                lcn: -1,
                cluster_count: *vcn - cursor,
            });
            had_gap = true;
            cursor = *vcn;
        }
        runs.extend_from_slice(frag_runs);
        cursor = cursor.saturating_add(clusters);
    }
    (runs, had_gap)
}

pub fn logical_byte_length(runs: &[DataRun], bytes_per_cluster: u64) -> Option<u64> {
    let mut total = 0u64;
    for run in runs {
        let bytes = run.cluster_count.checked_mul(bytes_per_cluster)?;
        total = total.checked_add(bytes)?;
    }
    Some(total)
}

/// Bytes to read from `\\.\X:` for an initialized length of `logical_len`.
///
/// A volume handle rejects a transfer that is not a whole number of
/// sectors. The result is the next sector boundary, and it never passes
/// the sector-aligned prefix of `available`. Bytes past `logical_len`
/// are padding and must not be parsed.
pub fn sector_aligned_read_len(logical_len: u64, bytes_per_sector: u64, available: u64) -> u64 {
    let sector = bytes_per_sector.max(1);
    let room = available / sector * sector;
    let want = logical_len.min(room);
    if want == 0 {
        return 0;
    }
    let aligned = want.saturating_add(sector - 1) / sector * sector;
    aligned.min(room)
}

/// A non-resident `$ATTRIBUTE_LIST` is read whole, or not at all.
/// A prefix would drop every extension record past the cut.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttributeListRead {
    /// Sector-aligned byte count to read. Parse only the initialized prefix.
    Ready(u64),
    /// The list is on disk and larger than `max_bytes`.
    TooBig(u64),
    /// No sector-aligned bytes are available.
    Missing,
}

pub fn attribute_list_read(
    byte_length: u64,
    bytes_per_sector: u64,
    available: u64,
    max_bytes: u64,
) -> AttributeListRead {
    let read_len = sector_aligned_read_len(byte_length, bytes_per_sector, available);
    if read_len == 0 {
        AttributeListRead::Missing
    } else if read_len > max_bytes {
        AttributeListRead::TooBig(read_len)
    } else {
        AttributeListRead::Ready(read_len)
    }
}

/// Pull unnamed `$DATA` fragments out of each extension record.
/// A record the current map cannot reach stays pending until a fragment
/// just loaded covers it. Records that never become readable, or that
/// are not FILE records, are returned unread.
pub fn absorb_extension_records(
    segments: &mut Vec<DataSegment>,
    mut pending: Vec<u64>,
    record_size: usize,
    mut read_record: impl FnMut(&[DataRun], u64, &mut [u8]) -> io::Result<bool>,
) -> io::Result<Vec<u64>> {
    let mut unresolved = Vec::new();
    loop {
        let (runs_now, _) = join_run_segments(segments);
        let mut still_out_of_range = Vec::new();
        let mut progress = false;
        for frn in pending {
            let Some(logical) = frn.checked_mul(record_size as u64) else {
                unresolved.push(frn);
                continue;
            };
            let mut buf = vec![0u8; record_size];
            if !read_record(&runs_now, logical, &mut buf)? {
                still_out_of_range.push(frn);
                continue;
            }
            let more = unnamed_data_segments(&buf);
            if more.is_empty() {
                unresolved.push(frn);
            } else {
                segments.extend(more);
                progress = true;
            }
        }
        if still_out_of_range.is_empty() || !progress {
            unresolved.extend(still_out_of_range);
            break;
        }
        pending = still_out_of_range;
    }
    Ok(unresolved)
}

/// Disk byte and how many contiguous bytes of this run follow it.
/// `None` past the end or inside a sparse hole.
pub fn locate_logical(
    runs: &[DataRun],
    logical: u64,
    bytes_per_cluster: u64,
) -> Option<(u64, u64)> {
    if bytes_per_cluster == 0 {
        return None;
    }
    let mut cursor = 0u64;
    for run in runs {
        let run_bytes = run.cluster_count.checked_mul(bytes_per_cluster)?;
        let end = cursor.checked_add(run_bytes)?;
        if logical < end {
            if run.lcn < 0 {
                return None;
            }
            let into = logical - cursor;
            let disk = (run.lcn as u64)
                .checked_mul(bytes_per_cluster)?
                .checked_add(into)?;
            return Some((disk, end - logical));
        }
        cursor = end;
    }
    None
}

/// Read `buf` from the logical stream described by `runs`. `Ok(false)`
/// when any byte is past the map or in a sparse hole.
pub fn read_logical<R: Read + Seek>(
    volume: &mut R,
    runs: &[DataRun],
    mut logical: u64,
    buf: &mut [u8],
    bytes_per_cluster: u64,
) -> io::Result<bool> {
    let mut filled = 0;
    while filled < buf.len() {
        let Some((disk, available)) = locate_logical(runs, logical, bytes_per_cluster) else {
            return Ok(false);
        };
        let n = available.min((buf.len() - filled) as u64) as usize;
        if n == 0 {
            return Ok(false);
        }
        volume.seek(SeekFrom::Start(disk))?;
        volume.read_exact(&mut buf[filled..filled + n])?;
        filled += n;
        logical += n as u64;
    }
    Ok(true)
}

fn cluster_span(runs: &[DataRun]) -> u64 {
    runs.iter()
        .fold(0u64, |sum, run| sum.saturating_add(run.cluster_count))
}

fn walk_attributes(record: &[u8], map: &mut Record0Map, parse_list: bool) -> bool {
    if record.len() < 48 || &record[0..4] != FILE_RECORD_MAGIC {
        return false;
    }
    let flags = u16::from_le_bytes([record[22], record[23]]);
    if flags & FLAG_IN_USE == 0 {
        return false;
    }
    let mut pos = u16::from_le_bytes([record[20], record[21]]) as usize;
    while pos + 16 <= record.len() {
        let attr_type = u32::from_le_bytes([
            record[pos],
            record[pos + 1],
            record[pos + 2],
            record[pos + 3],
        ]);
        if attr_type == ATTR_END_MARKER {
            break;
        }
        let attr_len = u32::from_le_bytes([
            record[pos + 4],
            record[pos + 5],
            record[pos + 6],
            record[pos + 7],
        ]) as usize;
        if attr_len < 16 || pos + attr_len > record.len() {
            break;
        }
        let non_resident = record[pos + 8];
        let name_len = record[pos + 9];
        if name_len == 0 && attr_type == ATTR_DATA && non_resident != 0 {
            if let Some(segment) = data_segment(record, pos, attr_len) {
                map.segments.push(segment);
            }
        } else if parse_list && name_len == 0 && attr_type == ATTR_ATTRIBUTE_LIST {
            if non_resident == 0 {
                if let Some(value) = resident_value(record, pos, attr_len) {
                    map.extension_records
                        .extend(extension_records_from_attribute_list(value));
                }
            } else if let Some(external) = external_list(record, pos, attr_len) {
                map.external_attribute_list = Some(external);
            }
        }
        pos += attr_len;
    }
    true
}

fn data_segment(buf: &[u8], pos: usize, attr_len: usize) -> Option<DataSegment> {
    if pos + 24 > buf.len() {
        return None;
    }
    let starting_vcn = u64::from_le_bytes(buf[pos + 16..pos + 24].try_into().ok()?);
    let runs = runs_in_attribute(buf, pos, attr_len)?;
    if runs.is_empty() {
        return None;
    }
    Some((starting_vcn, runs))
}

fn external_list(buf: &[u8], pos: usize, attr_len: usize) -> Option<ExternalAttributeList> {
    if pos + 64 > buf.len() {
        return None;
    }
    let real_size = u64::from_le_bytes(buf[pos + 48..pos + 56].try_into().ok()?);
    let initialized = u64::from_le_bytes(buf[pos + 56..pos + 64].try_into().ok()?);
    let byte_length = if initialized > 0 {
        initialized
    } else {
        real_size
    };
    if byte_length == 0 {
        return None;
    }
    let runs = runs_in_attribute(buf, pos, attr_len)?;
    if runs.is_empty() {
        return None;
    }
    Some(ExternalAttributeList { runs, byte_length })
}

fn resident_value(buf: &[u8], pos: usize, attr_len: usize) -> Option<&[u8]> {
    if pos + 22 > buf.len() {
        return None;
    }
    let value_len = u32::from_le_bytes(buf[pos + 16..pos + 20].try_into().ok()?) as usize;
    let value_off = u16::from_le_bytes([buf[pos + 20], buf[pos + 21]]) as usize;
    let start = pos + value_off;
    let end = start + value_len;
    if value_off < 24 || end > pos + attr_len || end > buf.len() {
        return None;
    }
    Some(&buf[start..end])
}

fn runs_in_attribute(buf: &[u8], pos: usize, attr_len: usize) -> Option<Vec<DataRun>> {
    if pos + 34 > buf.len() {
        return None;
    }
    let runlist_offset = u16::from_le_bytes([buf[pos + 32], buf[pos + 33]]) as usize;
    let run_start = pos + runlist_offset;
    let run_end = pos + attr_len;
    if run_start >= run_end || run_end > buf.len() {
        return None;
    }
    Some(parse_data_runs(&buf[run_start..run_end]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn file_record(attrs: &[u8]) -> Vec<u8> {
        let mut buf = vec![0u8; 56 + attrs.len() + 8];
        buf[0..4].copy_from_slice(b"FILE");
        buf[20..22].copy_from_slice(&56u16.to_le_bytes());
        buf[22..24].copy_from_slice(&FLAG_IN_USE.to_le_bytes());
        let start = 56;
        buf[start..start + attrs.len()].copy_from_slice(attrs);
        let end = start + attrs.len();
        buf[end..end + 4].copy_from_slice(&ATTR_END_MARKER.to_le_bytes());
        buf
    }

    /// One non-resident attribute: `count` clusters at absolute `lcn`.
    fn nonresident(
        attr_type: u32,
        starting_vcn: u64,
        count: u64,
        lcn: i64,
        initialized: u64,
    ) -> Vec<u8> {
        let runs = vec![0x11, count as u8, lcn as u8, 0];
        let header = 64usize;
        let mut attr = vec![0u8; header + runs.len()];
        let attr_len = (attr.len() as u32).to_le_bytes();
        attr[0..4].copy_from_slice(&attr_type.to_le_bytes());
        attr[4..8].copy_from_slice(&attr_len);
        attr[8] = 1;
        attr[16..24].copy_from_slice(&starting_vcn.to_le_bytes());
        attr[32..34].copy_from_slice(&(header as u16).to_le_bytes());
        attr[48..56].copy_from_slice(&initialized.to_le_bytes());
        attr[56..64].copy_from_slice(&initialized.to_le_bytes());
        attr[header..].copy_from_slice(&runs);
        attr
    }

    fn list_entry(attr_type: u32, record: u64, name_len: u8) -> Vec<u8> {
        let mut entry = vec![0u8; 32];
        entry[0..4].copy_from_slice(&attr_type.to_le_bytes());
        entry[4..6].copy_from_slice(&32u16.to_le_bytes());
        entry[6] = name_len;
        entry[16..24].copy_from_slice(&record.to_le_bytes());
        entry
    }

    fn resident_list(entries: &[u8]) -> Vec<u8> {
        let value_off = 24u16;
        let mut attr = vec![0u8; value_off as usize + entries.len()];
        let attr_len = (attr.len() as u32).to_le_bytes();
        attr[0..4].copy_from_slice(&ATTR_ATTRIBUTE_LIST.to_le_bytes());
        attr[4..8].copy_from_slice(&attr_len);
        attr[16..20].copy_from_slice(&(entries.len() as u32).to_le_bytes());
        attr[20..22].copy_from_slice(&value_off.to_le_bytes());
        attr[value_off as usize..].copy_from_slice(entries);
        attr
    }

    #[test]
    fn base_record_without_a_list_keeps_its_own_runs() {
        let record = file_record(&nonresident(ATTR_DATA, 0, 4, 10, 0));
        let map = record_0_mft_map(&record).unwrap();
        assert!(map.extension_records.is_empty());
        assert!(map.external_attribute_list.is_none());
        let (runs, gap) = join_run_segments(&map.segments);
        assert!(!gap);
        assert_eq!(
            runs,
            vec![DataRun {
                lcn: 10,
                cluster_count: 4
            }]
        );
    }

    #[test]
    fn attribute_list_names_extension_records_and_ignores_the_base_and_named_streams() {
        let mut entries = Vec::new();
        entries.extend(list_entry(ATTR_DATA, 0, 0));
        // High 16 bits are the sequence number, not part of the record number.
        entries.extend(list_entry(ATTR_DATA, 16 | (7u64 << 48), 0));
        entries.extend(list_entry(ATTR_DATA, 16, 0));
        entries.extend(list_entry(ATTR_DATA, 40, 1));
        entries.extend(list_entry(0x30, 16, 0));
        let list = resident_list(&entries);
        let mut attrs = nonresident(ATTR_DATA, 0, 8, 3, 0);
        attrs.extend(list);
        let map = record_0_mft_map(&file_record(&attrs)).unwrap();
        assert_eq!(map.extension_records, vec![16]);
    }

    #[test]
    fn extension_run_is_appended_in_vcn_order_even_when_parsed_first() {
        let base = unnamed_data_segments(&file_record(&nonresident(ATTR_DATA, 0, 100, 5, 0)));
        let ext = unnamed_data_segments(&file_record(&nonresident(ATTR_DATA, 100, 80, 50, 0)));
        let mut segments = ext;
        segments.extend(base);
        let (runs, gap) = join_run_segments(&segments);
        assert!(!gap);
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].lcn, 5);
        assert_eq!(runs[0].cluster_count, 100);
        assert_eq!(runs[1].lcn, 50);
        assert_eq!(runs[1].cluster_count, 80);
        assert_eq!(logical_byte_length(&runs, 4096), Some(180 * 4096));
    }

    #[test]
    fn a_missing_middle_fragment_stays_a_hole_so_later_records_keep_their_numbers() {
        let segments = vec![
            unnamed_data_segments(&file_record(&nonresident(ATTR_DATA, 0, 10, 1, 0))).remove(0),
            unnamed_data_segments(&file_record(&nonresident(ATTR_DATA, 30, 10, 2, 0))).remove(0),
        ];
        let (runs, gap) = join_run_segments(&segments);
        assert!(gap);
        assert_eq!(
            runs,
            vec![
                DataRun {
                    lcn: 1,
                    cluster_count: 10
                },
                DataRun {
                    lcn: -1,
                    cluster_count: 20
                },
                DataRun {
                    lcn: 2,
                    cluster_count: 10
                },
            ]
        );
    }

    #[test]
    fn nonresident_attribute_list_is_returned_for_the_caller_to_read() {
        let list = nonresident(ATTR_ATTRIBUTE_LIST, 0, 1, 9, 128);
        let data = nonresident(ATTR_DATA, 0, 2, 4, 0);
        let mut attrs = data;
        attrs.extend(list);
        let map = record_0_mft_map(&file_record(&attrs)).unwrap();
        let external = map.external_attribute_list.unwrap();
        assert_eq!(external.byte_length, 128);
        assert_eq!(external.runs[0].lcn, 9);
        assert!(map.extension_records.is_empty());
    }

    #[test]
    fn logical_read_crosses_a_run_boundary() {
        let runs = vec![
            DataRun {
                lcn: 0,
                cluster_count: 1,
            },
            DataRun {
                lcn: 5,
                cluster_count: 1,
            },
        ];
        let disk = vec![0u8; 6 * 512];
        let mut image = disk;
        image[0..512].fill(1);
        image[5 * 512..6 * 512].fill(2);
        let mut buf = [0u8; 600];
        assert_eq!(
            read_logical(&mut Cursor::new(image), &runs, 400, &mut buf, 512).unwrap(),
            true
        );
        assert!(buf[..112].iter().all(|b| *b == 1));
        assert!(buf[112..].iter().all(|b| *b == 2));
        let mut hole = [0u8; 4];
        let sparse = vec![DataRun {
            lcn: -1,
            cluster_count: 1,
        }];
        assert_eq!(
            read_logical(
                &mut Cursor::new(Vec::<u8>::new()),
                &sparse,
                0,
                &mut hole,
                512
            )
            .unwrap(),
            false
        );
    }

    #[test]
    fn extension_records_are_read_from_the_base_map_and_then_from_each_other() {
        let bpc = 1024u64;
        let record_size = 1024usize;
        // Records 0 and 1 live in the base extent. Record 1 points at a
        // second extent, and record 2 lives only in that second extent.
        let mut image = vec![0u8; 11 * record_size];
        let rec1 = file_record(&nonresident(ATTR_DATA, 2, 1, 10, 0));
        image[record_size..record_size + rec1.len()].copy_from_slice(&rec1);
        let rec2 = file_record(&nonresident(ATTR_DATA, 3, 4, 20, 0));
        let rec2_at = 10 * record_size;
        image[rec2_at..rec2_at + rec2.len()].copy_from_slice(&rec2);

        let mut segments = unnamed_data_segments(&file_record(&nonresident(ATTR_DATA, 0, 2, 0, 0)));
        let unresolved = absorb_extension_records(
            &mut segments,
            vec![1, 2, 99],
            record_size,
            |runs, logical, buf| {
                read_logical(&mut Cursor::new(image.clone()), runs, logical, buf, bpc)
            },
        )
        .unwrap();
        assert_eq!(unresolved, vec![99]);
        let (runs, gap) = join_run_segments(&segments);
        assert!(!gap);
        assert_eq!(
            runs,
            vec![
                DataRun {
                    lcn: 0,
                    cluster_count: 2
                },
                DataRun {
                    lcn: 10,
                    cluster_count: 1
                },
                DataRun {
                    lcn: 20,
                    cluster_count: 4
                },
            ]
        );
    }

    #[test]
    fn a_long_attribute_list_is_read_whole_or_refused() {
        let sector = 512u64;
        let available = 3 * 1024 * 1024;
        let two_mb = 2 * 1024 * 1024;
        assert_eq!(
            attribute_list_read(two_mb, sector, available, 32 * 1024 * 1024),
            AttributeListRead::Ready(two_mb)
        );
        assert_eq!(
            attribute_list_read(two_mb, sector, available, 1024 * 1024),
            AttributeListRead::TooBig(two_mb)
        );
        assert_eq!(
            attribute_list_read(100, sector, 4096, 1024 * 1024),
            AttributeListRead::Ready(512)
        );
        assert_eq!(
            attribute_list_read(0, sector, available, 1024 * 1024),
            AttributeListRead::Missing
        );
    }

    #[test]
    fn attribute_list_read_rounds_up_to_a_whole_sector_and_stops_at_the_runs() {
        assert_eq!(sector_aligned_read_len(100, 512, 4096), 512);
        assert_eq!(sector_aligned_read_len(512, 512, 4096), 512);
        assert_eq!(sector_aligned_read_len(513, 512, 4096), 1024);
        assert_eq!(sector_aligned_read_len(5_000, 512, 4096), 4096);
        assert_eq!(sector_aligned_read_len(0, 512, 4096), 0);
        // Shorter than one sector: refuse an unaligned transfer.
        assert_eq!(sector_aligned_read_len(100, 512, 200), 0);
    }

    #[test]
    fn stale_bytes_past_the_initialized_list_are_not_entries() {
        let entry = list_entry(ATTR_DATA, 16, 0);
        let mut padded = entry.clone();
        padded.extend(list_entry(ATTR_DATA, 99, 0));
        assert_eq!(
            extension_records_from_attribute_list(&padded[..entry.len()]),
            vec![16]
        );
    }

    #[test]
    fn relative_run_offsets_accumulate() {
        // Two runs: 3 clusters at LCN 10, then 2 clusters at delta -4 → LCN 6.
        let bytes = [0x11, 3, 10, 0x11, 2, (-4i8) as u8, 0];
        assert_eq!(
            parse_data_runs(&bytes),
            vec![
                DataRun {
                    lcn: 10,
                    cluster_count: 3
                },
                DataRun {
                    lcn: 6,
                    cluster_count: 2
                },
            ]
        );
    }
}
