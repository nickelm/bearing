/** The main rotor's downwash at the ground (decision 176). */
import { describe, expect, it } from 'vitest';
import { Vec3d } from '../src/core/vec3d';
import { FLIGHT_STEP } from '../src/sim/flight/rigidBody';
import { runwayEnds, runwayFrame, runwayPoint } from '../src/sim/flight/runway';
import { assistsFor } from '../src/sim/flight/rotor/assists';
import { FADE_DIAMETERS, OUTWASH, rotorDownwash } from '../src/sim/flight/rotor/downwash';
import type { Downwash } from '../src/sim/flight/rotor/downwash';
import { HeloLaws, neutralCommand } from '../src/sim/flight/rotor/heloLaws';
import { neutralRotorControls } from '../src/sim/flight/rotor/rotorcraftModel';
import type { RotorcraftModel } from '../src/sim/flight/rotor/rotorcraftModel';
import { flatGround, RADIUS, testRunway } from './helpers/flight';
import { scout, utility } from './helpers/rotor';

const runway = testRunway();
const ground = flatGround(runway);
const end = runwayEnds(runway)[0];
const frame = runwayFrame(runway);

/** `m` held in a hover `height` m over flat ground for `seconds`. */
function hover(m: RotorcraftModel, height: number, seconds = 15): void {
  m.place(runwayPoint(runway, frame, 0, 100, height, RADIUS), new Vec3d(), end.heading, 0);
  m.updateAttitude(ground);
  const laws = new HeloLaws();
  laws.reset(m, false);
  const a = assistsFor('assisted');
  const cmd = neutralCommand();
  const ctl = neutralRotorControls();
  for (let i = 0; i < seconds / FLIGHT_STEP && !m.crashed; i++) {
    Object.assign(cmd, neutralCommand());
    cmd.toggleHover = i === 0;
    laws.update(m, cmd, a, FLIGHT_STEP, ctl);
    m.step(ctl, ground);
  }
}

const fresh = (): Downwash => ({ center: new Vec3d(), speed: 0, radius: 0 });

describe('rotor downwash (decision 176)', () => {
  it('spreads at about the hover induced velocity under a low hover, centered under the hub', () => {
    for (const make of [scout, utility]) {
      const m = make();
      hover(m, 3);
      expect(m.crashed).toBeNull();
      const w = rotorDownwash(m, fresh());
      expect(w).not.toBeNull();
      const t = m.telemetry;
      const v = Math.sqrt(t.thrust / (2 * t.air.density * Math.PI * m.spec.main.radius ** 2));
      expect(w!.speed).toBeGreaterThan(0.7 * OUTWASH * v);
      expect(w!.speed).toBeLessThanOrEqual(OUTWASH * v + 1e-9);
      expect(w!.radius).toBe(m.spec.main.radius);
      // On the ground, within a couple of meters of the point under the helicopter.
      const below = m.pos.clone().normalize().scale(w!.center.length());
      expect(w!.center.distanceTo(below)).toBeLessThan(2);
      expect(ground.height(w!.center.clone().normalize())).toBeCloseTo(
        w!.center.length() - RADIUS,
        0,
      );
    }
  });

  it('weakens with height and is gone above the fade', () => {
    const low = scout();
    hover(low, 3);
    const mid = scout();
    hover(mid, 9);
    const a = rotorDownwash(low, fresh())!;
    const b = rotorDownwash(mid, fresh());
    expect(b === null || b.speed < a.speed).toBe(true);
    const high = scout();
    hover(high, FADE_DIAMETERS * 2 * high.spec.main.radius + 10);
    expect(rotorDownwash(high, fresh())).toBeNull();
  });

  it('blows harder under a heavier helicopter', () => {
    const s = scout();
    hover(s, 3);
    const u = utility();
    hover(u, 3);
    expect(rotorDownwash(u, fresh())!.speed).toBeGreaterThan(rotorDownwash(s, fresh())!.speed);
  });
});
