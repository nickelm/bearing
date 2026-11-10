import { describe, expect, it } from 'vitest';
import { childTiles, tileKey } from '../src/core/tiles';
import type { TileKey } from '../src/core/tiles';
import { TileCache, TileLoader, TileRequestQueue } from '../src/render/terrain/tileCache';

const t = (level: number, x: number, y = 0): TileKey => tileKey(0, level, x, y);

describe('TileCache', () => {
  it('evicts least recently used tiles down to the budget, never ones used this frame', () => {
    const evicted: string[] = [];
    const c = new TileCache<number>(300, (e) => evicted.push(e.key));
    c.beginFrame();
    c.set(t(3, 0), 0, 100);
    c.set(t(3, 1), 1, 100);
    c.beginFrame();
    c.set(t(3, 2), 2, 100);
    c.get(t(3, 0));
    c.beginFrame();
    c.get(t(3, 2));
    c.set(t(3, 3), 3, 100);
    expect(c.bytes).toBe(400);
    expect(c.evict()).toBe(1);
    expect(evicted).toEqual(['0/3/1/0']);
    expect(c.bytes).toBe(300);
    // Everything left was used recently; a tighter budget evicts the oldest first.
    c.budgetBytes = 0;
    c.evict();
    expect(evicted).toEqual(['0/3/1/0', '0/3/0/0']);
    expect(c.has(t(3, 2)) && c.has(t(3, 3))).toBe(true);
  });

  it('falls back to the nearest cached ancestor', () => {
    const c = new TileCache<string>(1e9);
    const root = t(2, 1, 1);
    c.set(root, 'root', 1);
    const grandchild = childTiles(childTiles(root)[3]!)[0]!;
    expect(c.getOrAncestor(grandchild)?.value).toBe('root');
    expect(c.getOrAncestor(t(2, 0, 0))).toBeUndefined();
  });
});

describe('TileRequestQueue and TileLoader', () => {
  it('serves the highest-priority current requests and lets stale ones lapse', () => {
    const q = new TileRequestQueue();
    q.beginFrame();
    q.request(t(4, 1), 1);
    q.request(t(4, 2), 5);
    q.request(t(4, 1), 3); // raises priority
    expect(q.take(1, () => false)).toEqual([t(4, 2)]);
    q.beginFrame(); // nothing renewed
    expect(q.take(5, () => false)).toEqual([]);
  });

  it('generates in batches, skips cached tiles, and fills the cache', async () => {
    const cache = new TileCache<string>(1e9);
    const q = new TileRequestQueue();
    const batches: string[][] = [];
    const loader = new TileLoader<string>(
      cache,
      q,
      async (tiles) => {
        batches.push(tiles.map((x) => `${x.level}/${x.x}`));
        return tiles.map((tile) => ({ tile, value: `v${tile.x}`, bytes: 10 }));
      },
      2,
    );
    cache.set(t(5, 0), 'cached', 10);
    q.beginFrame();
    for (let x = 0; x < 4; x++) q.request(t(5, x), 10 - x);
    const first = loader.update();
    expect(loader.update()).toBeNull(); // one batch at a time
    await first;
    expect(batches).toEqual([['5/1', '5/2']]);
    await loader.update();
    expect(batches[1]).toEqual(['5/3']);
    expect(cache.get(t(5, 3))).toBe('v3');
    expect(loader.generated).toBe(3);
  });
});
