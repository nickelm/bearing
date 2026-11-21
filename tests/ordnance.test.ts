/** Unguided bombs and rockets, and the CCIP (decision 300). */
import { describe, expect, it } from 'vitest';
import { Quatd } from '../src/core/quat';
import { Vec3d } from '../src/core/vec3d';
import { initialAvionics } from '../src/sim/avionics/avionics';
import { bundleOfType } from '../src/sim/air/bundles';
import type { FlightModel } from '../src/sim/flight/flightModel';
import { flyProjectile, impactPoint, launchProjectile } from '../src/sim/flight/ordnance';
import { rocketCounts, StoresRack } from '../src/sim/flight/storesRack';
import { kestrelSpec } from './helpers/flight';
import { capMission, phaseStart, promote, seaLevel } from './helpers/promoted';

const R = 6_371_000;
const flat = () => 0;
/** Level at `h` m, `v` m/s along +x, wings level (body x +x, right −y, down −z). */
const q = Quatd.fromAxes(new Vec3d(1, 0, 0), new Vec3d(0, -1, 0), new Vec3d(0, 0, -1));
const at = (h: number) => new Vec3d(0, 0, R + h);

function drop(id: string, h: number, v: number, dive = 0) {
  const vel = new Vec3d(v * Math.cos(dive), 0, -v * Math.sin(dive));
  const p = launchProjectile(id, at(h), vel, q)!;
  let t = 0;
  for (;;) {
    const hit = flyProjectile(p, 0.01, R, flat, t);
    if (hit) return hit;
    t += 0.01;
  }
}

describe('bombs (decision 300)', () => {
  it('fall from 1,500 m in about the vacuum time and land short of the vacuum range', () => {
    const hit = drop('bomb-230', 1500, 230);
    // In a vacuum 17.5 s and 4.0 km.
    expect(hit.time).toBeGreaterThan(17.4);
    expect(hit.time).toBeLessThan(19);
    expect(hit.at.x).toBeGreaterThan(3200);
    expect(hit.at.x).toBeLessThan(4030);
  });

  it('predict their impact as they fly it (CCIP)', () => {
    const vel = new Vec3d(220 * Math.cos(0.5), 0, -220 * Math.sin(0.5));
    const ccip = impactPoint('bomb-900', at(1200), vel, q, R, flat)!;
    const hit = drop('bomb-900', 1200, 220, 0.5);
    expect(ccip.at.distanceTo(hit.at)).toBeLessThan(15);
    expect(Math.abs(ccip.time - hit.time)).toBeLessThan(0.2);
  });
});

describe('rockets (decision 300)', () => {
  it('burn to about 700 m/s over the launcher and hit far flatter than a bomb', () => {
    const p = launchProjectile('rockets-19', at(600), new Vec3d(200, 0, -60), q)!;
    let top = 0;
    let hit = null;
    for (let t = 0; !hit && t < 30; t += 0.005) {
      hit = flyProjectile(p, 0.005, R, flat, t);
      top = Math.max(top, p.vel.length());
    }
    expect(top).toBeGreaterThan(700);
    expect(top).toBeLessThan(1000);
    expect(hit!.time).toBeLessThan(drop('bomb-230', 600, 209, Math.atan2(60, 200)).time);
  });
});

describe('from the rack (decision 300)', () => {
  const m = capMission();
  const t0 = phaseStart(m, 'on-target') + 100;
  const f21 = bundleOfType('f21');
  const cas = f21.airWar!.loadouts.find((l) => l.id === 'cas')!;

  it('drop one bomb per press and ripple rockets while the trigger is held', () => {
    const f = promote({ ...m, aircraft: 1 }, t0);
    const a = f.aircraft[0]!;
    const model = a.flown.airframe as unknown as FlightModel;
    const rack = new StoresRack(
      kestrelSpec(),
      f21.pylons,
      cas.stations,
      { loadout: 'cas', expended: {} },
      f21.gun,
    );
    let av = { ...initialAvionics(false), masterArm: true, weapon: 'bomb-230' };
    expect(rack.dropBomb(model, av)).not.toBeNull();
    expect(rack.counts['bomb-230']).toBe(1);
    av = { ...av, weapon: 'rockets-19' };
    expect(rocketCounts(rack.loaded, rack.state.expended)['rockets-19']).toBe(38);
    rack.rocketTrigger = true;
    for (let i = 0; i < 120; i++) rack.stepWeapons(model, av, 1 / 120, t0 + i / 120, seaLevel);
    expect(rack.rocketsLeft('rockets-19')).toBe(28);
    // The pods stay on their pylons.
    expect(rack.counts['rockets-19']).toBe(2);
    rack.rocketTrigger = false;
    for (let i = 0; i < 120 * 100 && rack.ordnance.length > 0; i++)
      rack.stepWeapons(model, av, 1 / 120, t0 + 1 + i / 120, seaLevel);
    expect(rack.impacts.length).toBe(11);
    // Safe: nothing leaves.
    expect(rack.dropBomb(model, { ...av, weapon: 'bomb-230', masterArm: false })).toBeNull();
  });
});
