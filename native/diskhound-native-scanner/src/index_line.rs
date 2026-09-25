//! Hand-rolled NDJSON parse for scan-index lines.
//!
//! Inverse of IndexWriter's emitter:
//!   `{"p":"...","s":N,"m":N}` with optional `,"h":1`, then (macOS APFS)
//!   optional `,"v":N` (private bytes) and `,"k":1` (shares clone blocks)
//!   `{"p":"...","t":"d","m":N}`
//!
//! Canonical shape first; field scan for odd key order. Avoids
//! serde_json on the 7M-line baseline-load / inherit streams.

#[derive(Debug, PartialEq, Eq)]
pub struct IndexLineRec {
    pub path: String,
    pub size: Option<u64>,
    pub mtime: Option<u64>,
    pub is_dir: bool,
    pub extra_hardlink: bool,
}

pub fn parse_index_line(line: &str) -> Option<IndexLineRec> {
    let bytes = line.as_bytes();
    if let Some(rec) = parse_canonical_index_line(bytes) {
        return Some(rec);
    }
    parse_index_line_by_fields(bytes)
}

fn parse_canonical_index_line(line: &[u8]) -> Option<IndexLineRec> {
    if !line.starts_with(br#"{"p":""#) {
        return None;
    }
    let (path, rest) = parse_json_string(&line[5..])?;
    if rest.starts_with(br#","s":"#) {
        let (size, rest) = parse_u64_prefix(&rest[5..])?;
        if !rest.starts_with(br#","m":"#) {
            return None;
        }
        let (mtime, mut rest) = parse_u64_prefix(&rest[5..])?;
        let extra_hardlink = rest.starts_with(br#","h":1"#);
        if extra_hardlink {
            rest = &rest[6..];
        }
        // APFS clone accounting suffix. Nothing downstream of the
        // baseline reader needs it, so skip rather than store.
        if rest.starts_with(br#","v":"#) {
            let (_private, after) = parse_u64_prefix(&rest[5..])?;
            rest = after;
        }
        if rest.starts_with(br#","k":1"#) {
            rest = &rest[6..];
        }
        if rest != b"}" {
            return None;
        }
        return Some(IndexLineRec {
            path,
            size: Some(size),
            mtime: Some(mtime),
            is_dir: false,
            extra_hardlink,
        });
    }
    if rest.starts_with(br#","t":"d","m":"#) {
        let (mtime, rest) = parse_u64_prefix(&rest[12..])?;
        if rest != b"}" {
            return None;
        }
        return Some(IndexLineRec {
            path,
            size: None,
            mtime: Some(mtime),
            is_dir: true,
            extra_hardlink: false,
        });
    }
    None
}

fn parse_index_line_by_fields(line: &[u8]) -> Option<IndexLineRec> {
    let path = extract_json_string_field(line, br#""p":"#)?;
    let is_dir = find_bytes(line, br#""t":"d""#).is_some();
    let size = extract_u64_field(line, br#""s":"#);
    let mtime = extract_u64_field(line, br#""m":"#);
    let extra_hardlink = extract_u64_field(line, br#""h":"#) == Some(1);
    if is_dir {
        return Some(IndexLineRec {
            path,
            size: None,
            mtime,
            is_dir: true,
            extra_hardlink: false,
        });
    }
    Some(IndexLineRec {
        path,
        size,
        mtime,
        is_dir: false,
        extra_hardlink,
    })
}

fn extract_json_string_field(line: &[u8], key: &[u8]) -> Option<String> {
    let at = find_bytes(line, key)?;
    let (value, _) = parse_json_string(&line[at + key.len()..])?;
    Some(value)
}

fn extract_u64_field(line: &[u8], key: &[u8]) -> Option<u64> {
    let at = find_bytes(line, key)?;
    let (n, _) = parse_u64_prefix(&line[at + key.len()..])?;
    Some(n)
}

fn find_bytes(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|window| window == needle)
}

fn parse_json_string(bytes: &[u8]) -> Option<(String, &[u8])> {
    if bytes.first().copied() != Some(b'"') {
        return None;
    }
    let mut i = 1;
    let mut escaped = false;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => {
                escaped = true;
                i += 2;
                if i > bytes.len() {
                    return None;
                }
            }
            b'"' => {
                let raw = &bytes[1..i];
                let path = if escaped {
                    unescape_json_bytes(raw)?
                } else {
                    std::str::from_utf8(raw).ok()?.to_string()
                };
                return Some((path, &bytes[i + 1..]));
            }
            _ => i += 1,
        }
    }
    None
}

fn unescape_json_bytes(raw: &[u8]) -> Option<String> {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] != b'\\' {
            out.push(raw[i]);
            i += 1;
            continue;
        }
        i += 1;
        if i >= raw.len() {
            return None;
        }
        match raw[i] {
            b'\\' => out.push(b'\\'),
            b'"' => out.push(b'"'),
            b'/' => out.push(b'/'),
            b'n' => out.push(b'\n'),
            b'r' => out.push(b'\r'),
            b't' => out.push(b'\t'),
            b'u' => {
                if i + 4 >= raw.len() {
                    return None;
                }
                let hex = std::str::from_utf8(&raw[i + 1..i + 5]).ok()?;
                let cp = u32::from_str_radix(hex, 16).ok()?;
                let ch = char::from_u32(cp)?;
                let mut buf = [0u8; 4];
                out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                i += 4;
            }
            other => out.push(other),
        }
        i += 1;
    }
    String::from_utf8(out).ok()
}

fn parse_u64_prefix(bytes: &[u8]) -> Option<(u64, &[u8])> {
    if bytes.first().is_none_or(|b| !b.is_ascii_digit()) {
        return None;
    }
    let mut n: u64 = 0;
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        n = n.saturating_mul(10).saturating_add((bytes[i] - b'0') as u64);
        i += 1;
    }
    Some((n, &bytes[i..]))
}

