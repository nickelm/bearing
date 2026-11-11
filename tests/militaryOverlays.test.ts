import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { CubeGrid } from '../src/core/cubeGrid';
import { DEG } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { buildLabels } from '../src/render/strategic/labels/labelModel';
import {
  buildMilitaryOverlays,
  densify,
  FACTION_COLORS,
  FRONT_COLOR,
  greatCircle,
  MAX_STEP,
  teethSide,
} from '../src/render/strategic/overlays/militaryModel';
import type { TerritoryLookup } from '../src/render/strategic/overlays/militaryModel';
import { COAST_SPREAD, territoryTexels } from '../src/render/strategic/overlays/territoryTexture';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { polylinePoint } from '../src/worldgen/strategic/graph';
import type { Point } from '../src/worldgen/strategic/graph';
import { TERRITORY_PACT } from '../src/worldgen/strategic/territory';

const dir = (lat: number, lon: number): Point => {
  const v = latLonToDirection(lat * DEG, lon * DEG);
  return [v.x, v.y, v.z];
};

function angle(a: Point, b: Point): number {
  return Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
}

describe('overlay geometry', () => {
  it('splits great circles and polylines into short steps, keeping the ends', () => {
    const a = dir(0, 0);
    const b = dir(10, 30);
    const g = greatCircle(a, b);
    const n = g.length / 3;
    expect(polylinePoint(g, 0)).toEqual(a.map((x) => expect.closeTo(x, 12)));
    expect(polylinePoint(g, n - 1)).toEqual(b.map((x) => expect.closeTo(x, 12)));
    for (let i = 1; i < n; i++)
      expect(angle(polylinePoint(g, i - 1), polylinePoint(g, i))).toBeLessThanOrEqual(
        MAX_STEP + 1e-9,
      );
    const line = Float64Array.from([...dir(0, 0), ...dir(0, 5), ...dir(3, 5)]);
    const d = densify(line);
    const m = d.length / 3;
    expect(polylinePoint(d, m - 1)).toEqual(dir(3, 5).map((x) => expect.closeTo(x, 12)));
    for (let i = 1; i < m; i++)
      expect(angle(polylinePoint(d, i - 1), polylinePoint(d, i))).toBeLessThanOrEqual(
        MAX_STEP + 1e-9,
      );
  });

  it('puts teeth on the side the attacker holds', () => {
    // A line running east along the equator: north of it is its left.
    const line = densify(Float64Array.from([...dir(0, -10), ...dir(0, 10)]));
    const pactNorth: TerritoryLookup = {
      ownerAt: (p) => (p[1] > 0 ? TERRITORY_PACT : 1),
      cellAngle: 0.5 * DEG,
    };
    expect(teethSide(line, 'pact', dir(-20, 0), pactNorth)).toBe(1);
    expect(teethSide(line, 'alliance', dir(20, 0), pactNorth)).toBe(-1);
    // Without a raster, the attacker's centroid decides.
    expect(teethSide(line, 'pact', dir(20, 0), null)).toBe(1);
    expect(teethSide(line, 'pact', dir(-20, 0), null)).toBe(-1);
  });

  it('spreads territory over the sea near coasts, one channel per holder', () => {
    const grid = new CubeGrid(32);
    const owner = new Int8Array(grid.cellCount).fill(-1);
    const land = grid.cellOfDirection(new Vec3d(0, 0, 1));
    owner[land] = TERRITORY_PACT;
    const t = territoryTexels(owner, grid);
    expect([...t.subarray(land * 4, land * 4 + 4)]).toEqual([0, 255, 0, 0]);
    let spread = 0;
    for (let c = 0; c < grid.cellCount; c++) if (t[c * 4 + 1] === 255) spread++;
    expect(spread).toBe((2 * COAST_SPREAD + 1) ** 2);
    const far = grid.cellOfDirection(new Vec3d(0, 0, -1));
    expect([...t.subarray(far * 4, far * 4 + 4)]).toEqual([0, 0, 0, 0]);
  });
});

