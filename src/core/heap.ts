/**
 * Binary min-heap of (priority, id) pairs on typed arrays, for Dijkstra-style
 * flood fills over the cell grid.
 *
 * Ties are broken by the smaller id, so pop order (and everything built on
 * it) is deterministic.
 */
export class MinHeap {
  private keys: Float64Array;
  private ids: Int32Array;
  private count = 0;

  constructor(initialCapacity = 1024) {
    this.keys = new Float64Array(initialCapacity);
    this.ids = new Int32Array(initialCapacity);
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.count = 0;
  }

  push(key: number, id: number): void {
    if (this.count === this.keys.length) this.grow();
    let i = this.count++;
    const keys = this.keys;
    const ids = this.ids;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!less(key, id, keys[parent], ids[parent])) break;
      keys[i] = keys[parent];
      ids[i] = ids[parent];
      i = parent;
    }
    keys[i] = key;
    ids[i] = id;
  }

  /** Priority of the minimum element. Undefined behavior on an empty heap. */
  peekKey(): number {
    return this.keys[0];
  }

  /** Removes the minimum element and returns its id. The key is available via `lastKey`. */
  pop(): number {
    const keys = this.keys;
    const ids = this.ids;
    const topId = ids[0];
    this.lastKey = keys[0];
    const n = --this.count;
    if (n > 0) {
      const key = keys[n];
      const id = ids[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && less(keys[r], ids[r], keys[l], ids[l]) ? r : l;
        if (!less(keys[c], ids[c], key, id)) break;
        keys[i] = keys[c];
        ids[i] = ids[c];
        i = c;
      }
      keys[i] = key;
      ids[i] = id;
    }
    return topId;
  }

  /** Key of the element most recently returned by `pop()`. */
  lastKey = 0;

  private grow(): void {
    const keys = new Float64Array(this.keys.length * 2);
    const ids = new Int32Array(this.ids.length * 2);
    keys.set(this.keys);
    ids.set(this.ids);
    this.keys = keys;
    this.ids = ids;
  }
}

function less(ka: number, ia: number, kb: number, ib: number): boolean {
  return ka < kb || (ka === kb && ia < ib);
}
