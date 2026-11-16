/**
 * The alignment router (decisions 180, 181) on synthetic ground: straight on a
 * plain, switchbacks up a face too steep for the road, a railway round a ridge
 * through its gap, and plans and profiles from them within radius and grade.
 */
import { describe, expect, it } from 'vitest';
import { designProfile, fitPlan } from '../src/worldgen/networks/alignment';
import { MOVES, ROUTE_CLASSES, route } from '../src/worldgen/networks/router';
import type { RouteClass } from '../src/worldgen/networks/router';

type Path = [number, number][];

function length(p: Path): number {
  let L = 0;
  for (let i = 1; i < p.length; i++)
    L += Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![1] - p[i - 1]![1]);
  return L;
}

function maxGrade(p: Path, h: (x: number, y: number) => number): number {
  let g = 0;
  for (let i = 1; i < p.length; i++) {
    const L = Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![1] - p[i - 1]![1]);
    g = Math.max(g, Math.abs(h(...p[i]!) - h(...p[i - 1]!)) / L);
  }
  return g;
}

describe('the alignment router (decision 180)', () => {
  it('has the 16 moves of the k = 2 neighborhood', () => {
    expect(MOVES.length).toBe(16);
    const angles = new Set(MOVES.map(([x, y]) => Math.round((Math.atan2(y, x) * 180) / Math.PI)));
    expect(angles.size).toBe(16);
  });

  it('runs nearly straight across a plain at any angle', () => {
    const r = route({
      height: () => 50,
      start: [0, 0],
      goal: [3000, 1100],
      spacing: 50,
      bounds: { x0: -200, y0: -400, x1: 3200, y1: 1500 },
      cls: ROUTE_CLASSES.trunk,
    })!;
    expect(r).not.toBeNull();
    expect(length(r.path)).toBeLessThan(1.03 * Math.hypot(3000, 1100));
  });

  it('switches back up a face too steep for the road', () => {
    // A 30% face rising north; the road climbs 180 m at 14% at most.
    const h = (_x: number, y: number) => 0.3 * y;
    const cls: RouteClass = ROUTE_CLASSES.mountainRoad;
    const r = route({
      height: h,
      start: [0, 0],
      goal: [0, 600],
      spacing: 12.5,
      bounds: { x0: -300, y0: -25, x1: 300, y1: 625 },
      cls,
    })!;
    expect(r).not.toBeNull();
    // The ground may be cut and filled (decision 181), but no move climbs straight at the face's 30%.
    expect(maxGrade(r.path, h)).toBeLessThanOrEqual(cls.maxOver * cls.maxGrade + 1e-9);
    expect(length(r.path)).toBeGreaterThan(0.8 * (180 / cls.maxGrade));
    // Switchbacks: the eastward component of travel changes sign several times.
    let turns = 0;
    let last = 0;
    for (let i = 1; i < r.path.length; i++) {
      const dx = Math.sign(r.path[i]![0] - r.path[i - 1]![0]);
      if (dx !== 0 && last !== 0 && dx !== last) turns++;
      if (dx !== 0) last = dx;
    }
    expect(turns).toBeGreaterThanOrEqual(2);
    // The plan rounds the hairpins at the class's radius; the profile keeps its grade.
    const plan = fitPlan(r.path, cls.minRadius, 2);
    expect(plan.violations.length).toBeLessThanOrEqual(2);
    const z = designProfile(
      plan.points.map(([x, y]) => h(x, y)),
      plan.s,
      cls.maxGrade,
      { startZ: 0, endZ: 180, smooth: 50, verticalCurve: 40 },
    );
    for (let i = 1; i < z.length; i++)
      expect(Math.abs(z[i]! - z[i - 1]!) / (plan.s[i]! - plan.s[i - 1]!)).toBeLessThanOrEqual(
        cls.maxGrade + 1e-9,
      );
  });

  it('takes a railway round a ridge through its gap', () => {
    // A ridge 200 m high along x = 0, with a gap where |y| < 300.
    const h = (x: number, y: number) =>
      200 * Math.exp(-((x / 500) ** 2)) * (1 - Math.exp(-((y / 300) ** 2)));
    const cls = ROUTE_CLASSES.mainline;
    const r = route({
      height: h,
      start: [-3000, 1500],
      goal: [3000, 1500],
      spacing: 50,
      bounds: { x0: -3200, y0: -600, x1: 3200, y1: 2200 },
      cls,
    })!;
    expect(r).not.toBeNull();
    expect(maxGrade(r.path, h)).toBeLessThanOrEqual(cls.maxOver * cls.maxGrade + 1e-9);
    // Through the gap: the line passes the ridge's crest well south of the direct route.
    const atCrest = r.path.reduce((best, q) => (Math.abs(q[0]) < Math.abs(best[0]) ? q : best));
    expect(Math.abs(atCrest[1])).toBeLessThan(700);
    // Its curves fit at the class's radius but for a corner or two.
    expect(fitPlan(r.path, cls.minRadius, 10).violations.length).toBeLessThanOrEqual(2);
  });

  it('gives up where no route meets the grade, and is deterministic', () => {
    const h = (_x: number, y: number) => 0.3 * y;
    const narrow = {
      height: h,
      start: [0, 0] as const,
      goal: [0, 600] as const,
      spacing: 25,
      bounds: { x0: -50, y0: -25, x1: 50, y1: 625 },
      cls: ROUTE_CLASSES.mainline,
    };
    expect(route(narrow)).toBeNull();
    const a = route({
      ...narrow,
      cls: ROUTE_CLASSES.track,
      bounds: { x0: -200, y0: -25, x1: 200, y1: 625 },
    });
    const b = route({
      ...narrow,
      cls: ROUTE_CLASSES.track,
      bounds: { x0: -200, y0: -25, x1: 200, y1: 625 },
    });
    expect(a).not.toBeNull();
    expect(a!.path).toEqual(b!.path);
  });
});
