import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectIoBudget, measureFsIo } from "../../test/ioBudget";
import { easyMove, initEasyMoveStore } from "../easyMoveStore";

vi.mock("node:fs", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFs(await importOriginal()));
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../../test/ioBudget")).instrumentFsPromises(await importOriginal()));

let tempDir: string;

beforeEach(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-easymove-io-"));
  await FSP.mkdir(Path.join(tempDir, "source"));
  await FSP.mkdir(Path.join(tempDir, "dest"));
  initEasyMoveStore(tempDir);
});

afterEach(async () => {
  await FSP.rm(tempDir, { recursive: true, force: true });
});

// Windows moves take the junction / hardlink / robocopy paths instead.
describe.skipIf(process.platform === "win32")("Easy Move store", () => {
  it("writes easy-moves.json once per move", async () => {
    const filePath = Path.join(tempDir, "source", "video.mp4");
    await FSP.writeFile(filePath, Buffer.alloc(64 * 1024));

    const { result, io } = await measureFsIo(() => easyMove(filePath, Path.join(tempDir, "dest")));

    expect(result.ok).toBe(true);
    expectIoBudget({
      scenario: "easy-move-file",
      note: "one same-volume Easy Move of a file: the user's own rename plus 1 sync, pretty-printed, atomic rewrite of easy-moves.json (temp file + a second rename); per move or undo",
      io,
    });
    expect(JSON.parse(FS.readFileSync(Path.join(tempDir, "easy-moves.json"), "utf8"))).toHaveLength(1);
  });
});
