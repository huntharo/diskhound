import { AsyncLocalStorage } from "node:async_hooks";

import { expect } from "vitest";

/**
 * Operation counting for scaling tests.
 *
 * A scaling test runs code at N and 8N and compares the work it did.
 * Wall-clock time flakes on loaded CI, so this counts operations:
 *
 * - `measureOps` patches the builtins that do per-element work and counts
 *   what the measured code does through them: sort comparator calls,
 *   array elements visited, copied or moved (callbacks, slice, concat,
 *   splice, shift, includes, spread and for-of), Set and Map entries
 *   iterated, String method calls, and Math.max / Math.min arguments.
 *   Only calls made inside the measured function's async context count,
 *   so vitest's own work never lands in the totals.
 * - `countReads` wraps inputs so every index or field read counts, for
 *   loops that touch data without calling a builtin.
 *
 * Counts are a proxy for work, not a cost model: a quadratic loop shows
 * up as quadratic growth in at least one category.
 */

export interface OpCounts {
  /** Sort comparator calls (Array#sort, Array#toSorted). */
  compares: number;
  /** Array elements visited, copied or moved by builtins and iterators. */
  elements: number;
  /** Set and Map entries visited by iterators and forEach. */
  entries: number;
  /** String method calls. */
  strings: number;
  /** Math.max / Math.min arguments. */
  math: number;
  /** Reads through `countReads` wrappers. */
  reads: number;
}

export type OpCategory = keyof OpCounts;

const CATEGORIES: readonly OpCategory[] = ["compares", "elements", "entries", "strings", "math", "reads"];

export function emptyOpCounts(): OpCounts {
  return { compares: 0, elements: 0, entries: 0, strings: 0, math: 0, reads: 0 };
}

export function totalOps(counts: OpCounts): number {
  let total = 0;
  for (const category of CATEGORIES) total += counts[category];
  return total;
}

const store = new AsyncLocalStorage<OpCounts>();

function active(): OpCounts | undefined {
  return store.getStore();
}

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

interface Patch {
  target: object;
  key: PropertyKey;
  descriptor: PropertyDescriptor;
}

// Captured before any patching: the wrappers below must not count themselves.
const mathMax = Math.max;
const mathMin = Math.min;

const ITERATOR_PROTOTYPE: object = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));

/** An iterator that counts each value it yields. Inherits iterator helpers. */
function countingIterator(inner: Iterator<unknown>, category: OpCategory, counts: OpCounts): Iterator<unknown> {
  const it = Object.create(ITERATOR_PROTOTYPE) as Iterator<unknown> & { [Symbol.iterator](): Iterator<unknown> };
  it.next = () => {
    const step = inner.next();
    if (!step.done) counts[category] += 1;
    return step;
  };
  it[Symbol.iterator] = () => it;
  return it;
}

function toStartIndex(value: unknown, length: number): number {
  const n = Math.trunc(Number(value) || 0);
  return n < 0 ? mathMax(length + n, 0) : mathMin(n, length);
}

