/**
 * From a routed path to an alignment (decision 180): arcs that keep the
 * radius, a profile that keeps the grade, viaducts over deep valleys and
 * tunnels under ridges.
 */
import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { DEG, PLANET_RADIUS } from '../src/core/units';
import type { Vec3d } from '../src/core/vec3d';
import { TerrainEdits } from '../src/worldgen/edits';
import { alignPiece, FORMATION_HALF_WIDTH, gnomonic } from '../src/worldgen/networks/pieces';
import { ROUTE_CLASSES } from '../src/worldgen/networks/router';
import {
  designProfile,
  EARTHWORK_LIMITS,
  earthworks,
  fitPlan,
  STRUCTURE,
} from '../src/worldgen/networks/alignment';

describe('plan fitting', () => {
  it('rounds corners with the minimum radius and keeps the ends', () => {
    const path: [number, number][] = [
      [0, 0],
      [2000, 0],
      [2000, 2000],
      [4000, 2000],
    ];
    const plan = fitPlan(path, 300, 10);
    expect(plan.violations).toEqual([]);
    expect(plan.points[0]).toEqual([0, 0]);
    expect(plan.points[plan.points.length - 1]).toEqual([4000, 2000]);
    // Curvature from three consecutive points: no radius below the minimum.
    const p = plan.points;
    for (let i = 1; i + 1 < p.length; i++) {
      const [ax, ay] = p[i - 1]!;
      const [bx, by] = p[i]!;
      const [cx, cy] = p[i + 1]!;
      const area = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
      if (area < 1e-6) continue;
      const r =
        (Math.hypot(bx - ax, by - ay) *
          Math.hypot(cx - bx, cy - by) *
          Math.hypot(cx - ax, cy - ay)) /
        (4 * area);
      expect(r).toBeGreaterThan(300 * 0.98);
    }
    // Shorter than the corners' path by the arcs' saving, evenly spaced.
    const L = plan.s[plan.s.length - 1]!;
    expect(L).toBeLessThan(6000);
    expect(L).toBeGreaterThan(6000 - 2 * 300 * (2 - Math.PI / 2) - 1);
  });

  it('reports corners too tight for the radius', () => {
    const plan = fitPlan(
      [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
      500,
      5,
    );
    expect(plan.violations.length).toBe(1);
    expect(plan.violations[0]).toBeLessThan(500);
  });
});

describe('design profile and earthworks', () => {
  const step = 25;
  const s = Array.from({ length: 401 }, (_, i) => i * step);
  // A plain at 100 m, a valley 60 m deep around 4 km, a ridge 80 m high around 7 km.
  const ground = s.map(
    (x) =>
      100 - 60 * Math.exp(-(((x - 4000) / 250) ** 2)) + 80 * Math.exp(-(((x - 7000) / 300) ** 2)),
  );

  it('keeps the grade, pins its ends, and smooths crests and sags', () => {
    for (const g of [0.02, 0.05]) {
      const z = designProfile(ground, s, g, { startZ: 100, endZ: 100 });
      expect(z[0]).toBe(100);
      expect(z[z.length - 1]).toBe(100);
      for (let i = 1; i < z.length; i++)
        expect(Math.abs(z[i]! - z[i - 1]!) / step).toBeLessThanOrEqual(g + 1e-9);
      // No kinks: the grade changes little between neighbors.
      for (let i = 2; i < z.length; i++)
        expect(Math.abs(z[i]! - 2 * z[i - 1]! + z[i - 2]!) / step).toBeLessThan(g / 2);
    }
  });

  it('puts a railway on a viaduct over the valley and in a tunnel under the ridge', () => {
    const z = designProfile(ground, s, 0.02, { startZ: 100, endZ: 100 });
    const st = earthworks(z, ground, EARTHWORK_LIMITS.mainline);
    expect(st[Math.round(4000 / step)]).toBe(STRUCTURE.Viaduct);
    expect(st[Math.round(7000 / step)]).toBe(STRUCTURE.Tunnel);
    expect(st[Math.round(1500 / step)]).toBe(STRUCTURE.Corridor);
    // A secondary road takes no structures: it follows the ground more closely instead.
    const zr = designProfile(ground, s, 0.1, { startZ: 100, endZ: 100 });
    expect(
      earthworks(zr, ground, EARTHWORK_LIMITS.secondary).every((x) => x === STRUCTURE.Corridor),
    ).toBe(true);
    const worst = (zz: number[]) => Math.max(...zz.map((v, i) => Math.abs(v - ground[i]!)));
    expect(worst(zr)).toBeLessThan(worst(z));
  });
});

describe('a piece on the sphere', () => {
  const R = PLANET_RADIUS;
  const C = latLonToDirection(41 * DEG, -12 * DEG);
  const frame = gnomonic(C, R);
  // Rolling ground with a valley 50 m deep across the route, in the frame's meters.
  const height = (d: Readonly<Vec3d>) => {
    const [x, y] = frame.toPlane(d);
    return 300 + 25 * Math.sin(x / 900) * Math.cos(y / 1300) - 50 * Math.exp(-((x / 300) ** 2));
  };
  const a = frame.toSphere(-4000, -600);
  const b = frame.toSphere(4000, 700);

  it('routes, profiles and edits a trunk road whose formation the edited ground follows', () => {
    const piece = alignPiece(a, b, height, R, {
      cls: ROUTE_CLASSES.trunk,
      limits: EARTHWORK_LIMITS.trunk,
      halfWidth: FORMATION_HALF_WIDTH.trunk,
      spacing: 50,
      band: 1500,
    })!;
    expect(piece).not.toBeNull();
    expect(piece.points[0]!.distanceTo(a) * R).toBeLessThan(1e-3);
    expect(piece.points[piece.points.length - 1]!.distanceTo(b) * R).toBeLessThan(1e-3);
    for (let i = 1; i < piece.design.length; i++)
      expect(
        Math.abs(piece.design[i]! - piece.design[i - 1]!) / (piece.s[i]! - piece.s[i - 1]!),
      ).toBeLessThanOrEqual(ROUTE_CLASSES.trunk.maxGrade + 1e-9);
    expect(piece.corridors.length).toBeGreaterThan(0);
    // The edited ground on the formation is the design elevation.
    const edits = new TerrainEdits({ radius: R, corridors: piece.corridors });
    let checked = 0;
    for (let i = 0; i < piece.points.length; i++) {
      if (piece.structure[i] !== STRUCTURE.Corridor) continue;
      const p = piece.points[i]!;
      expect(Math.abs(edits.apply(p, height(p)) - piece.design[i]!)).toBeLessThan(0.05);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });
});
