import { describe, expect, it } from "vitest";

import { BinaryHeap, TopK } from "../topK";

function rand(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

describe("BinaryHeap", () => {
  it("pops in order", () => {
    const next = rand(1);
    const values = Array.from({ length: 500 }, () => Math.floor(next() * 100));
    const heap = new BinaryHeap<number>((a, b) => a < b);
    for (const value of values) heap.push(value);
    const out: number[] = [];
    while (heap.size > 0) out.push(heap.pop()!);
    expect(out).toEqual([...values].sort((a, b) => a - b));
  });

  it("does O(log n) comparisons per push and pop", () => {
    const run = (n: number) => {
      let compares = 0;
      const heap = new BinaryHeap<number>((a, b) => {
        compares += 1;
        return a < b;
      });
      // Descending input makes every push sift to the root.
      for (let i = n; i > 0; i -= 1) heap.push(i);
      while (heap.size > 0) heap.pop();
      return compares;
    };
    for (const n of [1_000, 8_000]) {
      expect(run(n)).toBeLessThanOrEqual(3 * n * Math.log2(n));
    }
  });
});

describe("TopK", () => {
  const byScoreDesc = (a: { score: number }, b: { score: number }) => b.score - a.score;

  it("keeps what a stable sort cut to the limit would, ties included", () => {
    const next = rand(7);
    for (let round = 0; round < 200; round += 1) {
      const limit = Math.floor(next() * 12);
      const items = Array.from({ length: Math.floor(next() * 60) }, (_, id) => ({
        id,
        score: Math.floor(next() * 8),
      }));
      const top = new TopK(limit, byScoreDesc);
      for (const item of items) top.offer(item);
      expect(top.sorted()).toEqual([...items].sort(byScoreDesc).slice(0, limit));
    }
  });

  it("reports the item to beat once full", () => {
    const top = new TopK<{ score: number }>(2, byScoreDesc);
    expect(top.lowest).toBeUndefined();
    top.offer({ score: 5 });
    expect(top.lowest).toBeUndefined();
    top.offer({ score: 9 });
    expect(top.lowest).toEqual({ score: 5 });
    expect(top.offer({ score: 5 })).toBe(false);
    expect(top.offer({ score: 6 })).toBe(true);
    expect(top.lowest).toEqual({ score: 6 });
  });

  it("keeps nothing for a zero, negative or NaN limit", () => {
    for (const limit of [0, -3, Number.NaN]) {
      const top = new TopK<{ score: number }>(limit, byScoreDesc);
      expect(top.limit).toBe(0);
      expect(top.offer({ score: 1 })).toBe(false);
      expect(top.sorted()).toEqual([]);
    }
  });

  it("does O(log limit) comparisons per offer on ascending input", () => {
    const run = (n: number, limit: number) => {
      let compares = 0;
      const top = new TopK<number>(limit, (a, b) => {
        compares += 1;
        return b - a;
      });
      // Ascending: every offer beats the smallest kept item.
      for (let i = 0; i < n; i += 1) top.offer(i);
      top.sorted();
      return compares;
    };
    const small = run(4_000, 500);
    const large = run(32_000, 4_000);
    // Re-sorting on each accepted item would grow with n × limit (64×).
    expect(large).toBeLessThanOrEqual(small * 16);
    expect(large).toBeLessThanOrEqual(4 * 32_000 * Math.log2(4_000));
  });
});
