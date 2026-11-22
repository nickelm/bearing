/**
 * Acceptance check 8's gun pipper (Part I: the flight path marker and gun pipper stay
 * accurate during hard maneuvers; decision 309). The Kestrel flies a 6-g turn
 * through its flight model; a target holds that turn where the HUD's pipper sits, at the
 * pipper's range or a lock's; the rounds fired then pass through it. Aimed with the nose
 * instead, they miss by the lead.
 */
import { describe, expect, it } from 'vitest';
import { DEG, KNOT } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { bundleOfType } from '../src/sim/air/bundles';
import { initialAvionics } from '../src/sim/avionics/avionics';
import { neutralControls } from '../src/sim/flight/controlLaws';
import { AIRCRAFT_RADIUS } from '../src/sim/flight/damage';
import { FLIGHT_STEP } from '../src/sim/flight/flightModel';
import type { FlightModel } from '../src/sim/flight/flightModel';
import { Gun, PIPPER_RANGE } from '../src/sim/flight/gun';
import { runwayEnds } from '../src/sim/flight/runway';
import { spawnInAir } from '../src/sim/flight/spawn';
import { GUN } from '../src/sim/air/stores';
import { gunHud } from '../src/ui/flight/hudFrame';
import { flatGround, kestrel, RADIUS, testRunway } from './helpers/flight';

const runway = testRunway();
const ground = flatGround(runway);
const end = runwayEnds(runway)[0];
const spec = bundleOfType('f21').gun!;
const avionics = { ...initialAvionics(false), weapon: GUN, masterArm: true };

/** v turned by angle t about the unit axis a (Rodrigues). */
function rotate(v: Readonly<Vec3d>, a: Readonly<Vec3d>, t: number): Vec3d {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return v
    .clone()
    .scale(c)
    .addScaled(a.clone().cross(v), s)
    .addScaled(a, a.dot(v) * (1 - c));
}

/** The Kestrel rolled to 60° of bank and pulling about 6 g, settled for three seconds. */
function hardTurn(): FlightModel {
  const m = kestrel();
  spawnInAir(m, runway, end, 3000, 450 * KNOT);
  const ctl = neutralControls();
  ctl.gearDown = false;
  ctl.throttle = 1;
  for (let i = 0; i < 1 / FLIGHT_STEP; i++) m.step(ctl, ground);
  ctl.roll = 0.6;
  while (m.telemetry.bank < 60 * DEG) m.step(ctl, ground);
  ctl.roll = 0;
  ctl.pitch = 0.75;
  for (let i = 0; i < 3 / FLIGHT_STEP; i++) m.step(ctl, ground);
  return m;
}

/**
 * Fires one round where the pipper says, with a target holding the turn at the pipper
 * (`aim: 'pipper'`) or on the gun line (`aim: 'nose'`) at `range`; returns the closest the
 * round came to the target (m) and the load factor of the turn.
 */
function shot(range: number, aim: 'pipper' | 'nose'): { miss: number; load: number } {
  const m = hardTurn();
  const ctl = neutralControls();
  ctl.gearDown = false;
  ctl.throttle = 1;
  ctl.pitch = 0.75;
  const gun = new Gun(spec);
  gun.trigger = true;
  let d0: Vec3d | null = null;
  let axis = new Vec3d();
  let rate = 0;
  let fired = -1;
  let miss = Infinity;
  const load = m.telemetry.load;
  for (let k = 0; k < 3 / FLIGHT_STEP; k++) {
    if (!d0) {
      const pip = gunHud(m, { gun }, avionics, new Vec3d(), range)!;
      const toPip = new Vec3d(...pip.point).sub(m.pos);
      const nose = m.q.rotate(new Vec3d(1, 0, 0)).scale(range);
      const n = gun.step(m, m.spec.cg, FLIGHT_STEP, RADIUS, true);
      if (n > 0) {
        d0 = aim === 'pipper' ? toPip : nose;
        const w = m.q.rotate(m.omega);
        rate = w.length();
        axis = w.clone().scale(1 / rate);
        fired = k;
        gun.trigger = false;
        gun.live.splice(1);
      }
    } else {
      gun.step(m, m.spec.cg, FLIGHT_STEP, RADIUS, true);
      const r = gun.live[0];
      if (!r) break;
      // The target holds the shooter's turn: fixed in its turning frame.
      const target = m.pos.clone().add(rotate(d0, axis, rate * (k - fired) * FLIGHT_STEP));
      miss = Math.min(miss, r.pos.distanceTo(target));
    }
    m.step(ctl, ground);
  }
  return { miss, load };
}

describe('check 8: the gun pipper in a hard turn (decision 309)', () => {
  it('puts the rounds through a target holding the turn where the pipper sits', () => {
    for (const range of [400, PIPPER_RANGE, 900]) {
      const { miss, load } = shot(range, 'pipper');
      expect(load).toBeGreaterThan(5);
      // Within 10 mils of the range (1.5 m at 400 m, 3.5 m at 610 m, 7.5 m at 900 m today),
      // and a hit on a fighter at the pipper's range and closer. What is left grows with the
      // time of flight: the turn's rate rises as the speed bleeds, which a steady turn leaves out.
      expect(miss / range).toBeLessThan(0.01);
      if (range <= PIPPER_RANGE) expect(miss).toBeLessThan(AIRCRAFT_RADIUS);
    }
  });

  it('misses it by the lead when the nose is put on it instead', () => {
    // About 125 m: 200 mils.
    expect(shot(PIPPER_RANGE, 'nose').miss).toBeGreaterThan(4 * AIRCRAFT_RADIUS);
  });
});