function buildPatches(): Array<{ target: object; key: PropertyKey; wrap: (original: AnyFn) => AnyFn }> {
  const patches: Array<{ target: object; key: PropertyKey; wrap: (original: AnyFn) => AnyFn }> = [];
  const add = (target: object, key: PropertyKey, wrap: (original: AnyFn) => AnyFn) => {
    patches.push({ target, key, wrap });
  };

  // Callback methods: one element per callback call.
  for (const key of [
    "map", "filter", "forEach", "some", "every", "find", "findIndex", "findLast",
    "findLastIndex", "flatMap", "reduce", "reduceRight",
  ]) {
    add(Array.prototype, key, (original) => function (this: unknown, ...args: unknown[]) {
      const counts = active();
      const callback = args[0];
      if (counts && typeof callback === "function") {
        args[0] = function (this: unknown, ...cbArgs: unknown[]) {
          counts.elements += 1;
          return Reflect.apply(callback as AnyFn, this, cbArgs);
        };
      }
      return Reflect.apply(original, this, args);
    });
  }

  // Scans and copies: charge the elements they touch.
  for (const key of ["indexOf", "lastIndexOf", "includes", "join", "reverse", "fill", "copyWithin", "toReversed"]) {
    add(Array.prototype, key, (original) => function (this: unknown, ...args: unknown[]) {
      const counts = active();
      if (counts) counts.elements += (this as unknown[]).length;
      return Reflect.apply(original, this, args);
    });
  }
  for (const key of ["slice", "concat", "flat"]) {
    add(Array.prototype, key, (original) => function (this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args) as unknown[];
      const counts = active();
      if (counts) counts.elements += result.length;
      return result;
    });
  }
  for (const key of ["shift", "unshift"]) {
    add(Array.prototype, key, (original) => function (this: unknown, ...args: unknown[]) {
      const counts = active();
      if (counts) counts.elements += (this as unknown[]).length + args.length;
      return Reflect.apply(original, this, args);
    });
  }
  for (const key of ["splice", "toSpliced"]) {
    add(Array.prototype, key, (original) => function (this: unknown, ...args: unknown[]) {
      const counts = active();
      if (counts) {
        const length = (this as unknown[]).length;
        counts.elements += length - toStartIndex(args[0], length) + mathMax(0, args.length - 2);
      }
      return Reflect.apply(original, this, args);
    });
  }

  // Sorts: count comparator calls.
  for (const key of ["sort", "toSorted"]) {
    add(Array.prototype, key, (original) => function (this: unknown, ...args: unknown[]) {
      const counts = active();
      const compare = args[0];
      if (counts) {
        if (typeof compare === "function") {
          args[0] = (a: unknown, b: unknown) => {
            counts.compares += 1;
            return (compare as (a: unknown, b: unknown) => number)(a, b);
          };
        } else {
          counts.compares += (this as unknown[]).length;
        }
      }
      return Reflect.apply(original, this, args);
    });
  }

  // Iteration: spread, for-of, destructuring, new Set(array), ...
  const iterate = (target: object, key: PropertyKey, category: OpCategory) => {
    add(target, key, (original) => function (this: unknown, ...args: unknown[]) {
      const inner = Reflect.apply(original, this, args) as Iterator<unknown>;
      const counts = active();
      return counts ? countingIterator(inner, category, counts) : inner;
    });
  };
  for (const key of [Symbol.iterator, "values", "keys", "entries"]) {
    iterate(Array.prototype, key, "elements");
    iterate(Set.prototype, key, "entries");
    iterate(Map.prototype, key, "entries");
  }
  for (const proto of [Set.prototype, Map.prototype]) {
    add(proto, "forEach", (original) => function (this: unknown, ...args: unknown[]) {
      const counts = active();
      if (counts) counts.entries += (this as Set<unknown>).size;
      return Reflect.apply(original, this, args);
    });
  }

  for (const key of ["keys", "values", "entries"]) {
    add(Object, key, (original) => function (this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args) as unknown[];
      const counts = active();
      if (counts) counts.elements += result.length;
      return result;
    });
  }

  for (const key of [
    "toLowerCase", "toUpperCase", "toLocaleLowerCase", "toLocaleUpperCase", "slice", "substring",
    "substr", "startsWith", "endsWith", "includes", "indexOf", "lastIndexOf", "split", "replace",
    "replaceAll", "trim", "trimStart", "trimEnd", "localeCompare", "search", "match", "matchAll",
    "padStart", "padEnd", "concat", "repeat", "normalize", "at", "charAt",
  ]) {
    add(String.prototype, key, (original) => function (this: unknown, ...args: unknown[]) {
      const counts = active();
      if (counts) counts.strings += 1;
      return Reflect.apply(original, this, args);
    });
  }

  for (const key of ["max", "min"]) {
    add(Math, key, (original) => function (this: unknown, ...args: unknown[]) {
      const counts = active();
      if (counts) counts.math += mathMax(1, args.length);
      return Reflect.apply(original, this, args);
    });
  }

  return patches;
}

let installed: Patch[] | null = null;
/** Measurements in flight; the builtins stay patched until the last one ends. */
let activeMeasurements = 0;

