/**
 * Free Flight's presentation pieces that run without a browser (decision 134):
 * the throttle detents, the chase camera, and the animated aircraft model.
 */
import { describe, expect, it } from 'vitest';
import { DEG } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { AB_GATE, MIL_DETENT } from '../src/sim/flight/controlLaws';
import { throttleStep } from '../src/ui/flight/flightInput';
import { ChaseCamera } from '../src/render/sim/camera/chaseCamera';
import { buildAnimatedModel, buildModel } from '../src/render/common/models/builder';
import { validateSpec } from '../src/render/common/models/spec';
import specJson from '../src/render/common/models/specs/alliance-fighter.json';

describe('throttle detents', () => {
  /** Holds a throttle key for `seconds` at 0.45/s from `lever`. */
  const hold = (lever: number, dir: 1 | -1, seconds: number) => {
    let s: { lever: number; stoppedAt: number | null } = { lever, stoppedAt: null };
    for (let t = 0; t < seconds; t += 0.01) s = throttleStep(s.lever, dir, 0.0045, s.stoppedAt);
    return s.lever;
  };

  it('stops at military on the way up, and a new press lights the afterburner', () => {
    const a = hold(0, 1, 5);
    expect(a).toBe(MIL_DETENT);
    const b = hold(a, 1, 0.05);
    expect(b).toBeGreaterThanOrEqual(AB_GATE);
    expect(hold(b, 1, 5)).toBe(1);
  });

  it('stops at the afterburner gate and military on the way down, then at idle', () => {
    const a = hold(1, -1, 5);
    expect(a).toBe(AB_GATE);
    const b = hold(a, -1, 5);
    expect(b).toBe(MIL_DETENT);
    expect(hold(b, -1, 5)).toBe(0);
  });

  it('never rests between military and the afterburner gate', () => {
    for (const from of [0.79, 0.8, 0.81, 0.82, 0.83])
      for (const dir of [1, -1] as const) {
        const r = throttleStep(from, dir, 0.004, null).lever;
        expect(r > MIL_DETENT && r < AB_GATE, `${from} ${dir}`).toBe(false);
      }
  });
});

