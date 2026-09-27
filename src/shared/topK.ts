/**
 * Binary heap. `before(a, b)` is true when `a` should come out first.
 * push, pop and replaceTop are O(log n); peek is O(1).
 */
export class BinaryHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly before: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    this.items.push(item);
    this.siftUp(this.items.length - 1);
  }

  pop(): T | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /** Pop the top and push `item` in one sift. The heap must not be empty. */
  replaceTop(item: T): T {
    const top = this.items[0]!;
    this.items[0] = item;
    this.siftDown(0);
    return top;
  }

  /** The items in heap order (not sorted). */
  toArray(): T[] {
    return this.items.slice();
  }

  private siftUp(index: number): void {
    const items = this.items;
    const item = items[index]!;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.before(item, items[parent]!)) break;
      items[index] = items[parent]!;
      index = parent;
    }
    items[index] = item;
  }

  private siftDown(index: number): void {
    const items = this.items;
    const length = items.length;
    const item = items[index]!;
    while (true) {
      let child = 2 * index + 1;
      if (child >= length) break;
      if (child + 1 < length && this.before(items[child + 1]!, items[child]!)) child += 1;
      if (!this.before(items[child]!, item)) break;
      items[index] = items[child]!;
      index = child;
    }
    items[index] = item;
  }
}

interface Ranked<T> {
  item: T;
  seq: number;
}

/**
 * The first `limit` items of a stable sort by `compare`, kept while items
 * stream past: `offer` is O(log limit), and O(1) for an item that sorts
 * after everything kept once the list is full.
 *
 * `compare` is the comparator you'd pass to `Array#sort`. The result is
 * what sorting every offered item and cutting to `limit` would give,
 * ties included: among equal items the earlier offer wins and comes
 * first.
 *
 * Replaces "replace the smallest, then re-sort the whole list", which is
 * O(limit) per accepted item and O(n × limit) on input that arrives in
 * ascending order.
 */
export class TopK<T> {
  private readonly heap: BinaryHeap<Ranked<T>>;
  private offered = 0;
  readonly limit: number;

  constructor(limit: number, private readonly compare: (a: T, b: T) => number) {
    // NaN and negative limits keep nothing.
    const floored = Math.floor(limit);
    this.limit = floored > 0 ? floored : 0;
    // Root = the kept item that sorts last (the first to be evicted).
    this.heap = new BinaryHeap<Ranked<T>>((a, b) => {
      const order = compare(a.item, b.item);
      return order > 0 || (order === 0 && a.seq > b.seq);
    });
  }

  get size(): number {
    return this.heap.size;
  }

  /**
   * Once full, the kept item that sorts last: anything that doesn't sort
   * before it is rejected. Undefined while there is room, when any item
   * is kept. Lets callers skip building an item that can't get in.
   */
  get lowest(): T | undefined {
    return this.heap.size >= this.limit ? this.heap.peek()?.item : undefined;
  }

  /** Offer `item`; true when it was kept. */
  offer(item: T): boolean {
    if (this.limit === 0) return false;
    const seq = this.offered++;
    if (this.heap.size < this.limit) {
      this.heap.push({ item, seq });
      return true;
    }
    // A later offer never beats an equal item already kept.
    if (this.compare(item, this.heap.peek()!.item) >= 0) return false;
    this.heap.replaceTop({ item, seq });
    return true;
  }

  /** Kept items in `compare` order. */
  sorted(): T[] {
    return this.heap
      .toArray()
      .sort((a, b) => this.compare(a.item, b.item) || a.seq - b.seq)
      .map((ranked) => ranked.item);
  }
}
