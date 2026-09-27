import { describe, expect, it } from "vitest";

import { formatBytesRange } from "../format";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

describe("formatBytesRange", () => {
  it("shares the unit when both ends have it", () => {
    expect(formatBytesRange(684 * GiB, 694 * GiB)).toBe("684–694 GB");
  });

  it("spells out both ends when the units differ", () => {
    expect(formatBytesRange(0, 32 * MiB)).toBe("0 B – 32.0 MB");
    expect(formatBytesRange(900 * MiB, 1.5 * GiB)).toBe("900 MB – 1.5 GB");
  });

  it("gives one value when both ends format alike", () => {
    expect(formatBytesRange(684 * GiB, 684.2 * GiB)).toBe("684 GB");
  });
});
