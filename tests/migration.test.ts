/**
 * Meander migration with cutoffs (decision 173): a synthetic lowland river,
 * then the channel stage on real networks, with RiverIndex's invariants.
 */
import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { CubeGrid } from '../src/core/cubeGrid';
import { PLANET_RADIUS } from '../src/core/units';
import { computeChannels } from '../src/worldgen/channels/channels';
import { riverInvariants } from '../src/worldgen/channels/invariants';
import { MIGRATION_TUNING, migrate, sinuosityOf } from '../src/worldgen/channels/migration';
import { computeDrainage } from '../src/worldgen/drainage';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { generateWorld } from '../src/worldgen/pipeline';
import { NO_SURFACE, RIVER_SEGMENT_FIELDS, RiverIndex } from '../src/worldgen/riverIndex';
import { extractRivers } from '../src/worldgen/rivers';

const R = PLANET_RADIUS;
const W = 100;

/** An 80 km river along the equator, 100 m wide, with gentle seed bends. */
function seedRiver(phase: number): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i <= 800; i++) {
    const x = i * 100;
    const y =
      150 * Math.sin((2 * Math.PI * x) / (1100 + 200 * phase) + phase) +
      40 * Math.sin((2 * Math.PI * x) / 3100 + 1 + phase);
    const d = latLonToDirection(y / R, x / R);
    pts.push([d.x, d.y, d.z, W, 50 - x / 1e4]);
  }
  return pts;
}

/** Signed curvature (1/m) along a line in the equatorial plane's (east, north) coordinates. */
function curvatures(line: number[][]): number[] {
  const xy = line.map((p) => [Math.atan2(p[0]!, p[2]!) * R, Math.asin(p[1]!) * R]);
  const out: number[] = [];
  for (let i = 1; i + 1 < xy.length; i++) {
    const [x0, y0] = xy[i - 1]!;
    const [x1, y1] = xy[i]!;
    const [x2, y2] = xy[i + 1]!;
    const dx = (x2! - x0!) / 2;
    const dy = (y2! - y0!) / 2;
    const ddx = x2! - 2 * x1! + x0!;
    const ddy = y2! - 2 * y1! + y0!;
    out.push((dx * ddy - dy * ddx) / Math.hypot(dx, dy) ** 3);
  }
  return out;
}

