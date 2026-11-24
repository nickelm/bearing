/** The gun's recoil and its rounds on the ground (decision 339); the sight (decision 338). */
import { describe, expect, it } from 'vitest';
import { Vec3d } from '../src/core/vec3d';
import { bundleOfType } from '../src/sim/air/bundles';
import { initialAvionics } from '../src/sim/avionics/avionics';
import type { FlightModel } from '../src/sim/flight/flightModel';
import type { GunSpec } from '../src/sim/flight/gun';
import { gunRecoil } from '../src/sim/flight/storesRack';
import { sightPoint } from '../src/ui/flight/hudFrame';
import { capMission, phaseStart, promote, seaLevel } from './helpers/promoted';

describe('the gun’s recoil (decision 339)', () => {
  it('is its rounds’ momentum flow and the gas: about 42 kN for the A-15’s cannon', () => {
    const a15 = bundleOfType('a15').gun as unknown as GunSpec;
    expect(gunRecoil(a15)).toBeGreaterThan(38e3);
    expect(gunRecoil(a15)).toBeLessThan(46e3);
    const f21 = bundleOfType('f21').gun as unknown as GunSpec;
    expect(gunRecoil(f21)).toBeLessThan(gunRecoil(a15) / 2);
  });

  it('pushes the aircraft back while the gun fires, and only then', () => {
    const m = capMission();
    const t0 = phaseStart(m, 'on-target') + 100;
    const run = (fire: boolean) => {
      const f = promote({ ...m, aircraft: 1 }, t0);
      const a = f.aircraft[0]!;
      const model = a.flown.airframe as unknown as FlightModel;
      const av = { ...initialAvionics(false), masterArm: true, weapon: 'gun' };
      a.rack.gun!.trigger = fire;
      const ctl = { pitch: 0, roll: 0, yaw: 0, throttle: 0.9, afterburner: 0, brakes: 0 };
      for (let i = 0; i < 120; i++) {
        a.rack.stepWeapons(model, av, 1 / 120, t0 + i / 120, seaLevel);
        model.step(ctl as never, seaLevel);
      }
      return { speed: model.vel.length(), recoil: model.recoil };
    };
    const quiet = run(false);
    const firing = run(true);
    expect(quiet.recoil).toBe(0);
    expect(firing.recoil).toBeGreaterThan(0);
    expect(firing.speed).toBeLessThan(quiet.speed - 0.5);
  });

  it('ends rounds that reach the ground as impacts', () => {
    const m = capMission();
    const t0 = phaseStart(m, 'on-target') + 100;
    const f = promote({ ...m, aircraft: 1 }, t0);
    const a = f.aircraft[0]!;
    const model = a.flown.airframe as unknown as FlightModel;
    const R = model.radius;
    const up = model.pos.clone().normalize();
    // Rounds 300 m up, fired straight down at 1,000 m/s.
    for (let k = 0; k < 10; k++)
      a.rack.gun!.live.push({
        pos: up
          .clone()
          .scale(R + 300)
          .addScaled(new Vec3d(k, 0, 0), 1),
        vel: up.clone().scale(-1000),
        age: 0,
        tracer: false,
      });
    const av = { ...initialAvionics(false), masterArm: false, weapon: 'gun' };
    for (let i = 0; i < 60; i++) a.rack.stepWeapons(model, av, 1 / 120, t0 + i / 120, seaLevel);
    expect(a.rack.roundImpacts.length).toBe(10);
    for (const x of a.rack.roundImpacts) expect(Math.abs(x.at.length() - R)).toBeLessThan(1);
    expect(a.rack.gun!.live.length).toBe(0);
  });
});

describe('the sight (decision 338)', () => {
  const model = {
    pos: new Vec3d(0, 0, 7e6),
    q: { rotate: (v: Vec3d) => new Vec3d(v.z, v.y, v.x) },
  };
  const eye = new Vec3d(0, 10, 7e6 - 30);
  it('looks at the bombs’ pipper, else the gun’s, else the boresight', () => {
    const ccip = { point: [1, 2, 3] as [number, number, number], time: 4, label: '', armed: true };
    const gun = { point: [5, 6, 7] as [number, number, number], rounds: 1, armed: true };
    expect(sightPoint({ ccip, gun }, model, eye)).toEqual(new Vec3d(1, 12, 7e6 - 27));
    expect(sightPoint({ ccip: null, gun }, model, eye)).toEqual(new Vec3d(5, 16, 7e6 - 23));
    expect(sightPoint({ ccip: null, gun: null }, model, eye)).toEqual(new Vec3d(0, 0, 7e6 + 1500));
  });
});
