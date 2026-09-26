import { createRequire } from "node:module";
import * as Path from "node:path";
import { gzipSync } from "node:zlib";

/**
 * A synthetic scan index shaped like the native scanner's: gzipped
 * NDJSON at level 1, `{"p":…,"s":…,"m":…}` per file and
 * `{"p":…,"t":"d","m":…}` per folder. Paths are drawn from the kinds of
 * trees a system drive holds, about 100 characters on average, so the
 * bytes a test measures per file project to a real drive: the native
 * index is ~330 MB for 7M files (~47 B per file).
 *
 * Written with the real fs, so a test's setup stays out of its
 * measurement whatever it mocks.
 */

const realFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");

export interface IndexFileEntry {
  path: string;
  size: number;
  mtime: number;
}

export interface SyntheticTree {
  root: string;
  dirs: string[];
  files: IndexFileEntry[];
}

const MTIME_BASE = 1_750_000_000_000;

/** Deterministic, so every run and platform writes the same bytes. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function hex(next: () => number, length: number): string {
  let out = "";
  while (out.length < length) out += Math.floor(next() * 16).toString(16);
  return out;
}

/** One folder's path segments below the root, by the kind of tree it sits in. */
function folderSegments(next: () => number, d: number): string[] {
  switch (d % 5) {
    case 0:
      return ["Users", "someone", "AppData", "Local", "Packages",
        `Microsoft.Windows.Photos_8wekyb3d8bbwe`, "LocalCache", "Thumbnails", `shard-${d}`];
    case 1:
      return ["Users", "someone", "Projects", `workspace-${d % 37}`, "node_modules",
        `@scope-${d % 11}`, `package-${d}`, "dist", "esm"];
    case 2:
      return ["Windows", "WinSxS",
        `amd64_microsoft-windows-component-${d}_31bf3856ad364e35_10.0.22621.${d % 4000}_none_${hex(next, 16)}`];
    case 3:
      return ["Program Files", `Vendor ${d % 13}`, `Product ${d % 29}`, "resources", "app", `bundle-${d}`];
    default:
      return ["Users", "someone", "Library", "Caches", `com.example.app${d % 17}`, "Cache_Data", `f_${hex(next, 6)}`];
  }
}

const EXTENSIONS = [".js", ".jpg", ".dll", ".pak", ".json", ".bin", ".map", ".png"];

/**
 * `files` files in folders of ten under `root`, with the folders and
 * their ancestors listed once each.
 */
export function syntheticTree(root: string, files: number, seed = 1): SyntheticTree {
  const next = lcg(seed);
  const folders = Math.ceil(files / 10);
  const dirSet = new Set<string>([root]);
  const out: IndexFileEntry[] = [];
  for (let d = 0; d < folders; d++) {
    const segments = folderSegments(next, d);
    let dir = root;
    for (const segment of segments) {
      dir = Path.join(dir, segment);
      dirSet.add(dir);
    }
    for (let f = 0; f < 10 && out.length < files; f++) {
      const ext = EXTENSIONS[(d + f) % EXTENSIONS.length]!;
      out.push({
        path: Path.join(dir, `${hex(next, 12)}-item-${f}${ext}`),
        size: 4096 * (1 + Math.floor(next() * 2_000)),
        mtime: MTIME_BASE + Math.floor(next() * 1e9),
      });
    }
  }
  return { root, dirs: [...dirSet], files: out };
}

export function indexLines(tree: SyntheticTree): string {
  const lines: string[] = [];
  for (const dir of tree.dirs) lines.push(JSON.stringify({ p: dir, t: "d", m: MTIME_BASE }));
  for (const file of tree.files) lines.push(JSON.stringify({ p: file.path, s: file.size, m: file.mtime }));
  return `${lines.join("\n")}\n`;
}

/** Writes `tree` as a native-style index. Returns the file's size. */
export function writeSyntheticIndex(filePath: string, tree: SyntheticTree): number {
  realFs.mkdirSync(Path.dirname(filePath), { recursive: true });
  const gz = gzipSync(indexLines(tree), { level: 1 });
  realFs.writeFileSync(filePath, gz);
  return gz.byteLength;
}

/**
 * A folder-tree sidecar in the scanner's shape, one gzipped line per
 * parent folder with its files and subfolders.
 */
export function writeSyntheticFolderTreeSidecar(filePath: string, tree: SyntheticTree): number {
  const byParent = new Map<string, { d: Array<[string, number, number]>; f: Array<[string, number, number]> }>();
  const node = (key: string) => {
    let entry = byParent.get(key);
    if (!entry) {
      entry = { d: [], f: [] };
      byParent.set(key, entry);
    }
    return entry;
  };
  for (const dir of tree.dirs) {
    if (dir !== tree.root) node(Path.dirname(dir)).d.push([dir, 0, 0]);
  }
  for (const file of tree.files) {
    node(Path.dirname(file.path)).f.push([Path.basename(file.path), file.size, file.mtime]);
  }
  const lines = [...byParent].map(([k, v]) => JSON.stringify({ k, d: v.d, f: v.f }));
  realFs.mkdirSync(Path.dirname(filePath), { recursive: true });
  const gz = gzipSync(`${lines.join("\n")}\n`, { level: 1 });
  realFs.writeFileSync(filePath, gz);
  return gz.byteLength;
}
