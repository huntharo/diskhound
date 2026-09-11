import type { Stats } from "node:fs";
import { describe, expect, it } from "vitest";

import { occupancyBytes, POSIX_BLOCK_BYTES } from "../allocatedSize";
import { indexUsesAllocatedSize } from "../contracts";

function fakeStat(overrides: Partial<Stats> & { blocks?: number }): Stats {
  return {
    size: 0,
    ...overrides,
  } as Stats;
}

describe("occupancyBytes", () => {
  it("uses allocated blocks on posix", () => {
    if (process.platform === "win32") return;
    const stat = fakeStat({ size: 512 * 1024 * 1024, blocks: 16 });
    expect(occupancyBytes(stat)).toBe(16 * POSIX_BLOCK_BYTES);
  });

  it("never returns negative occupancy", () => {
    const stat = fakeStat({ size: -10, blocks: -4 });
    expect(occupancyBytes(stat)).toBeGreaterThanOrEqual(0);
  });

  it("falls back to logical size when blocks are missing", () => {
    const stat = fakeStat({ size: 4096 });
    expect(occupancyBytes(stat)).toBe(4096);
  });
});

describe("indexUsesAllocatedSize", () => {
  it("treats tagged allocated history as usable baseline", () => {
    expect(indexUsesAllocatedSize({ sizeSemantics: "allocated" })).toBe(true);
  });

  it("rejects tagged logical history", () => {
    expect(indexUsesAllocatedSize({ sizeSemantics: "logical" })).toBe(false);
  });

  it("treats untagged history as allocated only off Windows", () => {
    expect(indexUsesAllocatedSize({})).toBe(process.platform !== "win32");
  });
});
