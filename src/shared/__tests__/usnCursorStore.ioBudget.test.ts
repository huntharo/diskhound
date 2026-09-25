import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { __resetStoreForTests, getCursor, initUsnCursorStore, setCursor } from "../usnCursorStore";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));

let dataDir: string;

beforeEach(async () => {
  dataDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-usn-io-"));
  __resetStoreForTests();
  await initUsnCursorStore(dataDir);
});

afterEach(async () => {
  __resetStoreForTests();
  await FSP.rm(dataDir, { recursive: true, force: true });
});

describe("USN cursor store", () => {
  it("writes usn-cursors.json once per scan", async () => {
    const { io } = await measureFsIo(() => setCursor({
      volume: "C:",
      cursor: 123_456_789,
      journalId: 42,
      capturedAt: Date.now(),
      rootPath: "C:\\",
    }));

    expectIoBudget({
      scenario: "usn-cursor-set",
      note: "the cursor saved after one full or incremental NTFS scan: 1 rewrite of usn-cursors.json (~170 B); 4/day at the 6 h scheduled-rescan default",
      io,
    });
    expect(getCursor("c")?.cursor).toBe(123_456_789);
  });
});
