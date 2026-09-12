/**
 * Parse one folder-tree sidecar NDJSON line.
 *
 * Writers emit a fixed schema (native `append_folder_tree_line` and
 * Node `JSON.stringify({ k, d, f })`):
 *   {"k":"<parent>","d":[["<path>",size,fileCount],...],"f":[["<name>",size,mtime],...]}
 *
 * Fast path extracts those fields without JSON.parse. Odd field order
 * or unusual escapes fall back to JSON.parse.
 */

export type FolderTreeSidecarEntry = {
  key: string;
  dirs: { path: string; size: number; fileCount: number }[];
  files: { name: string; size: number; modifiedAt: number }[];
};

function unescapeJsonPath(escaped: string): string {
  return escaped.indexOf("\\") === -1
    ? escaped
    : escaped.replace(/\\\\/g, "\\").replace(/\\"/g, '"');
}

function readJsonString(line: string, quoteIndex: number): { value: string; end: number } | null {
  if (line.charCodeAt(quoteIndex) !== 34) return null;
  let i = quoteIndex + 1;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 34) {
      return { value: unescapeJsonPath(line.slice(quoteIndex + 1, i)), end: i + 1 };
    }
    if (c === 92) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return null;
}

function readUint(line: string, i: number): { value: number; end: number } | null {
  const start = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i += 1;
  }
  if (i === start) return null;
  return { value: Number(line.slice(start, i)), end: i };
}

function readTripleArray(
  line: string,
  i: number,
): { rows: [string, number, number][]; end: number } | null {
  if (line.charCodeAt(i) !== 91) return null;
  i += 1;
  if (line.charCodeAt(i) === 93) return { rows: [], end: i + 1 };
  const rows: [string, number, number][] = [];
  while (i < line.length) {
    if (line.charCodeAt(i) !== 91) return null;
    i += 1;
    const str = readJsonString(line, i);
    if (!str) return null;
    i = str.end;
    if (line.charCodeAt(i) !== 44) return null;
    i += 1;
    const n1 = readUint(line, i);
    if (!n1) return null;
    i = n1.end;
    if (line.charCodeAt(i) !== 44) return null;
    i += 1;
    const n2 = readUint(line, i);
    if (!n2) return null;
    i = n2.end;
    if (line.charCodeAt(i) !== 93) return null;
    i += 1;
    rows.push([str.value, n1.value, n2.value]);
    const next = line.charCodeAt(i);
    if (next === 93) return { rows, end: i + 1 };
    if (next !== 44) return null;
    i += 1;
  }
  return null;
}

function parseFolderTreeSidecarLineSlow(line: string): FolderTreeSidecarEntry | null {
  let rec: {
    k?: string;
    d?: [string, number, number][];
    f?: [string, number, number][];
  };
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof rec.k !== "string") return null;
  const dirs = Array.isArray(rec.d)
    ? rec.d
        .filter((row) => Array.isArray(row) && row.length >= 3)
        .map(([path, size, fileCount]) => ({ path, size, fileCount }))
    : [];
  const files = Array.isArray(rec.f)
    ? rec.f
        .filter((row) => Array.isArray(row) && row.length >= 3)
        .map(([name, size, modifiedAt]) => ({ name, size, modifiedAt }))
    : [];
  return { key: rec.k, dirs, files };
}

export function parseFolderTreeSidecarLine(line: string): FolderTreeSidecarEntry | null {
  if (line.startsWith('{"k":"')) {
    const key = readJsonString(line, 5);
    if (key && line.startsWith(',"d":', key.end)) {
      const dirs = readTripleArray(line, key.end + 5);
      if (dirs && line.startsWith(',"f":', dirs.end)) {
        const files = readTripleArray(line, dirs.end + 5);
        if (files && line.charCodeAt(files.end) === 125 && files.end + 1 === line.length) {
          return {
            key: key.value,
            dirs: dirs.rows.map(([path, size, fileCount]) => ({ path, size, fileCount })),
            files: files.rows.map(([name, size, modifiedAt]) => ({ name, size, modifiedAt })),
          };
        }
      }
    }
  }
  return parseFolderTreeSidecarLineSlow(line);
}
