/**
 * Tile residency (decision 13): an LRU cache with a byte budget, a request
 * queue that the renderer refills every frame with screen-space-error
 * priorities, and a loader that keeps one generation batch in flight.
 *
 * Pure TypeScript with no Three.js, so it can be tested. The renderer stores
 * GPU textures plus the CPU TileData in each entry and frees textures in
 * `onEvict`.
 */
import { parentTile, tileKeyString } from '../../../core/tiles';
import type { TileKey } from '../../../core/tiles';

export interface CacheEntry<T> {
  readonly key: string;
  readonly tile: TileKey;
  readonly value: T;
  readonly bytes: number;
  lastUsed: number;
}

export class TileCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private frame = 0;
  private total = 0;

  constructor(
    public budgetBytes: number,
    private readonly onEvict: (e: CacheEntry<T>) => void = () => {},
  ) {}

  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Starts a frame: entries used from now on are protected from eviction until the next frame. */
  beginFrame(): void {
    this.frame++;
  }

  has(tile: TileKey): boolean {
    return this.entries.has(tileKeyString(tile));
  }

  /** The tile's value, without marking it used. */
  peek(tile: TileKey): T | undefined {
    return this.entries.get(tileKeyString(tile))?.value;
  }

  /** The tile's value, marking it used this frame. */
  get(tile: TileKey): T | undefined {
    const e = this.entries.get(tileKeyString(tile));
    if (!e) return undefined;
    e.lastUsed = this.frame;
    return e.value;
  }

  /** The tile, or its nearest cached ancestor, marking it used. */
  getOrAncestor(tile: TileKey): CacheEntry<T> | undefined {
    for (let t: TileKey | null = tile; t; t = parentTile(t)) {
      const e = this.entries.get(tileKeyString(t));
      if (e) {
        e.lastUsed = this.frame;
        return e;
      }
    }
    return undefined;
  }

  set(tile: TileKey, value: T, bytes: number): void {
    const key = tileKeyString(tile);
    const old = this.entries.get(key);
    if (old) {
      this.total -= old.bytes;
      this.onEvict(old);
    }
    this.entries.set(key, { key, tile, value, bytes, lastUsed: this.frame });
    this.total += bytes;
  }

  /**
   * Evicts least-recently-used entries until the cache fits its budget.
   * Entries used in the current frame, and `keep` tiles, are never evicted,
   * so the cache can exceed its budget when one frame needs more.
   */
  evict(keep: (tile: TileKey) => boolean = () => false): number {
    if (this.total <= this.budgetBytes) return 0;
    const victims = [...this.entries.values()]
      .filter((e) => e.lastUsed < this.frame && !keep(e.tile))
      .sort(
        (a, b) =>
          a.lastUsed - b.lastUsed || a.tile.level - b.tile.level || (a.key < b.key ? 1 : -1),
      );
    let n = 0;
    for (const e of victims) {
      if (this.total <= this.budgetBytes) break;
      this.entries.delete(e.key);
      this.total -= e.bytes;
      this.onEvict(e);
      n++;
    }
    return n;
  }

  values(): IterableIterator<CacheEntry<T>> {
    return this.entries.values();
  }

  clear(): void {
    for (const e of this.entries.values()) this.onEvict(e);
    this.entries.clear();
    this.total = 0;
  }
}

/**
 * Missing tiles wanted this frame, by priority (higher first). Requests not
 * renewed in a frame lapse, so the queue always reflects the current view.
 */
export class TileRequestQueue {
  private next = new Map<string, { tile: TileKey; priority: number }>();

  /** Starts a frame's requests; requests from earlier frames lapse. */
  beginFrame(): void {
    this.next = new Map();
  }

  request(tile: TileKey, priority: number): void {
    const key = tileKeyString(tile);
    const r = this.next.get(key);
    if (!r || priority > r.priority) this.next.set(key, { tile, priority });
  }

  get size(): number {
    return this.next.size;
  }

  /**
   * Takes up to `n` of the current frame's requests, highest priority first,
   * skipping any for which `skip` is true (cached or in flight).
   */
  take(n: number, skip: (tile: TileKey) => boolean): TileKey[] {
    const list = [...this.next.values()]
      .filter((r) => !skip(r.tile))
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.tile.level - b.tile.level ||
          (tileKeyString(a.tile) < tileKeyString(b.tile) ? -1 : 1),
      );
    const out = list.slice(0, n).map((r) => r.tile);
    for (const t of out) this.next.delete(tileKeyString(t));
    return out;
  }
}

export interface LoadedTile<T> {
  tile: TileKey;
  value: T;
  bytes: number;
}

/** Generates requested tiles in batches, one batch in flight at a time. */
export class TileLoader<T> {
  private inFlight = new Set<string>();
  private busy = false;
  /** Tiles generated so far. */
  generated = 0;

  constructor(
    private readonly cache: TileCache<T>,
    private readonly queue: TileRequestQueue,
    private readonly generate: (tiles: TileKey[]) => Promise<LoadedTile<T>[]>,
    public batchSize = 8,
  ) {}

  get pending(): number {
    return this.inFlight.size;
  }

  /** Starts the next batch if none is running. Call once per frame after the requests. */
  update(): Promise<void> | null {
    if (this.busy) return null;
    const tiles = this.queue.take(
      this.batchSize,
      (t) => this.cache.has(t) || this.inFlight.has(tileKeyString(t)),
    );
    if (tiles.length === 0) return null;
    this.busy = true;
    for (const t of tiles) this.inFlight.add(tileKeyString(t));
    return this.generate(tiles)
      .then((loaded) => {
        for (const l of loaded) {
          this.cache.set(l.tile, l.value, l.bytes);
          this.generated++;
        }
      })
      .finally(() => {
        for (const t of tiles) this.inFlight.delete(tileKeyString(t));
        this.busy = false;
      });
  }
}
