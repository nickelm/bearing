/**
 * The alignment router (decision 180) on synthetic ground: straight on a plain,
 * switchbacks up a face too steep for the road, a railway round a ridge
 * through its gap, curves no tighter than the class allows.
 */
import { describe, expect, it } from 'vitest';
import { MOVES, ROUTE_CLASSES, route } from '../src/worldgen/networks/router';
import type { RouteClass } from '../src/worldgen/networks/router';

type Path = [number, number][];

function length(p: Path): number {
  let L = 0;
  for (let i = 1; i < p.length; i++)
    L += Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![1] - p[i - 1]![1]);
  return L;
}

/**
 * The radius implied at each turn, as the router reckons it: the straight run
 * before the turn (at most six moves) over twice the tangent of half the turn.
 */
function radii(p: Path): number[] {
  const out: number[] = [];
  let run = 0;
  for (let i = 1; i + 1 < p.length; i++) {
    const a = Math.atan2(p[i]![1] - p[i - 1]![1], p[i]![0] - p[i - 1]![0]);
    const b = Math.atan2(p[i + 1]![1] - p[i]![1], p[i + 1]![0] - p[i]![0]);
    const L = Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![1] - p[i - 1]![1]);
    let turn = Math.abs(b - a);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn < 1e-9) {
      run = Math.min(5, run + 1);
      continue;
    }
    out.push(((run + 1) * L) / (2 * Math.tan(turn / 2)));
    run = 0;
  }
  return out;
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
    expect(maxGrade(r.path, h)).toBeLessThanOrEqual(cls.maxGrade + 1e-9);
    expect(length(r.path)).toBeGreaterThan(180 / cls.maxGrade);
    // Switchbacks: the eastward component of travel changes sign several times.
    let turns = 0;
    let last = 0;
    for (let i = 1; i < r.path.length; i++) {
      const dx = Math.sign(r.path[i]![0] - r.path[i - 1]![0]);
      if (dx !== 0 && last !== 0 && dx !== last) turns++;
      if (dx !== 0) last = dx;
    }
    expect(turns).toBeGreaterThanOrEqual(2);
    for (const rad of radii(r.path)) expect(rad).toBeGreaterThanOrEqual(cls.minRadius - 1e-6);
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
    expect(maxGrade(r.path, h)).toBeLessThanOrEqual(cls.maxGrade + 1e-9);
    // Through the gap: the line passes the ridge's crest well south of the direct route.
    const atCrest = r.path.reduce((best, q) => (Math.abs(q[0]) < Math.abs(best[0]) ? q : best));
    expect(Math.abs(atCrest[1])).toBeLessThan(700);
    for (const rad of radii(r.path)) expect(rad).toBeGreaterThanOrEqual(cls.minRadius - 1e-6);
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
