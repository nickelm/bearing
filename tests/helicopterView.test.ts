/**
 * The helicopter's presentation pieces that run without a browser (decision
 * 149, Proposal 0004, HUD and Camera): the chase rig's speed schedule and the
 * hover symbology's world-anchored points.
 */
import { describe, expect, it } from 'vitest';
import { DEG, KNOT } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { ChaseCamera, FAST_JET_RIG, helicopterRig } from '../src/render/sim/camera/chaseCamera';
import {
  HOVER_CUE_TIME,
  HOVER_VECTOR_MAX,
  HOVER_VECTOR_TIME,
  hoverSymbols,
  hoverVectorLength,
} from '../src/freeflight/hudFrame';
import { hoverDistance } from '../src/ui/flight/hud';

const R = 1_000_000;
const ROTOR = 7.3;

/** Angle (deg) between two directions. */
const angle = (a: Vec3d, b: Vec3d) =>
  Math.acos(Math.max(-1, Math.min(1, a.clone().normalize().dot(b.clone().normalize())))) / DEG;

describe('helicopter chase rig', () => {
  /** A helicopter 5 m over flat ground at height 0, nose north (+Y) at the point (0, 0, R). */
  function camera(speed = 0, pitch = 0) {
    const c = new ChaseCamera(R, helicopterRig(ROTOR));
    c.groundAt = () => 0;
    const t = c.target;
    t.pos.set(0, 0, R + 5);
    t.forward.set(0, Math.cos(pitch), Math.sin(pitch));
    t.up.set(0, -Math.sin(pitch), Math.cos(pitch));
    t.velocity.set(0, speed, 0);
    t.onGround = false;
    return c;
  }
  const settle = (c: ChaseCamera, seconds = 4) => {
    for (let i = 0; i < seconds * 60; i++) c.update(1 / 60);
  };
  /** Degrees the camera looks below the horizontal. */
  const lookDown = (c: ChaseCamera) => -Math.asin(c.forward.dot(c.eye.clone().normalize())) / DEG;

  it('scales with the rotor and sits closer in its own size and higher than the jet', () => {
    const rig = helicopterRig(ROTOR);
    expect(rig.distance).toBeCloseTo(2.2 * ROTOR + 6, 9);
    expect(rig.height).toBeCloseTo(0.45 * rig.distance, 9);
    expect(rig.distance / ROTOR).toBeLessThan(FAST_JET_RIG.distance / 4.7);
    expect(rig.height).toBeGreaterThan(FAST_JET_RIG.height);
    expect(helicopterRig(2 * ROTOR).distance).toBeGreaterThan(rig.distance);
  });

  it('looks 25–35° down in the hover, keeping the helicopter, its ground point and the ground ahead in view', () => {
    // Nose 8° up, as when decelerating into the hover.
    const c = camera(0, 8 * DEG);
    settle(c);
    expect(lookDown(c)).toBeGreaterThan(25);
    expect(lookDown(c)).toBeLessThan(35);
    const half = c.fov / 2 / DEG;
    const ground = new Vec3d(0, 0, R);
    const ahead = new Vec3d(0, 30, R);
    for (const p of [c.target.pos, ground, ahead])
      expect(angle(p.clone().sub(c.eye), c.forward)).toBeLessThan(half - 3);
    // The frame follows the heading, not the nose's pitch: the camera's right is level.
    const right = c.forward.clone().cross(c.up);
    expect(Math.abs(right.dot(c.eye.clone().normalize()))).toBeLessThan(1e-6);
    expect(Math.abs(c.forward.x)).toBeLessThan(1e-6);
    // Lifted: the eye is higher above the helicopter than in cruise.
    expect(c.eye.length() - c.target.pos.length()).toBeGreaterThan(0.7 * c.rig.distance);
  });

  it('flies the cruise pose above 40 kt, looking about 13° down from behind', () => {
    const c = camera(60, -5 * DEG);
    settle(c);
    expect(lookDown(c)).toBeGreaterThan(8);
    expect(lookDown(c)).toBeLessThan(18);
    const rel = c.eye.clone().sub(c.target.pos);
    const rig = c.rig;
    expect(-rel.y).toBeGreaterThan(rig.distance - 1);
    expect(-rel.y).toBeLessThan(rig.distance + 3);
    expect(rel.z).toBeGreaterThan(rig.height - 1.5);
    expect(rel.z).toBeLessThan(rig.height + 1.5);
    const toAircraft = c.target.pos.clone().sub(c.eye);
    expect(angle(toAircraft, c.forward)).toBeLessThan(15);
  });

  it('blends smoothly between the hover and cruise poses', () => {
    const rig = helicopterRig(ROTOR);
    const s = rig.hover!;
    expect(ChaseCamera.hoverWeight(s, 0)).toBe(1);
    expect(ChaseCamera.hoverWeight(s, 10 * KNOT)).toBe(1);
    expect(ChaseCamera.hoverWeight(s, 40 * KNOT)).toBe(0);
    let last = 1;
    for (let v = 0; v <= 50 * KNOT; v += 0.05) {
      const w = ChaseCamera.hoverWeight(s, v);
      expect(w).toBeLessThanOrEqual(last);
      expect(last - w).toBeLessThan(0.006);
      last = w;
    }
    // Accelerate from the hover to 50 kt over 30 s: no jumps in the eye or the view.
    const c = camera();
    settle(c, 2);
    let eye = c.eye.clone().sub(c.target.pos);
    let fwd = c.forward.clone();
    let maxStep = 0;
    let maxTurn = 0;
    for (let i = 0; i < 30 * 60; i++) {
      c.target.velocity.set(0, (50 * KNOT * i) / (30 * 60), 0);
      c.update(1 / 60);
      const e = c.eye.clone().sub(c.target.pos);
      maxStep = Math.max(maxStep, e.distanceTo(eye));
      maxTurn = Math.max(maxTurn, angle(c.forward, fwd));
      eye = e;
      fwd = c.forward.clone();
    }
    expect(maxStep).toBeLessThan(0.05);
    expect(maxTurn).toBeLessThan(0.2);
    expect(lookDown(c)).toBeLessThan(18);
  });

  it('follows the heading in the hover, ignoring a noisy velocity', () => {
    const c = camera();
    settle(c, 1);
    let seed = 7;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.8;
    let worst = 0;
    for (let i = 0; i < 240; i++) {
      c.target.velocity.set(noise(), noise(), noise() * 0.3);
      c.update(1 / 60);
      const h = c.forward.clone().addScaled(new Vec3d(0, 0, 1), -c.forward.z);
      worst = Math.max(worst, angle(h, new Vec3d(0, 1, 0)));
    }
    expect(worst).toBeLessThan(0.5);
    // A pedal turn to the east: the camera swings round behind.
    c.target.forward.set(1, 0, 0);
    c.target.up.set(0, 0, 1);
    settle(c, 3);
    const h = c.forward.clone().addScaled(new Vec3d(0, 0, 1), -c.forward.z);
    expect(angle(h, new Vec3d(1, 0, 0))).toBeLessThan(1);
  });

  it('keeps free look where it is left in the hover and orbits with the helicopter in view', () => {
    const c = camera();
    settle(c, 1);
    c.lookHeld = true;
    c.look(1, 0, 150 * DEG);
    c.update(1 / 60);
    c.lookHeld = false;
    settle(c, 3);
    expect(c.lookYaw).toBeCloseTo(150 * DEG, 9);
    // The eye is now in front of and to the side of the helicopter, still looking at it.
    const rel = c.eye.clone().sub(c.target.pos);
    expect(rel.y).toBeGreaterThan(5);
    expect(angle(c.target.pos.clone().sub(c.eye), c.forward)).toBeLessThan(15);
    // Speeding up past 25 kt springs it back.
    c.target.velocity.set(0, 30 * KNOT, 0);
    settle(c, 2);
    expect(Math.abs(c.lookYaw)).toBeLessThan(0.01);
  });

  it('springs free look back in cruise, as for jets', () => {
    const c = camera(60);
    settle(c, 1);
    c.lookHeld = true;
    c.look(1, 0, 90 * DEG);
    c.update(1 / 60);
    c.lookHeld = false;
    settle(c, 2);
    expect(Math.abs(c.lookYaw)).toBeLessThan(0.01);
  });

  it('takes the hover pose on the ground', () => {
    const c = camera();
    c.target.pos.set(0, 0, R + 1.2);
    c.target.onGround = true;
    settle(c);
    expect(lookDown(c)).toBeGreaterThan(25);
    expect(c.eye.length() - c.target.pos.length()).toBeGreaterThan(0.7 * c.rig.distance);
  });

  it('looks further down in a higher hover, keeping the ground point in view', () => {
    const half = (c: ChaseCamera) => c.fov / 2 / DEG;
    for (const height of [5, 20, 35]) {
      const c = camera();
      c.target.pos.set(0, 0, R + height);
      settle(c);
      const ground = new Vec3d(0, 0, R).sub(c.eye);
      expect(angle(ground, c.forward), `${height} m`).toBeLessThan(half(c) - 2);
      expect(angle(c.target.pos.clone().sub(c.eye), c.forward)).toBeLessThan(half(c) - 2);
      expect(lookDown(c)).toBeLessThan(45);
    }
  });
});