describe('chase camera', () => {
  const R = 1_000_000;

  function camera(ground: number | null = 0) {
    const c = new ChaseCamera(R);
    c.groundAt = ground === null ? null : () => ground;
    const t = c.target;
    t.pos.set(0, 0, R + 500);
    t.forward.set(1, 0, 0);
    t.up.set(0, 0, 1);
    t.velocity.set(150, 0, 0);
    t.onGround = false;
    return c;
  }

  it('sits behind and above the aircraft and looks at it', () => {
    const c = camera();
    c.update(1 / 60);
    const rel = c.eye.clone().sub(c.target.pos);
    expect(rel.x).toBeLessThan(-15);
    expect(rel.z).toBeGreaterThan(2);
    // The aircraft is near the center of the view: within 10° of the forward axis.
    const toAircraft = c.target.pos.clone().sub(c.eye).normalize();
    expect(Math.acos(toAircraft.dot(c.forward)) / DEG).toBeLessThan(10);
  });

  it('lags a sudden roll and settles within about a second, keeping the aircraft centered', () => {
    const c = camera();
    for (let i = 0; i < 60; i++) c.update(1 / 60);
    // Roll 90° right at once.
    c.target.up.set(0, -1, 0);
    c.update(1 / 60);
    const early = c.up.clone();
    let maxOff = 0;
    for (let i = 0; i < 90; i++) {
      c.update(1 / 60);
      const toAircraft = c.target.pos.clone().sub(c.eye).normalize();
      maxOff = Math.max(maxOff, Math.acos(Math.min(1, toAircraft.dot(c.forward))) / DEG);
    }
    // At first the camera's up still points mostly at the old up (lag).
    expect(early.z).toBeGreaterThan(0.8);
    // After 1.5 s it has followed most of the way (it leans a third toward the vertical).
    expect(c.up.y).toBeLessThan(-0.6);
    expect(maxOff).toBeLessThan(12);
  });

  it('never goes below the ground, and lowers and closes in on the ground', () => {
    const c = camera(480);
    c.target.pos.set(0, 0, R + 481.5);
    c.target.onGround = true;
    c.target.velocity.set(0, 0, 0);
    for (let i = 0; i < 120; i++) c.update(1 / 60);
    expect(c.eye.length() - R).toBeGreaterThanOrEqual(480 + 1.5 - 1e-6);
    const d = c.eye.distanceTo(c.target.pos);
    expect(d).toBeLessThan(17);
    // Free look straight down still keeps the eye above the ground.
    c.lookHeld = true;
    c.look(0, -5000, 0.001);
    for (let i = 0; i < 30; i++) c.update(1 / 60);
    expect(c.eye.length() - R).toBeGreaterThanOrEqual(481.5 - 1e-6);
  });

  it('keeps the flight path visible above the aircraft at approach angle of attack', () => {
    const c = camera();
    // Nose 12° above a 3° descent: the runway lies along the velocity.
    const a = 12 * DEG;
    const g = -3 * DEG;
    c.target.velocity.set(75 * Math.cos(g), 0, 75 * Math.sin(g));
    c.target.forward.set(Math.cos(g + a), 0, Math.sin(g + a));
    c.target.up.set(-Math.sin(g + a), 0, Math.cos(g + a));
    for (let i = 0; i < 180; i++) c.update(1 / 60);
    // Screen elevation of a direction: its angle above the camera's forward, along its up.
    const elev = (d: Vec3d) => Math.atan2(d.dot(c.up), d.dot(c.forward)) / DEG;
    const path = c.target.velocity.clone().normalize();
    const aircraft = c.target.pos.clone().sub(c.eye).normalize();
    expect(elev(path)).toBeGreaterThan(elev(aircraft) + 8);
    expect(elev(path)).toBeLessThan(15);
    expect(elev(aircraft)).toBeGreaterThan(-20);
  });

  it('springs back from free look when released', () => {
    const c = camera();
    c.lookHeld = true;
    c.look(500, 0, 0.003);
    c.update(1 / 60);
    expect(Math.abs(c.lookYaw)).toBeGreaterThan(1);
    c.lookHeld = false;
    for (let i = 0; i < 120; i++) c.update(1 / 60);
    expect(Math.abs(c.lookYaw)).toBeLessThan(0.01);
  });

  it('keeps a far plane past the horizon', () => {
    const c = camera();
    c.terrainMaxHeight = 4000;
    c.update(1 / 60);
    // Horizon at 500 m on a 1,000 km planet: about 32 km, plus 4 km peaks' 89 km.
    expect(c.far).toBeGreaterThan(110_000);
    void Vec3d;
  });
});

describe('animated aircraft model', () => {
  const spec = validateSpec(specJson, 'alliance-fighter');

  it('splits into a body and hinged pieces with the same triangles as the whole model', () => {
    const whole = buildModel(spec);
    const a = buildAnimatedModel(spec);
    const n = a.body.triangles + a.pieces.reduce((s, p) => s + p.model.triangles, 0);
    expect(n).toBe(whole.triangles);
    const channels = new Set(a.pieces.map((p) => p.channel));
    for (const c of ['stabilator', 'flaperon', 'rudder', 'speedbrake', 'gear'])
      expect(channels.has(c as never), c).toBe(true);
    // Mirrored pieces sit on the other side with a mirrored hinge.
    const left = a.pieces.find((p) => p.channel === 'stabilator' && p.side === -1)!;
    const right = a.pieces.find((p) => p.channel === 'stabilator' && p.side === 1)!;
    expect(left.origin[2]).toBeCloseTo(-right.origin[2], 9);
    expect(left.model.bounds.max[2]).toBeCloseTo(-right.model.bounds.min[2], 5);
  });

  it('puts the extended wheels where the flight model has them', () => {
    const a = buildAnimatedModel(spec);
    const tires = a.pieces.filter((p) => p.channel === 'gear');
    const bottom = Math.min(...tires.map((p) => p.model.bounds.min[1]));
    const flight = (specJson as { flight: { gear: { wheels: { at: number[] }[] } } }).flight;
    expect(bottom).toBeCloseTo(flight.gear.wheels[0]!.at[1]!, 1);
  });
});
