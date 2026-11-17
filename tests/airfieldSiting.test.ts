import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { DEG } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { AIRFIELD_FOOTPRINT } from '../src/render/sim/infra/airfieldGrading';
import { localFrame } from '../src/render/sim/infra/infraScene';
import { SITING_DRY, SITING_RADIUS, SITING_TURN, siteAirfields } from '../src/worldgen/edits';
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

const infra = (b: Airbase) => ({ airbases: [b] }) as unknown as Infrastructure;
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
});