describe('hover symbology', () => {
  // A helicopter 6 m over ground at 100 m, at (0, 0, R + 106), nose east (+X).
  const pos = new Vec3d(0, 0, R + 106);
  const forward = new Vec3d(Math.cos(5 * DEG), 0, Math.sin(5 * DEG));
  const eye = new Vec3d(-20, 3, R + 125);
  const base = {
    pos,
    forward,
    eye,
    radius: R,
    groundHeight: 100,
    velocity: new Vec3d(),
    accel: new Vec3d(),
    torque: 0.62,
    rotorRpm: 1.01,
  };

  it('puts the ground point under the aircraft, relative to the eye', () => {
    const h = hoverSymbols({ ...base, gearHeight: 1.5 });
    const g = h.groundPoint.clone().add(eye);
    expect(g.x).toBeCloseTo(0, 9);
    expect(g.y).toBeCloseTo(0, 9);
    expect(g.z).toBeCloseTo(R + 100, 6);
    expect(h.radarAltitude).toBeCloseTo(4.5, 6);
    // No motion: the vector and the cue sit on the ground point.
    expect(h.velocityTip.distanceTo(h.groundPoint)).toBeLessThan(1e-9);
    expect(h.accelTip.distanceTo(h.groundPoint)).toBeLessThan(1e-9);
  });

  it('resolves velocity and acceleration in the heading frame (+ forward, + right)', () => {
    // East is forward; north (+Y) is left of an east heading at (0, 0, R).
    const h = hoverSymbols({
      ...base,
      velocity: new Vec3d(2, 1, -0.5),
      accel: new Vec3d(0, -0.4, 0),
    });
    expect(h.velocity.forward).toBeCloseTo(2, 9);
    expect(h.velocity.right).toBeCloseTo(-1, 9);
    expect(h.accel.forward).toBeCloseTo(0, 9);
    expect(h.accel.right).toBeCloseTo(0.4, 9);
    expect(h.verticalSpeed).toBeCloseTo(-0.5, 9);
  });

  it('lays the vector and the cue on the ground plane, scaled and softly limited', () => {
    const v = new Vec3d(1.5, -1, 0.7);
    const a = new Vec3d(-0.5, 0.2, 0);
    const h = hoverSymbols({ ...base, velocity: v, accel: a });
    const g = h.groundPoint.clone().add(eye);
    const tip = h.velocityTip.clone().add(eye);
    const cue = h.accelTip.clone().add(eye);
    const up = pos.clone().normalize();
    // On the tangent plane through the ground point.
    expect(Math.abs(tip.clone().sub(g).dot(up))).toBeLessThan(1e-6);
    expect(Math.abs(cue.clone().sub(g).dot(up))).toBeLessThan(1e-6);
    // Along the horizontal velocity, at the scale's length.
    const vh = v.clone().addScaled(up, -v.dot(up));
    const d = tip.clone().sub(g);
    expect(angle(d, vh)).toBeLessThan(1e-6);
    expect(d.length()).toBeCloseTo(hoverVectorLength(vh.length()), 9);
    // The cue marks the velocity HOVER_CUE_TIME s ahead.
    const ahead = vh.clone().addScaled(a, HOVER_CUE_TIME);
    expect(angle(cue.clone().sub(g), ahead)).toBeLessThan(1e-6);
    // Small drifts scale linearly; fast ones approach the limit.
    expect(hoverVectorLength(0.5)).toBeCloseTo(0.5 * HOVER_VECTOR_TIME, 1);
    expect(hoverVectorLength(60)).toBeLessThan(HOVER_VECTOR_MAX);
    expect(hoverVectorLength(60)).toBeGreaterThan(0.99 * HOVER_VECTOR_MAX);
  });

  it('gives the landing zone a horizontal distance and a bearing off the nose (+ right)', () => {
    // 300 m east and 400 m south of the aircraft, on the ground: ahead and to the right.
    const lz = new Vec3d(300, -400, R + 100);
    const h = hoverSymbols({ ...base, lz });
    expect(h.lz!.distance).toBeCloseTo(500, 0);
    expect(h.lz!.bearing / DEG).toBeCloseTo(Math.atan2(400, 300) / DEG, 1);
    expect(h.lz!.point.clone().add(eye).distanceTo(lz)).toBeLessThan(1e-6);
    expect(hoverSymbols({ ...base, lz: new Vec3d(0, 200, R + 100) }).lz!.bearing / DEG).toBeCloseTo(
      -90,
      1,
    );
    expect(hoverSymbols(base).lz).toBeNull();
  });

  it('formats landing zone distances in feet close in and nautical miles beyond', () => {
    expect(hoverDistance(100)).toBe('330 FT');
    expect(hoverDistance(2000)).toBe('1.1 NM');
    expect(hoverDistance(40_000)).toBe('22 NM');
  });
});
