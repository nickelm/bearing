import { describe, expect, it } from 'vitest';
import { Rng, SplitMix64, Xoshiro128ss, hashString64, normalizeSeed, rng } from '../src/core/rng';

function take(r: Rng, n: number): number[] {
  return Array.from({ length: n }, () => r.nextUint32());
}

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return cov / Math.sqrt(va * vb);
}

describe('reference generators', () => {
  it('SplitMix64 matches the reference output for seed 0', () => {
    const sm = new SplitMix64(0n);
    expect(sm.next()).toBe(0xe220a8397b1dcdafn);
    expect(sm.next()).toBe(0x6e789e6aa1b965f4n);
    expect(sm.next()).toBe(0x06c45d188009454fn);
  });

  it('xoshiro128** matches the reference output for state [1, 2, 3, 4]', () => {
    const x = new Xoshiro128ss(1, 2, 3, 4);
    expect([x.next(), x.next(), x.next()]).toEqual([11520, 0, 5927040]);
  });

  it('FNV-1a 64 matches the reference hashes', () => {
    expect(hashString64('')).toBe(0xcbf29ce484222325n);
    expect(hashString64('a')).toBe(0xaf63dc4c8601ec8cn);
  });
});

describe('rng streams', () => {
  it('gives the same sequence for the same seed and name', () => {
    expect(take(rng(42, 'plates'), 10_000)).toEqual(take(rng(42, 'plates'), 10_000));
  });

  it('gives different sequences for different seeds', () => {
    expect(take(rng(42, 'plates'), 16)).not.toEqual(take(rng(43, 'plates'), 16));
  });

  it('gives independent sequences for different stream names', () => {
    const a = take(rng(42, 'plates'), 1000);
    const b = take(rng(42, 'rivers'), 1000);
    const shared = a.filter((x) => new Set(b).has(x));
    expect(shared.length).toBe(0);
    expect(Math.abs(correlation(a, b))).toBeLessThan(0.1);
  });

  it('is unaffected by other streams being created or consumed', () => {
    const riversAlone = take(rng(7, 'rivers'), 100);

    const plates = rng(7, 'plates');
    take(plates, 1000);
    const riversAfter = take(rng(7, 'rivers'), 100);

    const riversFirst = rng(7, 'rivers');
    rng(7, 'climate');
    expect(riversAfter).toEqual(riversAlone);
    expect(take(riversFirst, 100)).toEqual(riversAlone);
  });

  it('forks deterministically, independent of the parent position', () => {
    const p1 = rng(9, 'plates');
    const p2 = rng(9, 'plates');
    take(p2, 500);
    const f1 = take(p1.fork('retry-3'), 100);
    const f2 = take(p2.fork('retry-3'), 100);
    expect(f1).toEqual(f2);
    expect(f1).toEqual(take(rng(9, 'plates/retry-3'), 100));
    expect(f1).not.toEqual(take(rng(9, 'plates'), 100));
    expect(take(p1.fork('retry-4'), 100)).not.toEqual(f1);
  });

  it('produces floats in [0, 1) with mean near 0.5', () => {
    const r = rng(1, 'floats');
    let sum = 0;
    for (let i = 0; i < 100_000; i++) {
      const x = r.nextFloat();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      sum += x;
    }
    expect(sum / 100_000).toBeCloseTo(0.5, 2);
  });

  it('produces integers in range covering every bucket', () => {
    const r = rng(1, 'ints');
    const counts = new Array<number>(7).fill(0);
    for (let i = 0; i < 70_000; i++) {
      const k = r.int(7);
      expect(Number.isInteger(k)).toBe(true);
      counts[k]!++;
    }
    for (const c of counts) expect(c).toBeGreaterThan(9000);
    expect(() => r.int(0)).toThrow(RangeError);
    expect(r.int(1)).toBe(0);
  });

  it('respects range() bounds', () => {
    const r = rng(1, 'range');
    for (let i = 0; i < 1000; i++) {
      const x = r.range(-5, 3);
      expect(x).toBeGreaterThanOrEqual(-5);
      expect(x).toBeLessThan(3);
    }
  });
});

describe('seed normalization', () => {
  it('treats numeric strings and numbers as the same seed', () => {
    expect(normalizeSeed('12345')).toBe(12345n);
    expect(normalizeSeed(12345)).toBe(12345n);
    expect(normalizeSeed(' 12345 ')).toBe(12345n);
    expect(take(rng('12345', 'x'), 8)).toEqual(take(rng(12345, 'x'), 8));
  });

  it('hashes non-numeric strings', () => {
    expect(normalizeSeed('Fulda')).toBe(hashString64('Fulda'));
    expect(normalizeSeed('Fulda')).not.toBe(normalizeSeed('fulda'));
  });

  it('wraps negative integers and rejects non-integers', () => {
    expect(normalizeSeed(-1)).toBe(0xffffffffffffffffn);
    expect(() => normalizeSeed(1.5)).toThrow(RangeError);
  });
});
