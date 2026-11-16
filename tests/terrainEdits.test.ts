/**
 * The terrain edit framework (decision 161, rule 13): corridor and pad edits,
 * their composition order, the tile restriction, and protected river channels.
 */
import { describe, expect, it } from 'vitest';
import { cubeFaceUvToDirection } from '../src/core/coords';
import { childTiles, parentTile, tileForDirection, tileKey } from '../src/core/tiles';
import { DEG, PLANET_RADIUS } from '../src/core/units';
import type { Vec3d } from '../src/core/vec3d';
import { offsetPoint } from '../src/render/sim/infra/infraScene';
import {
  CHANNEL_PROTECTION,
  CORRIDOR_BANKS,
  CORRIDOR_MIN_LEVEL,
  TerrainEdits,
} from '../src/worldgen/edits';
import type { ChannelSource, CorridorEdit, PadEdit } from '../src/worldgen/edits';
import { NO_SURFACE, RIVER_SEGMENT_FIELDS } from '../src/worldgen/riverIndex';

const R = PLANET_RADIUS;
const CENTER = cubeFaceUvToDirection(4, 0.53, 0.47);
/** A point `along` m north and `across` m east of CENTER. */
const at = (along: number, across: number) => offsetPoint(CENTER, 0, along, across, R);

/** A straight corridor from 6 km south to 6 km north of CENTER, its design elevation linear in `along`. */
function corridor(
  z: (along: number) => number,
  over: Partial<CorridorEdit> = {},
  heading = 0,
  step = 3000,
): CorridorEdit {
  const pts: number[] = [];
  const el: number[] = [];
  for (let a = -6000; a <= 6000; a += step) {
    const p = offsetPoint(CENTER, heading, a, 0, R);
    pts.push(p.x, p.y, p.z);
    el.push(z(a));
  }
  return {
    points: Float64Array.from(pts),
    elevation: Float64Array.from(el),
    halfWidth: 5,
    ...CORRIDOR_BANKS,
    reach: 60,
    priority: 0,
    ...over,
  };
}

describe('corridor edits', () => {
  const fill = new TerrainEdits({ radius: R, corridors: [corridor(() => 110)] });

  it('sets the formation to the design elevation', () => {
    for (const across of [0, 2, -4.9]) expect(fill.apply(at(500, across), 100)).toBeCloseTo(110, 6);
    expect(fill.apply(at(0, 3), 140)).toBeCloseTo(110, 6);
  });

  it('interpolates the design elevation along the centerline, across split segments', () => {
    // Points 3 km apart are split into 500 m segments; the elevation stays linear.
    const e = new TerrainEdits({ radius: R, corridors: [corridor((a) => 200 + a / 100)] });
    for (const a of [-5500, -1234, 0, 777, 4999]) {
      expect(e.apply(at(a, 1), 150)).toBeCloseTo(200 + a / 100, 3);
    }
  });

  it('falls to the ground at 1 : 1.5 from a fill and rises to it at 1 : 1 from a cut', () => {
    // Fill: 10 m above flat ground at 100 m.
    expect(fill.apply(at(0, 5 + 3), 100)).toBeCloseTo(110 - 3 / 1.5, 4);
    expect(fill.apply(at(0, -(5 + 9)), 100)).toBeCloseTo(110 - 9 / 1.5, 4);
    expect(fill.apply(at(0, 5 + 15), 100)).toBeCloseTo(100, 6);
    expect(fill.apply(at(0, 5 + 30), 100)).toBe(100);
    // Cut: the same corridor through ground at 120 m.
    expect(fill.apply(at(0, 5 + 4), 120)).toBeCloseTo(114, 4);
    expect(fill.apply(at(0, 5 + 10), 120)).toBeCloseTo(120, 6);
    // Ground between the banks' bounds is left alone.
    expect(fill.apply(at(0, 5 + 6), 109)).toBe(109);
  });

  it('does nothing beyond its reach and fades in without a step', () => {
    // Ground 100 m below the formation: the bank cannot reach it, and the edit fades out.
    expect(fill.apply(at(0, 60.01), 10)).toBe(10);
    expect(fill.apply(at(0, 80), 10)).toBe(10);
    let last = fill.apply(at(0, 0), 10);
    for (let x = 0.25; x <= 70; x += 0.25) {
      const h = fill.apply(at(0, x), 10);
      // Continuous: at most the fade's steepest slope, 1.5 / fade × the bank's ~70 m
      // above the ground at reach − fade, times the 0.25 m step. The aligner sets the
      // reach so banks meet the ground; a taller fill is a viaduct (N5).
      expect(Math.abs(h - last)).toBeLessThan(0.25 * (1.5 / 10) * 72);
      last = h;
    }
  });

  it('reports the formation as bare ground', () => {
    expect(fill.cover(at(0, 0))).toBe(1);
    expect(fill.cover(at(0, 4.9))).toBe(1);
    expect(fill.cover(at(0, 30))).toBe(0);
    expect(fill.cover(at(9000, 0))).toBe(0);
  });

  it('never edits the sea', () => {
    expect(fill.apply(at(0, 0), -2)).toBe(-2);
    expect(fill.apply(at(0, 0), 0)).toBe(0);
  });

  it('rejects malformed corridors', () => {
    expect(
      () => new TerrainEdits({ radius: R, corridors: [corridor(() => 1, { reach: 5 })] }),
    ).toThrow();
    const c = corridor(() => 1);
    expect(
      () =>
        new TerrainEdits({ radius: R, corridors: [{ ...c, elevation: c.elevation.subarray(1) }] }),
    ).toThrow();
  });
});

