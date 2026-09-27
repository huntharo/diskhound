import { describe, expect, it } from "vitest";

import { countReads, expectNearLinear, measureOps, measureOpsSync } from "../opCounter";

describe("measureOps", () => {
  it("counts builtin work done inside the measured function only", () => {
    const outside = [1, 2, 3].map((n) => n * 2);
    const { result, ops } = measureOpsSync(() => {
      const copy = [...outside];
      copy.sort((a, b) => b - a);
      const keys = new Set(copy);
      let sum = 0;
      for (const key of keys) sum += key;
      return `${sum}`.padStart(4, "0").toLowerCase();
    });
    expect(result).toBe("0012");
    // The spread copies 3 elements and new Set(copy) iterates 3 more.
    expect(ops.elements).toBe(6);
    expect(ops.compares).toBeGreaterThanOrEqual(2);
    expect(ops.entries).toBe(3);
    expect(ops.strings).toBe(2);
  });

  it("restores the builtins afterwards", () => {
    const sort = Array.prototype.sort;
    measureOpsSync(() => [2, 1].sort((a, b) => a - b));
    expect(Array.prototype.sort).toBe(sort);
  });

  it("follows the measured function across awaits", async () => {
    const { ops } = await measureOps(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return [1, 2, 3, 4].slice(1);
    });
    expect(ops.elements).toBe(3);
  });

  it("counts reads through countReads wrappers", () => {
    const rows = countReads([{ size: 1 }, { size: 2 }]);
    const { ops } = measureOpsSync(() => {
      let total = 0;
      for (let i = 0; i < rows.length; i += 1) total += rows[i]!.size;
      return total;
    });
    expect(ops.reads).toBe(4);
  });

  it("flags quadratic growth and passes linear growth", () => {
    const quadratic = (n: number) => measureOpsSync(() => {
      const seen: number[] = [];
      for (let i = 0; i < n; i += 1) if (!seen.includes(i)) seen.push(i);
    }).ops;
    const linear = (n: number) => measureOpsSync(() => {
      const seen = new Set<number>();
      for (let i = 0; i < n; i += 1) if (!seen.has(i)) seen.add(i);
      return [...seen].length;
    }).ops;

    expectNearLinear("linear", linear(500), linear(4_000));
    expect(() => expectNearLinear("quadratic", quadratic(500), quadratic(4_000))).toThrow(/grew faster than linear/);
  });
});
