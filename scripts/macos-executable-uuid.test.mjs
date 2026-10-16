import { describe, expect, it } from "vitest";
import { personalizeMacExecutableUuid } from "./macos-executable-uuid.mjs";

function thin(cpu = 0x100000c) {
  const binary = Buffer.alloc(80, 0);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(cpu, 4);
  binary.writeUInt32LE(2, 12);
  binary.writeUInt32LE(1, 16);
  binary.writeUInt32LE(24, 20);
  binary.writeUInt32LE(0x1b, 32);
  binary.writeUInt32LE(24, 36);
  binary.fill(0xab, 40, 56);
  return binary;
}

const identity = "com.diskhound.app/1.1.2/40.6.0";

describe("macOS main executable UUID", () => {
  it("changes only LC_UUID and is idempotent", () => {
    const original = thin();
    const patched = personalizeMacExecutableUuid(original, identity);
    expect(patched.subarray(40, 56)).not.toEqual(original.subarray(40, 56));
    expect(patched.subarray(0, 40)).toEqual(original.subarray(0, 40));
    expect(patched.subarray(56)).toEqual(original.subarray(56));
    expect(personalizeMacExecutableUuid(patched, identity)).toEqual(patched);
    expect(original).toEqual(thin());
  });

  it("separates products, releases, Electron versions and architectures", () => {
    const uuids = [
      personalizeMacExecutableUuid(thin(), identity),
      personalizeMacExecutableUuid(thin(), "com.example.other/1.1.2/40.6.0"),
      personalizeMacExecutableUuid(thin(), "com.diskhound.app/1.1.3/40.6.0"),
      personalizeMacExecutableUuid(thin(), "com.diskhound.app/1.1.2/42.0.0"),
      personalizeMacExecutableUuid(thin(0x1000007), identity),
    ].map((binary) => binary.subarray(40, 56).toString("hex"));
    expect(new Set(uuids).size).toBe(5);
  });

  it.each([false, true])("patches both universal slices (64-bit header: %s)", (wide) => {
    const binary = Buffer.alloc(512);
    binary.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe, 0);
    binary.writeUInt32BE(2, 4);
    [128, 256].forEach((offset, i) => {
      const entry = 8 + i * (wide ? 32 : 20);
      binary.writeUInt32BE(i === 0 ? 0x100000c : 0x1000007, entry);
      if (wide) {
        binary.writeBigUInt64BE(BigInt(offset), entry + 8);
        binary.writeBigUInt64BE(80n, entry + 16);
      } else {
        binary.writeUInt32BE(offset, entry + 8);
        binary.writeUInt32BE(80, entry + 12);
      }
      thin(i === 0 ? 0x100000c : 0x1000007).copy(binary, offset);
    });
    const patched = personalizeMacExecutableUuid(binary, identity);
    expect(patched.subarray(128, 208)).toEqual(personalizeMacExecutableUuid(thin(), identity));
    expect(patched.subarray(256, 336)).toEqual(personalizeMacExecutableUuid(thin(0x1000007), identity));
    expect(personalizeMacExecutableUuid(patched, identity)).toEqual(patched);
  });

  it("rejects missing UUIDs, malformed commands, non-executables and truncated files", () => {
    const missing = thin(); missing.writeUInt32LE(0x19, 32);
    const malformed = thin(); malformed.writeUInt32LE(0, 36);
    const library = thin(); library.writeUInt32LE(6, 12);
    for (const binary of [missing, malformed, library, thin().subarray(0, 45), Buffer.alloc(0)]) {
      expect(() => personalizeMacExecutableUuid(binary, identity)).toThrow();
    }
  });

  it("rejects duplicate UUID commands and command table size mismatches", () => {
    const duplicate = thin();
    duplicate.writeUInt32LE(2, 16);
    duplicate.writeUInt32LE(48, 20);
    duplicate.copy(duplicate, 56, 32, 56);
    const mismatch = thin(); mismatch.writeUInt32LE(32, 20);
    for (const binary of [duplicate, mismatch]) {
      expect(() => personalizeMacExecutableUuid(binary, identity)).toThrow();
    }
  });

  it("rejects invalid universal bounds, overlaps and architecture metadata", () => {
    const fat = (offset = 128, cpu = 0x100000c) => {
      const binary = Buffer.alloc(512);
      binary.writeUInt32BE(0xcafebabf, 0);
      binary.writeUInt32BE(2, 4);
      for (const [i, start] of [128, offset].entries()) {
        const entry = 8 + i * 32;
        binary.writeUInt32BE(cpu, entry);
        binary.writeBigUInt64BE(BigInt(start), entry + 8);
        binary.writeBigUInt64BE(80n, entry + 16);
      }
      thin().copy(binary, 128);
      thin().copy(binary, 256);
      return binary;
    };
    for (const binary of [fat(), fat(32), fat(500), fat(256, 0x1000007), fat(Number.MAX_SAFE_INTEGER)]) {
      expect(() => personalizeMacExecutableUuid(binary, identity)).toThrow();
    }
    expect(() => personalizeMacExecutableUuid(thin(), "")).toThrow("identity");
  });
});