describe('composition', () => {
  const low = corridor(() => 100, { priority: 0 });
  const high = corridor(() => 110, { priority: 1 }, 90 * DEG);

  it('blends overlapping corridors, the higher rank four times as heavily', () => {
    const e = new TerrainEdits({ radius: R, corridors: [low, high] });
    // Where both formations cover the ground: (1 · 100 + 4 · 110) / 5.
    expect(e.apply(at(0, 0), 105)).toBeCloseTo(108, 6);
    // On one formation alone, that corridor's elevation.
    expect(e.apply(at(1000, 0), 105)).toBeCloseTo(100, 6);
    expect(e.apply(at(0, 1000), 105)).toBeCloseTo(110, 6);
    // The order of the records does not matter.
    const f = new TerrainEdits({ radius: R, corridors: [high, low] });
    for (const [a, c] of [
      [0, 0],
      [3, 7],
      [-12, 20],
    ] as const) {
      expect(f.apply(at(a, c), 105)).toBeCloseTo(e.apply(at(a, c), 105), 9);
    }
  });

  it('puts pads over corridors, at exactly the pad elevation', () => {
    const pad: PadEdit = {
      center: at(0, 0),
      heading: 0,
      along0: -300,
      along1: 300,
      across0: -50,
      across1: 50,
      elevation: 123.25,
      margin: 100,
    };
    const e = new TerrainEdits({ radius: R, pads: [pad], corridors: [low] });
    expect(e.apply(at(0, 0), 140)).toBe(123.25);
    expect(e.apply(at(200, 3), 90)).toBe(123.25);
    // Beyond the pad's margin the corridor alone.
    expect(e.apply(at(2000, 0), 140)).toBeCloseTo(100, 6);
  });

  it('restricts itself to tiles the edits reach, with the same heights as apply', () => {
    const e = new TerrainEdits({ radius: R, corridors: [low] });
    const t = tileForDirection(at(0, 0), 9);
    const f = e.forTile(t)!;
    expect(f).not.toBeNull();
    for (const [a, c] of [
      [0, 0],
      [10, 8],
      [-40, -30],
    ] as const) {
      expect(f(at(a, c), 97)).toBe(e.apply(at(a, c), 97));
    }
    // Far away, and on tiles too coarse to draw a formation: nothing.
    expect(e.forTile(tileForDirection(at(0, 40_000), 9))).toBeNull();
    let coarse = t;
    while (coarse.level >= CORRIDOR_MIN_LEVEL) coarse = parentTile(coarse)!;
    expect(e.forTile(coarse)).toBeNull();
    // Every child of the corridor's level-6 tile that it crosses gets it.
    let l6 = t;
    while (l6.level > CORRIDOR_MIN_LEVEL) l6 = parentTile(l6)!;
    expect(e.forTile(l6)).not.toBeNull();
    expect(childTiles(l6).some((k) => e.forTile(k) !== null)).toBe(true);
    expect(e.forTile(tileKey(1, 9, 5, 5))).toBeNull();
  });
});

/**
 * One carved river across the corridor, east–west through CENTER: 40 m wide,
 * its water at 95 m. `carved` is the kernel's surface: the channel 2 m deep,
 * the banks rising at 1 : 10 to the 100 m plain.
 */
