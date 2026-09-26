import { execFile } from "node:child_process";
import * as FS from "node:fs/promises";
import { existsSync } from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { queryCurrentCursor, runIncrementalScan } from "../usnMonitor";
import { volumeForPath } from "../shared/usnCursorStore";
import { normPath } from "../shared/pathUtils";

const exec = promisify(execFile);
const scanner = process.env.DISKHOUND_NATIVE_SCANNER_PATH || fileURLToPath(new URL(
  "../../native/diskhound-native-scanner/target/debug/diskhound-native-scanner.exe", import.meta.url,
));
const required = process.env.DISKHOUND_REQUIRE_USN_TESTS === "1";

async function indexedEntries(index: string): Promise<{ path: string; size: number }[]> {
  const text = gunzipSync(await FS.readFile(index)).toString("utf8");
  return text.trim().split("\n")
    .map((line) => JSON.parse(line) as { p: string; t?: string; s: number })
    .filter((entry) => entry.t !== "d")
    .map((entry) => ({ path: normPath(entry.p), size: entry.s }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function indexedFiles(index: string): Promise<string[]> {
  return (await indexedEntries(index)).map((entry) => entry.path).sort();
}

// No Electron launch, user profile, volume changes or privilege elevation.
// The native scanner and the actual Node updater share only this owned temp
// tree; output indexes sit outside its scanned subdirectory.
describe.skipIf(process.platform !== "win32")("real Windows USN to saved index", () => {
  it.for(["delete and move", "rename back and reuse"] as const)("%s", { timeout: 60_000 }, async (scenario, context) => {
    if (!existsSync(scanner)) {
      const reason = "USN integration needs the native debug scanner; run bun run test:usn:windows";
      if (required) throw new Error(reason);
      console.warn(reason);
      context.skip();
      return;
    }
    const owned = await FS.mkdtemp(Path.join(OS.tmpdir(), "diskhound-usn-integration-"));
    try {
      const dir = await FS.realpath(owned);
      const root = Path.join(dir, "tree");
      const outside = Path.join(dir, "outside");
      await FS.mkdir(root);
      await FS.mkdir(outside);
      const volume = volumeForPath(root);
      if (!await queryCurrentCursor(scanner, volume)) {
        const reason = "USN integration requires an existing NTFS journal and an elevated process; no volume settings were changed";
        if (required) throw new Error(reason);
        console.warn(reason);
        context.skip();
        return;
      }
      const keep = Path.join(root, "keep.bin");
      const gone = Path.join(root, "gone.bin");
      const old = Path.join(root, "old-名前.bin");
      await FS.writeFile(keep, Buffer.alloc(8192, 1));
      await FS.writeFile(gone, Buffer.alloc(8192, 2));
      await FS.writeFile(old, Buffer.alloc(8192, 3));
      const baseline = Path.join(dir, "baseline.ndjson.gz");
      await exec(scanner, ["--root", root, "--index-output", baseline], { timeout: 30_000, windowsHide: true });
      expect(await indexedFiles(baseline)).toEqual([keep, gone, old].map((path) => normPath(path)).sort());
      const originalIndex = await FS.readFile(baseline);
      const start = await queryCurrentCursor(scanner, volume);
      expect(start).not.toBeNull(); // Preflight passed; subsequent failures must fail the test.
      const cursor = { volume, cursor: start!.cursor, journalId: start!.journalId, capturedAt: Date.now(), rootPath: root };
      let expected: string[];
      if (scenario === "delete and move") {
        await FS.unlink(gone);
        // Two renames across parents, ending with a Unicode filename.
        const targetDir = Path.join(root, "destination");
        await FS.mkdir(targetDir);
        const middle = Path.join(targetDir, "middle.bin");
        const renamed = Path.join(targetDir, "new-名前.bin");
        await FS.rename(old, middle);
        await FS.rename(middle, renamed);
        // Moving out must remove the old in-root name; moving in must add it.
        await FS.rename(keep, Path.join(outside, "moved-out.bin"));
        const incoming = Path.join(outside, "incoming.bin");
        await FS.writeFile(incoming, Buffer.alloc(8192, 4));
        const added = Path.join(root, "incoming.bin");
        await FS.rename(incoming, added);
        const transient = Path.join(root, "transient.bin");
        await FS.writeFile(transient, "gone before the tick");
        await FS.unlink(transient);
        expected = [renamed, added];
      } else {
        // A -> B -> A must retain A despite its earlier old-name delete.
        const middle = Path.join(root, "round-trip.bin");
        await FS.rename(old, middle);
        await FS.rename(middle, old);
        // Move an indexed file away and reuse its old name with a new file ID.
        const moved = Path.join(root, "moved.bin");
        await FS.rename(gone, moved);
        await FS.writeFile(gone, Buffer.alloc(16384, 5));
        expected = [keep, old, gone, moved];
      }
      const updated = Path.join(dir, "updated.ndjson.gz");
      const result = await runIncrementalScan({ rootPath: root, scannerPath: scanner, previousIndexPath: baseline, newIndexPath: updated, cursor });
      expect(result?.changed).toBe(true);
      expect(await indexedFiles(updated)).toEqual(expected.map((path) => normPath(path)).sort());
      expect(await FS.readFile(baseline)).toEqual(originalIndex);
      if (!result?.changed) throw new Error("expected a committed incremental index");
      expect(result.snapshot.filesVisited).toBe(expected.length);
      expect(result.newCursor.cursor).toBeGreaterThan(cursor.cursor);
      // A second read from the returned cursor must not replay the operations.
      const replayPath = Path.join(dir, "replay.ndjson.gz");
      const replay = await runIncrementalScan({ rootPath: root, scannerPath: scanner, previousIndexPath: updated, newIndexPath: replayPath, cursor: result.newCursor });
      expect(replay?.changed).toBe(false);
      expect(existsSync(replayPath)).toBe(false);
      // Compare against a fresh native walk of the same tiny fixture.
      const full = Path.join(dir, "full.ndjson.gz");
      await exec(scanner, ["--root", root, "--index-output", full], { timeout: 30_000, windowsHide: true });
      expect(await indexedEntries(updated)).toEqual(await indexedEntries(full));
    } finally {
      await FS.rm(owned, { recursive: true, force: true });
    }
  });
});
