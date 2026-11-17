import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { DEG } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { AIRFIELD_FOOTPRINT } from '../src/render/sim/infra/airfieldGrading';
import { localFrame } from '../src/render/sim/infra/infraScene';
import {
  resiteSpurs,
  SITING_DRY,
  SITING_RADIUS,
  SITING_TURN,
  siteAirfields,
  siteWonders,
  WONDER_SITING_RADIUS,
} from '../src/worldgen/edits';
import type { RoadNetwork } from '../src/worldgen/strategic/graph';
import type { Airbase, Infrastructure } from '../src/worldgen/strategic/infrastructure';

const R = 1e6;
const P = latLonToDirection(20 * DEG, 30 * DEG, new Vec3d());
const { east, north } = localFrame(P);
/** Meters east and north of P. */
const xy = (d: Readonly<Vec3d>) => {
  const v = d.clone().sub(P);
  return [v.dot(east) * R, v.dot(north) * R] as const;
};

function base(heading = Math.PI / 2): Airbase {
  return {
    id: 0,
    name: 'Test Air Base',
    kind: 'main',
    side: 'alliance',
    node: -1,
    theater: -1,
    cell: 0,
    point: [P.x, P.y, P.z],
    heading,
    runwayLength: 3000,
    depth: -1,
  };
}

const NO_SPURS: RoadNetwork = {
  count: 0,
  offsets: Uint32Array.from([0]),
  cells: new Int32Array(0),
  points: new Float64Array(0),
  roadClass: new Uint8Array(0),
  traffic: new Float32Array(0),
  route: new Int32Array(0),
};
const infra = (b: Airbase) => ({ airbases: [b], spurs: NO_SPURS }) as unknown as Infrastructure;
const site = (h: (x: number, y: number) => number, b = base()) =>
  siteAirfields(infra(b), R, AIRFIELD_FOOTPRINT, (d) => h(...xy(d)));

describe('airfield siting on the eroded ground (decision 220)', () => {
  it('leaves a field on flat dry land exactly where it is', () => {
    const b = base();
    const r = site(() => 120, b);
    expect(r.infrastructure.airbases[0]).toBe(b);
    expect(r.moved[0]).toBe(0);
  });

  it('moves a field out of the sea onto the coast, within the radius', () => {
    // Sea west of x = 2.5 km, a gentle plain east of it.
    const r = site((x) => (x < 2500 ? -20 : 30 + 0.002 * (x - 2500)));
    const a = r.infrastructure.airbases[0]!;
    const p = new Vec3d(...a.point);
    expect(r.wet).toEqual([]);
    expect(r.moved[0]).toBeGreaterThan(2000);
    expect(r.moved[0]).toBeLessThanOrEqual(SITING_RADIUS + 1);
    expect(p.distanceTo(P) * R).toBeCloseTo(r.moved[0]!, -1);
    // The whole pad is dry: its west end clears the coast.
    const [x] = xy(p);
    expect(x - 1500 - AIRFIELD_FOOTPRINT.overrun).toBeGreaterThan(2500 - 300);
    expect(r.rms[0]).toBeLessThan(20);
  });

  it('turns a field off a steep slope toward the flat valley floor', () => {
    // A ridge rising north of y = 3 km; the field on its flank moves south onto the floor.
    const r = site((_x, y) => 200 + Math.max(0, y + 3000) * 0.3);
    const [, y] = xy(new Vec3d(...r.infrastructure.airbases[0]!.point));
    expect(y).toBeLessThan(-3000);
    expect(r.rms[0]).toBeLessThan(20);
  });

  it('turns the runway at most SITING_TURN, keeping the heading in 0..π', () => {
    // A narrow north–south strip of land: an east–west runway cannot fit.
    const r = site((x) => (Math.abs(x) < 900 ? 50 : -30), base(Math.PI / 2 - 0.1));
    const a = r.infrastructure.airbases[0]!;
    expect(a.heading).toBeGreaterThanOrEqual(0);
    expect(a.heading).toBeLessThan(Math.PI);
    expect(Math.abs(a.heading - (Math.PI / 2 - 0.1))).toBeLessThanOrEqual(SITING_TURN + 1e-9);
  });

  it('reports a field with no dry ground within reach and leaves it in place', () => {
    const b = base();
    const r = site(() => SITING_DRY - 10, b);
    expect(r.wet).toEqual([0]);
    expect(r.infrastructure.airbases[0]).toBe(b);
  });

  it('moves the spur road end to the sited field, or adds a spur (decision 221)', () => {
    const q = latLonToDirection(20 * DEG, 30.2 * DEG, new Vec3d());
    const spurs: RoadNetwork = {
      count: 1,
      offsets: Uint32Array.from([0, 2]),
      cells: Int32Array.from([7, 0]),
      points: Float64Array.from([q.x, q.y, q.z, P.x, P.y, P.z]),
      roadClass: Uint8Array.from([2]),
      traffic: new Float32Array(1),
      route: Int32Array.from([-1]),
    };
    const b0 = base();
    const moved: Airbase = { ...b0, point: [q.x, q.y + 0.001, q.z] };
    const r = resiteSpurs(spurs, [b0], [moved]);
    expect(r.count).toBe(1);
    expect(Array.from(r.points.subarray(3, 6))).toEqual(moved.point);
    expect(Array.from(r.points.subarray(0, 3))).toEqual([q.x, q.y, q.z]);
    // Unmoved: unchanged.
    expect(Array.from(resiteSpurs(spurs, [b0], [b0]).points)).toEqual(Array.from(spurs.points));
    // A field whose cell had no spur gets one from its coarse point.
    const other: Airbase = { ...b0, cell: 99 };
    const r2 = resiteSpurs(spurs, [other], [{ ...other, point: moved.point }]);
    expect(r2.count).toBe(2);
    expect(r2.offsets[2]).toBe(4);
    expect(Array.from(r2.points.subarray(6, 9))).toEqual(other.point);
    expect(Array.from(r2.points.subarray(9, 12))).toEqual(moved.point);
    expect(r2.route[1]).toBe(-1);
  });

  it('sites a monolith off a mountain onto the plain beside it (decision 221)', () => {
    // A mountain west of x = 3 km, a flat plain at 120 m east of it.
    const h = (d: Readonly<Vec3d>) => {
      const [x] = xy(d);
      return x < 3000 ? 2500 - 0.3 * x : 120;
    };
    const [w] = siteWonders([5], () => 9, () => P.clone(), R, h);
    expect(w!.moved).toBeGreaterThan(3000);
    expect(w!.moved).toBeLessThanOrEqual(WONDER_SITING_RADIUS);
    expect(w!.base).toBeCloseTo(120, 0);
    // Kinds the tiles do not shape stay at their anchor.
    const [k] = siteWonders([5], () => 2, () => P.clone(), R, h);
    expect(k!.moved).toBe(0);
  });

  it('sites a blue hole in shallow sea (decision 221)', () => {
    // Deep sea west of x = 2 km, a shallow 15 m bank east of it.
    const h = (d: Readonly<Vec3d>) => (xy(d)[0] < 2000 ? -300 : -15);
    const [w] = siteWonders([1], () => 10, () => P.clone(), R, h);
    expect(xy(new Vec3d(...w!.dir))[0]).toBeGreaterThan(2000);
    expect(w!.base).toBeCloseTo(-15, 0);
  });
});