#[cfg(test)]
mod tests {
    use super::{parse_canonical_index_line, parse_index_line};

    #[test]
    fn canonical_file_unescapes_windows_path() {
        let line = r#"{"p":"C:\\Users\\foo.txt","s":123,"m":456}"#;
        let rec = parse_index_line(line).unwrap();
        assert!(parse_canonical_index_line(line.as_bytes()).is_some());
        assert_eq!(rec.path, r"C:\Users\foo.txt");
        assert_eq!(rec.size, Some(123));
        assert_eq!(rec.mtime, Some(456));
        assert!(!rec.is_dir);
        assert!(!rec.extra_hardlink);
    }

    #[test]
    fn canonical_file_keeps_hardlink_flag() {
        let line = r#"{"p":"C:\\cache\\a","s":10,"m":1,"h":1}"#;
        let rec = parse_index_line(line).unwrap();
        assert!(rec.extra_hardlink);
        assert_eq!(rec.size, Some(10));
    }

    #[test]
    fn canonical_file_accepts_apfs_clone_suffix() {
        for line in [
            r#"{"p":"/u/a.js","s":4096,"m":1,"v":0,"k":1}"#,
            r#"{"p":"/u/a.js","s":4096,"m":1,"v":12}"#,
            r#"{"p":"/u/a.js","s":4096,"m":1,"k":1}"#,
            r#"{"p":"/u/a.js","s":4096,"m":1,"h":1,"v":0,"k":1}"#,
        ] {
            assert!(parse_canonical_index_line(line.as_bytes()).is_some(), "{line}");
            let rec = parse_index_line(line).unwrap();
            assert_eq!(rec.size, Some(4096));
            assert_eq!(rec.extra_hardlink, line.contains(r#""h":1"#));
        }
        assert!(parse_canonical_index_line(br#"{"p":"/u/a","s":1,"m":1,"k":1,"v":0}"#).is_none());
    }

    #[test]
    fn canonical_dir_line() {
        let line = r#"{"p":"C:\\Users","t":"d","m":99}"#;
        let rec = parse_index_line(line).unwrap();
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
        assert!(parse_canonical_index_line(line.as_bytes()).is_none());
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