describe('meander migration (decision 173)', () => {
  const runs = [1, 2, 3].map((ph) => migrate(seedRiver(ph), R, () => 5000));

  it('keeps both ends exactly and carries the attributes', () => {
    for (const [i, r] of runs.entries()) {
      const raw = seedRiver(i + 1);
      expect(r.line[0]).toEqual(raw[0]);
      expect(r.line[r.line.length - 1]).toEqual(raw[raw.length - 1]);
      for (const p of r.line) expect(p[3]).toBeCloseTo(W, 9);
    }
  });

  it('grows lowland sinuosity and cuts off oxbows', () => {
    for (const r of runs) {
      const s = sinuosityOf(r.line, R);
      expect(s).toBeGreaterThan(1.5);
      expect(s).toBeLessThan(3);
      expect(r.oxbows.length).toBeGreaterThan(0);
      // Each oxbow is a loop: its ends close together, its length many widths.
      for (const o of r.oxbows) {
        const a = o[0]!;
        const b = o[o.length - 1]!;
        const gap = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) * R;
        expect(gap).toBeLessThan(MIGRATION_TUNING.cutoff * W * 1.01);
        expect(sinuosityOf(o, R)).toBeGreaterThan(2);
      }
    }
  });

  it('forms bends of Earth-like wavelength and radius', () => {
    for (const r of runs) {
      const k = curvatures(r.line);
      // Bends: runs of one curvature sign; the valley wavelength is two bends' chord.
      let flips = 0;
      for (let i = 1; i < k.length; i++) if (Math.sign(k[i]!) !== Math.sign(k[i - 1]!)) flips++;
      const valleyWavelength = (2 * 80_000) / Math.max(flips, 1) / W;
      expect(valleyWavelength).toBeGreaterThan(7);
      expect(valleyWavelength).toBeLessThan(18);
      // Radius at the bends' apexes (the largest curvature in each run).
      const apex: number[] = [];
      let best = 0;
      for (let i = 0; i < k.length; i++) {
        best = Math.max(best, Math.abs(k[i]!));
        if (i + 1 === k.length || Math.sign(k[i + 1]!) !== Math.sign(k[i]!)) {
          apex.push(1 / best / W);
          best = 0;
        }
      }
      apex.sort((x, y) => x - y);
      const median = apex[apex.length >> 1]!;
      expect(median).toBeGreaterThan(1);
      expect(median).toBeLessThan(5);
    }
  });

  it('stays inside its floodplain', () => {
    const raw = seedRiver(2);
    const half = 600;
    const r = migrate(raw, R, () => half);
    // The axis is near the equator: the distance from it is about |latitude| R, plus the seed bends.
    for (const p of r.line) expect(Math.abs(Math.asin(p[1]!) * R)).toBeLessThan(half + 200);
  });

  it('keeps reaches without room, such as lakes, on their line', () => {
    // The middle third of the arc length (27–53 km, about x = 25–49 km along the wavy
    // seed line) has no room: it lies in a lake.
    const raw = seedRiver(2);
    const r = migrate(raw, R, (u) => (u > 27_000 && u < 53_000 ? 0 : 5000));
    const axis = new Map<number, number>();
    for (const p of raw)
      axis.set(Math.round((Math.atan2(p[0]!, p[2]!) * R) / 100), Math.asin(p[1]!) * R);
    for (const p of r.line) {
      const x = Math.atan2(p[0]!, p[2]!) * R;
      if (x < 30_000 || x > 45_000) continue;
      // Within a node spacing of the seed line there.
      const y = Math.asin(p[1]!) * R;
      expect(Math.abs(y - axis.get(Math.round(x / 100))!)).toBeLessThan(
        1.5 * MIGRATION_TUNING.spacing * W,
      );
    }
  });

  it('is deterministic', () => {
    const again = migrate(seedRiver(1), R, () => 5000);
    expect(again.line).toEqual(runs[0]!.line);
    expect(again.oxbows.length).toBe(runs[0]!.oxbows.length);
  });
});

describe('the channel stage on real networks', () => {
  const N = 96;
  const grid = new CubeGrid(N);
  for (const seed of ['3', '1983']) {
    // Few iterations: the invariants, not the shapes, are what this checks.
    it(`keeps every invariant with migrated rivers and oxbows (seed ${seed})`, () => {
      const params = { ...DEFAULT_PLANET_PARAMS, seed };
      const world = generateWorld(params, { resolution: N, grid });
      const m = world.maps;
      const drainage = computeDrainage(N, m.height, m.runoff, R);
      const rivers = extractRivers(N, m.height, drainage.receiver, drainage.discharge);
      const channels = computeChannels(rivers, {
        height: m.height,
        lakeDepth: drainage.lakeDepth,
        radius: R,
        tuning: { iterations: 60 },
      });
      const index = new RiverIndex(rivers, {
        height: m.height,
        radius: R,
        lakeDepth: drainage.lakeDepth,
        channels,
      });
      const inv = riverInvariants(index, rivers.downstream, {
        radius: R,
        cellSize: ((Math.PI / 2) * R) / N,
      });
      expect(inv.surfaceRises).toBe(0);
      expect(inv.junctionRises).toBe(0);
      expect(inv.junctionGaps).toBe(0);
      expect(inv.bedMaxima).toBe(0);
      // Oxbows are level and no higher than the rivers they left.
      const d = index.segments.data;
      const F = RIVER_SEGMENT_FIELDS;
      for (let o = 0; o + 1 < index.oxbows.length; o++) {
        for (let s = index.oxbows[o]!; s < index.oxbows[o + 1]!; s++) {
          expect(d[s * F + 8]).toBe(d[index.oxbows[o]! * F + 8]);
          expect(d[s * F + 9]).toBe(d[s * F + 8]);
          expect(d[s * F + 8]).toBeLessThan(NO_SURFACE / 2);
        }
      }
      console.log(
        `seed ${seed}: ${channels.rivers.length} rivers migrated, ` +
          `${channels.oxbowRiver.length} oxbows, ${channels.ms.toFixed(0)} ms`,
      );
    }, 120_000);
  }
});