describe('military overlays on a generated world (seed 1: two fronts, sea lanes)', () => {
  const grid = new CubeGrid(128);
  const w = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed: 1 }, { grid });
  const g = w.graph;
  const cast = w.campaign.cast;
  const fgrid = new CubeGrid(g.resolution);
  const v = new Vec3d();
  const ownerAt = (p: Readonly<Point>) =>
    w.infrastructure.territory[fgrid.cellOfDirection(v.set(p[0], p[1], p[2]))]!;
  const territory: TerritoryLookup = { ownerAt, cellAngle: Math.PI / 2 / fgrid.n };
  const o = buildMilitaryOverlays(g, cast, territory);
  const fronts = cast.theaters.filter((t) => t.kind === 'continental-front');

  it('stores a territory holder for every coarse cell', () => {
    expect(w.infrastructure.territory.length).toBe(fgrid.cellCount);
    const codes = new Set(w.infrastructure.territory);
    for (const c of codes) expect([-1, 0, 1, 2]).toContain(c);
  });

  it('draws one toothed front line per continental front, teeth on the attacker side', () => {
    const lines = o.lines.filter((l) => l.layer === 'front');
    expect(lines.length).toBe(fronts.length);
    for (const l of lines) {
      expect(l.style.color).toBe(FRONT_COLOR);
      expect(l.style.teeth?.color).toBe(FACTION_COLORS.pact);
      // Beside the line, the teeth's side is mostly the attacker's territory.
      const side = l.style.teeth!.side;
      let attacker = 0;
      let sampled = 0;
      const n = l.points.length / 3;
      for (let i = 1; i + 1 < n; i += 3) {
        const p = polylinePoint(l.points, i);
        const a = polylinePoint(l.points, i - 1);
        const b = polylinePoint(l.points, i + 1);
        const t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const left = [
          p[1] * t[2] - p[2] * t[1],
          p[2] * t[0] - p[0] * t[2],
          p[0] * t[1] - p[1] * t[0],
        ];
        const len = Math.hypot(...left);
        const off = (3 * territory.cellAngle * side) / len;
        const q: Point = [p[0] + left[0]! * off, p[1] + left[1]! * off, p[2] + left[2]! * off];
        const code = ownerAt(q);
        if (code > 0) {
          sampled++;
          if (code === TERRITORY_PACT) attacker++;
        }
      }
      expect(sampled).toBeGreaterThan(5);
      expect(attacker / sampled).toBeGreaterThan(0.75);
    }
  });

  it('draws corridors as named arrows from the attacker into the defender', () => {
    const shafts = o.lines.filter((l) => l.layer === 'corridors');
    const heads = o.marks.filter((m) => m.layer === 'corridors');
    expect(shafts.length).toBe(heads.length);
    expect(fronts.length).toBeGreaterThan(0);
    expect(shafts.length).toBeGreaterThan(0);
    let fromAttacker = 0;
    for (const s of shafts) {
      expect(s.name).toBeTruthy();
      expect(s.style.roundEnds).toBe(false);
      const n = s.points.length / 3;
      if (ownerAt(polylinePoint(s.points, 0)) === TERRITORY_PACT) fromAttacker++;
      expect(ownerAt(polylinePoint(s.points, n - 1))).not.toBe(TERRITORY_PACT);
    }
    expect(fromAttacker).toBeGreaterThanOrEqual(Math.ceil(0.7 * shafts.length));
    const labels = buildLabels(g, cast, () => 0, o).filter((l) => l.layer === 'corridors');
    expect(labels.length).toBe(shafts.length);
    for (const l of labels) {
      expect(l.style).toBe('corridorPact');
      expect(l.bands).toEqual(['theater', 'region']);
    }
  });

  it('shows the lanes and chokepoints in play, and dashes defensive lines', () => {
    for (const l of o.lines.filter((x) => x.layer === 'defense')) {
      expect(l.style.dash).toBeGreaterThan(0);
      expect(l.bands).not.toContain('globe');
    }
    const laneTheaters = cast.theaters.filter((t) => t.kind === 'sea-lane');
    const lanes = o.lines.filter((l) => l.layer === 'lanes');
    expect(laneTheaters.length).toBeGreaterThan(0);
    expect(lanes.length).toBeGreaterThanOrEqual(laneTheaters.length);
    for (const l of lanes) expect(l.style.dash).toBeGreaterThan(0);
    for (const t of cast.theaters.filter((x) => x.kind === 'chokepoint')) {
      const k = g.chokepoints[t.chokepoint!]!;
      expect(o.marks.some((m) => m.shape === 'diamond' && m.point === k.point)).toBe(true);
    }
  });

  it('is empty without a cast', () => {
    expect(buildMilitaryOverlays(g, null, territory)).toEqual({ lines: [], marks: [] });
  });
});
