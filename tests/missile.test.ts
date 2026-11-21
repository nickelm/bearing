/** IR missiles: the seeker, the flight and the fuze (decision 297). */
import { describe, expect, it } from 'vitest';
import { Vec3d } from '../src/core/vec3d';
import { STORES } from '../src/sim/air/stores';
import { Missile, Seeker } from '../src/sim/flight/missile';
import type { HeatSource } from '../src/sim/flight/missile';

const R = 6_371_000;
const srm = STORES.srm!;
const up = new Vec3d(0, 0, 1);
const at = (x: number, y: number, h: number) => new Vec3d(x, y, R + h);

/** A source flying straight at `vel`, refreshed at time t. */
const source = (id: string, p0: Vec3d, vel: Vec3d, t: number): HeatSource => ({
  id,
  pos: p0.clone().addScaled(vel, t),
  vel,
  time: t,
});

function fly(target: (t: number) => HeatSource, launchVel = new Vec3d(250, 0, 0), id = 'bandit') {
  const m = new Missile(
    'srm',
    srm.missile!,
    srm.mass,
    srm.dragArea,
    at(0, 0, 5000),
    launchVel,
    id,
    'me',
    0,
  );
  let t = 0;
  let top = 0;
  while (m.state === 'flying' && t < 60) {
    m.step(1 / 120, t, R, [target(t)]);
    t += 1 / 120;
    top = Math.max(top, m.vel.length());
  }
  return { m, t, top };
}

describe('the seeker (decision 297)', () => {
  it('locks a source inside its cone and range, tracks it within its gimbal limit, and lets go', () => {
    const s = new Seeker(srm.missile!);
    const pos = at(0, 0, 5000);
    const fwd = new Vec3d(1, 0, 0);
    const ahead = source('a', at(3000, 60, 5000), new Vec3d(0, 0, 0), 0);
    s.update(pos, fwd, [ahead], 0);
    expect(s.target).toBe('a');
    // 30° off the nose: still inside the 40° gimbal.
    const off = source('a', at(3000, 1730, 5000), new Vec3d(0, 0, 0), 0);
    s.update(pos, fwd, [off], 0);
    expect(s.target).toBe('a');
    // 60° off: lost, and nothing in the cone about the boresight.
    s.update(pos, fwd, [source('a', at(1500, 2600, 5000), new Vec3d(), 0)], 0);
    expect(s.target).toBeNull();
    // Too far for a lock.
    s.update(pos, fwd, [source('a', at(20_000, 0, 5000), new Vec3d(), 0)], 0);
    expect(s.target).toBeNull();
    expect(up.length()).toBe(1);
  });
});

describe('the missile (decision 297)', () => {
  it('reaches about Mach 2.5 over the launcher and hits a crossing target at 3 km', () => {
    const { m, t, top } = fly((u) =>
      source('bandit', at(3000, -400, 5000), new Vec3d(0, 200, 0), u),
    );
    expect(m.state).toBe('hit');
    expect(m.burst!.distance).toBeLessThanOrEqual(srm.missile!.fuze);
    expect(t).toBeLessThan(6);
    expect(top).toBeGreaterThan(700);
    expect(top).toBeLessThan(1100);
  });

  it('hits a target turning away at 6 g within reach, and is spent against one far beyond it', () => {
    const g = 6 * 9.80665;
    const turning = (u: number): HeatSource => {
      // 250 m/s on a circle, starting 2.5 km ahead heading left.
      const w = g / 250;
      const c = at(2500, -250 / w, 5000);
      const a = w * u;
      return {
        id: 'bandit',
        pos: c.clone().add(new Vec3d((250 / w) * Math.sin(a), (250 / w) * Math.cos(a), 0)),
        vel: new Vec3d(250 * Math.cos(a), -250 * Math.sin(a), 0),
        time: u,
      };
    };
    expect(fly(turning).m.state).toBe('hit');
    const far = fly((u) => source('bandit', at(18_000, 0, 5000), new Vec3d(300, 0, 0), u));
    expect(far.m.state).toBe('spent');
  });

  it('flies on unguided without a target and never fuzes on its shooter', () => {
    const { m } = fly(
      (u) => source('me', at(250 * u + 5, 0, 5000), new Vec3d(250, 0, 0), u),
      undefined,
      '',
    );
    expect(m.state).toBe('spent');
  });
});

describe('missiles from the rack (decision 297)', () => {
  it('lock with the seeker, leave a station on launch and hit the target they were fired at', async () => {
    const { capMission, phaseStart, promote, seaLevel } = await import('./helpers/promoted');
    const { initialAvionics } = await import('../src/sim/avionics/avionics');
    const m = capMission();
    const t0 = phaseStart(m, 'on-target') + 100;
    const f = promote({ ...m, aircraft: 1 }, t0);
    const a = f.aircraft[0]!;
    const model = a.flown
      .airframe as unknown as import('../src/sim/flight/flightModel').FlightModel;
    const fwd = model.q.rotate(new Vec3d(1, 0, 0));
    // A bandit 3 km ahead, flying the same way at 200 m/s.
    const p0 = model.pos.clone().addScaled(fwd, 3000);
    const vel = fwd.clone().scale(200);
    const sources = (t: number) => [
      { id: 'bandit', pos: p0.clone().addScaled(vel, t - t0), vel, time: t },
    ];
    a.rack.sources = sources(t0);
    let av = { ...initialAvionics(false), masterArm: true, weapon: 'srm' };
    expect(a.rack.updateSeeker(model, av, t0)?.target).toBe('bandit');
    const shot = a.rack.launch(model, av, t0, 'me')!;
    expect(shot.target).toBe('bandit');
    expect(a.rack.counts.srm).toBe(3);
    expect(a.rack.state.expended.srm).toBe(1);
    let t = t0;
    while (a.rack.missiles.length > 0 && t < t0 + 20) {
      a.rack.sources = sources(t);
      a.rack.stepWeapons(model, av, 1 / 120, t, seaLevel);
      t += 1 / 120;
    }
    expect(a.rack.finished.map((x) => x.state)).toEqual(['hit']);
    // Safe, nothing leaves.
    av = { ...av, masterArm: false };
    expect(a.rack.launch(model, av, t, 'me')).toBeNull();
  });
});
