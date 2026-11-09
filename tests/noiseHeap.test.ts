import { describe, expect, it } from 'vitest';
import { MinHeap } from '../src/core/heap';
import { Noise3 } from '../src/core/noise';
import { rng } from '../src/core/rng';

describe('Noise3', () => {
  it('is deterministic per stream and differs between streams', () => {
    const a = new Noise3(rng(5, 'n'));
    const b = new Noise3(rng(5, 'n'));
    const c = new Noise3(rng(5, 'm'));
    const pts = [0.3, 1.7, -2.2, 5.5, 0.01, 9.9];
    for (const p of pts) {
      expect(a.noise(p, p * 0.7, -p)).toBe(b.noise(p, p * 0.7, -p));
    }
    expect(pts.some((p) => a.fbm(p, p, p) !== c.fbm(p, p, p))).toBe(true);
  });

  it('stays in range and is continuous', () => {
    const n = new Noise3(rng(1, 'n'));
    const r = rng(1, 'pts');
    for (let i = 0; i < 5000; i++) {
      const x = r.range(-50, 50);
      const y = r.range(-50, 50);
      const z = r.range(-50, 50);
      const v = n.noise(x, y, z);
      expect(Math.abs(v)).toBeLessThanOrEqual(1.1);
      expect(Math.abs(n.noise(x + 1e-4, y, z) - v)).toBeLessThan(1e-3);
      const f = n.fbm(x, y, z);
      expect(Math.abs(f)).toBeLessThanOrEqual(1.1);
      const g = n.ridged(x, y, z);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
    }
  });
});

describe('MinHeap', () => {
  it('pops in key order with id tie-breaking', () => {
    const h = new MinHeap(2);
    const r = rng(1, 'heap');
    const items: [number, number][] = [];
    for (let i = 0; i < 1000; i++) {
      const k = r.int(50); // many ties
      items.push([k, i]);
      h.push(k, i);
    }
    items.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [k, id] of items) {
      expect(h.pop()).toBe(id);
      expect(h.lastKey).toBe(k);
    }
    expect(h.size).toBe(0);
  });
});
