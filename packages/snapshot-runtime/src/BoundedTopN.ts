/**
 * The N executions with the largest LATEST value, in O(N) memory, however many executions are
 * offered.
 *
 * Structure: a binary MIN-heap of size at most N (the smallest retained value sits at the root)
 * plus a `Map<key, heapIndex>`. Why this and not the alternatives:
 *
 * - A sorted array makes every offer O(N); a plain `Map` of every execution is the unbounded
 *   per-execution leak this repo has had before.
 * - The heap root is exactly the eviction candidate, so "does this newcomer beat the current
 *   N-th largest?" is one comparison (O(1)) and replacing it is O(log N).
 * - Because the value is the LATEST size, an execution already retained must be UPDATED in place
 *   (it can grow or shrink). A bare heap cannot find an element; the index makes that O(1) and
 *   the sift that follows O(log N). `remove` (a deleted or pruned execution) is the same
 *   swap-with-last + sift, O(log N). The index never holds a key the heap does not (both are
 *   updated in the same place), so it is bounded by N too.
 *
 * Known approximation, by design: an execution that was evicted (it was among the smallest of N)
 * is forgotten, and is re-admitted only by a later offer that beats the root. Nothing else about
 * it is kept (that would be the unbounded map).
 */
export class BoundedTopN {
  private readonly keys: string[] = [];
  private readonly values: number[] = [];
  private readonly meta: number[] = [];
  private readonly index = new Map<string, number>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.keys.length;
  }

  /** Offer `key`'s latest value (`meta` rides along, e.g. the snapshot sequence). */
  offer(key: string, value: number, meta: number): void {
    const at = this.index.get(key);
    if (at !== undefined) {
      const old = this.values[at]!;
      this.values[at] = value;
      this.meta[at] = meta;
      if (value > old) this.siftDown(at);
      else if (value < old) this.siftUp(at);
      return;
    }
    if (this.capacity <= 0) return;
    if (this.keys.length < this.capacity) {
      this.keys.push(key);
      this.values.push(value);
      this.meta.push(meta);
      this.index.set(key, this.keys.length - 1);
      this.siftUp(this.keys.length - 1);
      return;
    }
    if (value <= this.values[0]!) return; // not larger than the N-th largest: not a top-N entry
    this.index.delete(this.keys[0]!);
    this.keys[0] = key;
    this.values[0] = value;
    this.meta[0] = meta;
    this.index.set(key, 0);
    this.siftDown(0);
  }

  remove(key: string): boolean {
    const at = this.index.get(key);
    if (at === undefined) return false;
    const last = this.keys.length - 1;
    this.index.delete(key);
    if (at === last) {
      this.keys.pop();
      this.values.pop();
      this.meta.pop();
      return true;
    }
    this.keys[at] = this.keys[last]!;
    this.values[at] = this.values[last]!;
    this.meta[at] = this.meta[last]!;
    this.keys.pop();
    this.values.pop();
    this.meta.pop();
    this.index.set(this.keys[at]!, at);
    this.siftUp(at);
    this.siftDown(this.index.get(this.keys[at]!)!);
    return true;
  }

  clear(): void {
    this.keys.length = 0;
    this.values.length = 0;
    this.meta.length = 0;
    this.index.clear();
  }

  /** Largest first. O(N log N), called by a reader, never on the save path. */
  entries(): { key: string; value: number; meta: number }[] {
    return this.keys
      .map((key, i) => ({ key, value: this.values[i]!, meta: this.meta[i]! }))
      .sort((a, b) => b.value - a.value);
  }

  /** Heap invariant + index consistency, for tests. */
  check(): boolean {
    if (this.index.size !== this.keys.length) return false;
    for (let i = 0; i < this.keys.length; i++) {
      if (this.index.get(this.keys[i]!) !== i) return false;
      if (i > 0 && this.values[(i - 1) >> 1]! > this.values[i]!) return false;
    }
    return this.keys.length <= this.capacity;
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a]!;
    const v = this.values[a]!;
    const m = this.meta[a]!;
    this.keys[a] = this.keys[b]!;
    this.values[a] = this.values[b]!;
    this.meta[a] = this.meta[b]!;
    this.keys[b] = k;
    this.values[b] = v;
    this.meta[b] = m;
    this.index.set(this.keys[a]!, a);
    this.index.set(this.keys[b]!, b);
  }

  private siftUp(from: number): void {
    let i = from;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.values[parent]! <= this.values[i]!) return;
      this.swap(parent, i);
      i = parent;
    }
  }

  private siftDown(from: number): void {
    let i = from;
    const n = this.keys.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = i;
      if (l < n && this.values[l]! < this.values[smallest]!) smallest = l;
      if (r < n && this.values[r]! < this.values[smallest]!) smallest = r;
      if (smallest === i) return;
      this.swap(i, smallest);
      i = smallest;
    }
  }
}
