import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { gzipSync } from "node:zlib";

import { parseIndexLine } from "../shared/indexLineParse";
import { measureOpsSync, totalOps } from "./opCounter";

/** A fresh temp directory, removed by the returned cleanup. */
export async function makeTempDir(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await FSP.mkdtemp(Path.join(OS.tmpdir(), `diskhound-${prefix}-`));
  return { dir, cleanup: () => FSP.rm(dir, { recursive: true, force: true }) };
}

/** Write NDJSON lines as a gzipped scan index, the format the scanners write. */
export function writeIndexFixture(filePath: string, records: Iterable<Record<string, unknown>>): string {
  const lines: string[] = [];
  for (const record of records) lines.push(JSON.stringify(record));
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.writeFileSync(filePath, gzipSync(`${lines.join("\n")}\n`, { level: 1 }));
  return filePath;
}

/**
 * `count` file records under `root`, spread over `folders` folders, with
 * sizes in ascending order. Ascending input is the worst case for a
 * bounded top-N list: every record beats the smallest one kept.
 */
export function* ascendingFileRecords(
  root: string,
  count: number,
  { folders = 64, minSize = 1_000, mtime = 1_700_000_000_000 }: { folders?: number; minSize?: number; mtime?: number } = {},
): Generator<Record<string, unknown>> {
  for (let i = 0; i < count; i += 1) {
    const folder = Path.join(root, `dir-${i % folders}`);
    yield { p: Path.join(folder, `file-${i}.bin`), s: minSize + i, m: mtime };
  }
}

/**
 * What `parseIndexLine` spends unescaping the `\` separators in one line
 * like `record`, beyond the same line with `/` separators. It's a few
 * string ops per `\`: 0 on macOS and Linux, about 20 for a path under a
 * Windows temp dir. Tests over parsed index lines add twice lines × this
 * to their absolute caps (the same headroom as the rest of the cap), so
 * one cap fits every OS.
 */
export function backslashParseOps(record: Record<string, unknown>): number {
  const ops = (line: string) => totalOps(measureOpsSync(() => parseIndexLine(line)).ops);
  const withSlashes = { ...record, p: String(record.p).replaceAll("\\", "/") };
  return Math.max(0, ops(JSON.stringify(record)) - ops(JSON.stringify(withSlashes)));
}