function install(): void {
  activeMeasurements += 1;
  if (installed) return;
  const saved: Patch[] = [];
  for (const { target, key, wrap } of buildPatches()) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || typeof descriptor.value !== "function") continue;
    saved.push({ target, key, descriptor });
    Object.defineProperty(target, key, { ...descriptor, value: wrap(descriptor.value as AnyFn) });
  }
  installed = saved;
}

function uninstall(): void {
  activeMeasurements -= 1;
  if (activeMeasurements > 0 || !installed) return;
  for (const { target, key, descriptor } of installed) {
    Object.defineProperty(target, key, descriptor);
  }
  installed = null;
}

/** Run `fn` and count the operations it performs (see the file comment). */
export async function measureOps<T>(fn: () => T | Promise<T>): Promise<{ result: T; ops: OpCounts }> {
  const counts = emptyOpCounts();
  install();
  try {
    const result = await store.run(counts, fn);
    return { result, ops: counts };
  } finally {
    uninstall();
  }
}

/** Synchronous `measureOps`. */
export function measureOpsSync<T>(fn: () => T): { result: T; ops: OpCounts } {
  const counts = emptyOpCounts();
  install();
  try {
    const result = store.run(counts, fn);
    return { result, ops: counts };
  } finally {
    uninstall();
  }
}

const ARRAY_INDEX = /^\d+$/;

/**
 * Count reads of `value` while measuring: array index reads on arrays,
 * and every property read on each element (or on `value` itself when it
 * is not an array). One level deep, which is where per-item loops read.
 */
export function countReads<T extends object>(value: T): T {
  if (Array.isArray(value)) {
    const items = value.map((item) => (item && typeof item === "object" ? countFieldReads(item as object) : item));
    return new Proxy(items, {
      get(target, property, receiver) {
        if (typeof property === "string" && ARRAY_INDEX.test(property)) {
          const counts = active();
          if (counts) counts.reads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as T;
  }
  return countFieldReads(value);
}

function countFieldReads<T extends object>(value: T): T {
  return new Proxy(value, {
    get(target, property, receiver) {
      if (typeof property === "string") {
        const counts = active();
        if (counts) counts.reads += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

export interface ScalingExpectation {
  /** How much larger the large input is (default 8). */
  factor?: number;
  /** Allowed growth over linear, as a multiple (default 2). */
  slack?: number;
  /**
   * Counts at or below this in the small run are treated as this value,
   * so a category that barely registers at N can't fail on noise.
   */
  floor?: number;
  /** Absolute cap on the large run's total. */
  maxTotal?: number;
}

/**
 * Assert every category grew at most `slack × factor` from the small run
 * to the large one (about 2× of linear by default), and that the large
 * run stayed under `maxTotal`.
 */
export function expectNearLinear(
  label: string,
  small: OpCounts,
  large: OpCounts,
  { factor = 8, slack = 2, floor = 64, maxTotal }: ScalingExpectation = {},
): void {
  const limit = factor * slack;
  const over: string[] = [];
  for (const category of CATEGORIES) {
    const base = Math.max(small[category], floor);
    if (large[category] > base * limit) {
      over.push(`${category}: ${small[category]} → ${large[category]} (${(large[category] / base).toFixed(1)}×, limit ${limit}×)`);
    }
  }
  const smallTotal = Math.max(totalOps(small), floor);
  const largeTotal = totalOps(large);
  if (largeTotal > smallTotal * limit) {
    over.push(`total: ${totalOps(small)} → ${largeTotal} (${(largeTotal / smallTotal).toFixed(1)}×, limit ${limit}×)`);
  }
  if (maxTotal !== undefined && largeTotal > maxTotal) {
    over.push(`total ${largeTotal} is over the cap of ${maxTotal}`);
  }
  if (process.env.SCALING_REPORT === "1") {
    process.stdout.write(`${JSON.stringify({ label, small, large, growth: largeTotal / smallTotal, maxTotal })}\n`);
  }
  expect(over, `${label} grew faster than linear\nsmall: ${JSON.stringify(small)}\nlarge: ${JSON.stringify(large)}`).toEqual([]);
}
