import { describe, expect, it } from 'vitest';
import { DEG } from '../src/core/units';
import { decodeRunway, encodeRunway, TAXIWAY_OFFSET } from '../src/render/sim/infra/infraScene';
import {
  CENTERLINE,
  DIGIT_HEIGHT,
  DIGIT_U,
  DIGIT_V,
  markingAt,
  runwayNumbers,
  SIDE_STRIPE,
} from '../src/render/sim/infra/runwayMarkings';

describe('runway designations', () => {
  it('numbers each end by its landing heading in tens of degrees', () => {
    expect(runwayNumbers(0)).toEqual([36, 18]);
    expect(runwayNumbers(90 * DEG)).toEqual([9, 27]);
    expect(runwayNumbers(87 * DEG)).toEqual([9, 27]);
    expect(runwayNumbers(176 * DEG)).toEqual([18, 36]);
    expect(runwayNumbers(62 * DEG)).toEqual([6, 24]);
    expect(runwayNumbers(4 * DEG)).toEqual([36, 18]);
  });

  it('packs length and heading into one float32', () => {
    const f = new Float32Array(1);
    for (const [L, h] of [
      [2400, 1.2],
      [3200.4, 3.1],
      [2000, 0],
      [3000, Math.PI + 0.5],
    ] as const) {
      f[0] = encodeRunway(L, h);
      const r = decodeRunway(f[0]);
      expect(r.length).toBe(Math.round(L));
      expect(Math.abs(r.heading - (h % Math.PI))).toBeLessThan(1e-3);
    }
  });
});

describe('runway and taxiway paint', () => {
  const L = 3000;
  const h = 87 * DEG; // runway 09/27
  const at = (along: number, across: number) => markingAt(along, across, L, h);
  /** From the reading frame of the end at −L/2 (designation 09). */
  const west = (u: number, v: number) => at(-L / 2 + u, v);
  /** And of the end at +L/2 (27), where the pilot's right is the runway's left. */
  const east = (u: number, v: number) => at(L / 2 - u, -v);

  it('paints threshold bars with a gap at the centerline', () => {
    expect(west(20, 3.9)).toBe('white');
    expect(west(20, -3.9)).toBe('white');
    expect(west(20, 5.7)).toBeNull(); // between bars
    expect(west(20, 0)).toBeNull();
    expect(east(20, 18.3)).toBe('white');
    expect(west(3, 3.9)).toBeNull(); // before the bars
  });

  it('writes the designation in seven-segment figures', () => {
    const mid = DIGIT_U + DIGIT_HEIGHT / 2;
    // 09: the 0 has no middle bar, the 9 has.
    expect(west(mid, -DIGIT_V)).toBeNull();
    expect(west(mid, DIGIT_V)).toBe('white');
    // Both have a top bar.
    expect(west(DIGIT_U + DIGIT_HEIGHT - 0.5, -DIGIT_V)).toBe('white');
    expect(west(DIGIT_U + DIGIT_HEIGHT - 0.5, DIGIT_V)).toBe('white');
    // 27: the 2 has a middle bar, the 7 has none, nor a bottom bar.
    expect(east(mid, -DIGIT_V)).toBe('white');
    expect(east(mid, DIGIT_V)).toBeNull();
    expect(east(DIGIT_U + 0.5, DIGIT_V)).toBeNull();
    expect(east(DIGIT_U + 0.5, -DIGIT_V)).toBe('white');
  });

  it('draws touchdown-zone bars from 150 m to 900 m past each threshold', () => {
    // The end at along = −L/2 reads u from −1500 inward; three bars at 150 m, one at 900 m.
    expect(at(-L / 2 + 160, 6.9)).toBe('white');
    expect(at(-L / 2 + 160, 10.2)).toBe('white');
    expect(at(-L / 2 + 160, 13.5)).toBe('white');
    expect(at(-L / 2 + 160, 8.5)).toBeNull();
    expect(at(-L / 2 + 910, 6.9)).toBe('white');
    expect(at(-L / 2 + 910, 10.2)).toBeNull();
    expect(at(L / 2 - 460, -6.9)).toBe('white');
    // Nothing between the zones' rows.
    expect(at(-L / 2 + 200, 6.9)).toBeNull();
  });

  it('draws aiming points, side stripes and centerline dashes', () => {
    expect(west(320, 10)).toBe('white');
    expect(east(320, -10)).toBe('white');
    expect(at(0, (SIDE_STRIPE[0] + SIDE_STRIPE[1]) / 2)).toBe('white');
    expect(at(0, -(SIDE_STRIPE[0] + SIDE_STRIPE[1]) / 2)).toBe('white');
    let dash = 0;
    let gap = 0;
    for (let a = -L / 2 + CENTERLINE.clear + 1; a < L / 2 - CENTERLINE.clear; a += 1) {
      if (at(a, 0) === 'white') dash++;
      else gap++;
    }
    expect(dash / (dash + gap)).toBeCloseTo(CENTERLINE.dash / CENTERLINE.period, 1);
    expect(west(CENTERLINE.clear - 5, 0)).toBeNull();
  });

  it('marks the taxiway in yellow and leaves the grass bare', () => {
    expect(at(0, TAXIWAY_OFFSET)).toBe('yellow');
    expect(at(L / 2 - 150, 100)).toBe('yellow'); // link to the runway end
    expect(at(200, 300)).toBe('yellow'); // link to the apron
    expect(at(0, 100)).toBeNull();
    expect(at(L / 2 + 50, 0)).toBeNull();
  });
});
