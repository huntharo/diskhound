import { createHmac } from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureListenerKey, listenerKeyPath, listenerProof } from "../listenerProof";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) FS.rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "diskhound-listener-"));
  directories.push(directory);
  return directory;
}

describe("listenerKeyPath", () => {
  it("follows the helper's data directory, not Electron userData", () => {
    expect(listenerKeyPath("/home/test", { XDG_DATA_HOME: "/home/test/data" }, "linux")).toBe(
      "/home/test/data/DiskHound/mcp-listener-key",
    );
    expect(listenerKeyPath("/home/test", {}, "linux")).toBe("/home/test/.local/share/DiskHound/mcp-listener-key");
    expect(listenerKeyPath("/Users/test", {}, "darwin")).toBe(
      "/Users/test/Library/Application Support/DiskHound/mcp-listener-key",
    );
    expect(listenerKeyPath("C:\\Users\\test", { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "win32")).toBe(
      Path.win32.join("C:\\Users\\test\\AppData\\Local", "DiskHound", "mcp-listener-key"),
    );
  });
});

describe("ensureListenerKey", () => {
  it("creates a 32-byte key and keeps it on the next read", () => {
    const file = Path.join(tempDir(), "mcp-listener-key");
    const first = ensureListenerKey(file);
    const second = ensureListenerKey(file);
    expect(first).toHaveLength(32);
    expect(second.equals(first)).toBe(true);
    if (process.platform !== "win32") {
      expect(FS.statSync(file).mode & 0o777).toBe(0o600);
      expect(FS.statSync(Path.dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  it.runIf(process.platform !== "win32")("refuses a key other users can read", () => {
    const directory = tempDir();
    FS.chmodSync(directory, 0o755);
    expect(() => ensureListenerKey(Path.join(directory, "mcp-listener-key"))).toThrow(/private/);
  });
});

describe("listenerProof", () => {
  it("is HMAC-SHA256 of the nonce and not the key", () => {
    const key = Buffer.alloc(32, 0x11);
    const nonce = "a".repeat(43);
    expect(listenerProof(key, nonce)).toBe(createHmac("sha256", key).update(nonce, "utf8").digest("hex"));
    expect(listenerProof(key, nonce)).not.toContain(key.toString("hex"));
  });
});
