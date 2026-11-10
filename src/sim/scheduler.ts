/**
 * Discrete-event queue (decision 67).
 *
 * Entries pop in order of (time, priority, sequence number). The sequence
 * number counts insertions, so two entries with the same time and priority
 * pop in the order they were scheduled. Nothing depends on object identity or
 * on how far a caller advances at once, so the order is the same at any time
 * acceleration.
 */
import type { GameTime } from '../core/units';

export interface QueueEntry<T> {
  readonly time: GameTime;
  /** Lower pops first among entries at the same time. */
  readonly priority: number;
  /** Insertion counter: the final tie-breaker. */
  readonly seq: number;
  readonly item: T;
}

function before<T>(a: QueueEntry<T>, b: QueueEntry<T>): boolean {
  if (a.time !== b.time) return a.time < b.time;
  if (a.priority !== b.priority) return a.priority < b.priority;
  return a.seq < b.seq;
}

/** Binary min-heap of queue entries with deterministic tie-breaking and lazy cancellation. */
export class EventQueue<T> {
  private heap: QueueEntry<T>[] = [];
  private nextSeq = 0;
  private readonly cancelled = new Set<number>();

  /** Entries scheduled so far (also the next sequence number). */
  get scheduledCount(): number {
    return this.nextSeq;
  }

  /** Live entries (scheduled and not yet popped or cancelled). */
  get size(): number {
    return this.heap.length - this.cancelled.size;
  }

  /** Schedules an item and returns its sequence number, which `cancel` takes. */
  push(time: GameTime, priority: number, item: T): number {
    if (!Number.isFinite(time)) throw new RangeError(`Event time must be finite, got ${time}`);
    const entry: QueueEntry<T> = { time, priority, seq: this.nextSeq++, item };
    const h = this.heap;
    let i = h.length;
    h.push(entry);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(entry, h[parent]!)) break;
      h[i] = h[parent]!;
      i = parent;
    }
    h[i] = entry;
    return entry.seq;
  }

  /** Cancels a scheduled entry; it is skipped when it reaches the top. */
  cancel(seq: number): void {
    if (this.heap.some((e) => e.seq === seq)) this.cancelled.add(seq);
  }

  /** The next live entry without removing it, or undefined. */
  peek(): QueueEntry<T> | undefined {
    this.dropCancelled();
    return this.heap[0];
  }

  /** Removes and returns the next live entry, or undefined. */
  pop(): QueueEntry<T> | undefined {
    this.dropCancelled();
    return this.popRaw();
  }

  /** Live entries in pop order (for hashing and snapshots; O(n log n)). */
  entries(): QueueEntry<T>[] {
    return this.heap
      .filter((e) => !this.cancelled.has(e.seq))
      .sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
  }

  private dropCancelled(): void {
    while (this.heap.length > 0 && this.cancelled.has(this.heap[0]!.seq)) {
      this.cancelled.delete(this.heap[0]!.seq);
      this.popRaw();
    }
  }

  private popRaw(): QueueEntry<T> | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0 && last) {
      let i = 0;
      const n = h.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && before(h[r]!, h[l]!) ? r : l;
        if (!before(h[c]!, last)) break;
        h[i] = h[c]!;
        i = c;
      }
      h[i] = last;
    }
    return top;
  }
}