const RIVER_WIDTH = 40;
function riverSource(surface = 95): ChannelSource {
  // Segments of 400 m, as the river index's are, so the chords hug the sphere.
  const n = 25;
  const data = new Float64Array(n * RIVER_SEGMENT_FIELDS);
  for (let s = 0; s < n; s++) {
    const a = offsetPoint(CENTER, 90 * DEG, -5000 + 400 * s, 0, R);
    const b = offsetPoint(CENTER, 90 * DEG, -5000 + 400 * (s + 1), 0, R);
    data.set(
      [a.x, a.y, a.z, b.x, b.y, b.z, RIVER_WIDTH, RIVER_WIDTH, surface, surface, surface, surface],
      s * RIVER_SEGMENT_FIELDS,
    );
  }
  const ids = Array.from({ length: n }, (_, i) => i);
  return { segments: { count: n, data, fields: RIVER_SEGMENT_FIELDS }, forTile: () => ids };
}
const carved = (along: number) => {
  const d = Math.abs(along);
  if (d < RIVER_WIDTH / 2) return 93 + 2 * (d / (RIVER_WIDTH / 2)) ** 2;
  return Math.min(100, 95 + (d - RIVER_WIDTH / 2) / 10);
};
const zone =
  RIVER_WIDTH / 2 +
  Math.max(CHANNEL_PROTECTION.minBank, CHANNEL_PROTECTION.bankShare * RIVER_WIDTH);

describe('protected river channels', () => {
  it('never lets a fill corridor raise the ground inside a channel', () => {
    // A road embankment 6 m above the plain, straight across the river.
    const road = corridor(() => 106, { halfWidth: 6, reach: 40 });
    const e = new TerrainEdits({ radius: R, corridors: [road], channels: riverSource() });
    for (let along = -200; along <= 200; along += 0.5) {
      for (const across of [0, 4, 9, 20]) {
        const p: Vec3d = at(along, across);
        const h = carved(along);
        const out = e.apply(p, h);
        if (Math.abs(along) < zone - 0.01) expect(out).toBe(h);
        else expect(out).toBeGreaterThanOrEqual(h);
      }
    }
    // Beyond the fade the embankment stands at full height.
    expect(e.apply(at(zone + CHANNEL_PROTECTION.fade + 1, 0), 100)).toBeCloseTo(106, 6);
    // The same through a tile's restricted function.
    const f = e.forTile(tileForDirection(at(0, 0), 10))!;
    for (let along = -zone + 0.5; along < zone; along += 1) {
      expect(f(at(along, 0), carved(along))).toBe(carved(along));
    }
  });

  it('lets cuts through a channel stand', () => {
    const cut = corridor(() => 90, { halfWidth: 6, reach: 40 });
    const e = new TerrainEdits({ radius: R, corridors: [cut], channels: riverSource() });
    expect(e.apply(at(0, 0), carved(0))).toBeCloseTo(90, 6);
    expect(e.apply(at(30, 0), carved(30))).toBeCloseTo(90, 6);
  });

  it('holds pads that fill a channel too', () => {
    const pad: PadEdit = {
      center: at(0, 0),
      heading: 0,
      along0: -500,
      along1: 500,
      across0: -50,
      across1: 50,
      elevation: 101,
      margin: 200,
    };
    const e = new TerrainEdits({ radius: R, pads: [pad], channels: riverSource() });
    expect(e.apply(at(0, 0), carved(0))).toBe(carved(0));
    expect(e.apply(at(200, 0), carved(200))).toBe(101);
  });

  it('protects only carved rivers', () => {
    const road = corridor(() => 106, { halfWidth: 6, reach: 40 });
    const e = new TerrainEdits({ radius: R, corridors: [road], channels: riverSource(NO_SURFACE) });
    expect(e.apply(at(0, 0), carved(0))).toBeCloseTo(106, 6);
  });

  it('leaves pad edits as they were where no channel is near', () => {
    // The formula of decision 108, bit for bit.
    const pad: PadEdit = {
      center: at(5000, 0),
      heading: 30 * DEG,
      along0: -800,
      along1: 900,
      across0: -60,
      across1: 400,
      elevation: 140,
      margin: 400,
    };
    const plain = new TerrainEdits({ radius: R, pads: [pad] });
    const guarded = new TerrainEdits({ radius: R, pads: [pad], channels: riverSource() });
    for (let a = -1500; a <= 1500; a += 37) {
      for (let c = -600; c <= 900; c += 41) {
        const p = offsetPoint(at(5000, 0), 30 * DEG, a, c, R);
        expect(guarded.apply(p, 120 + a / 50)).toBe(plain.apply(p, 120 + a / 50));
      }
    }
  });
});
