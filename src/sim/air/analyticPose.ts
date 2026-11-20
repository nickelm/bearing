/**
 * A followed flight's pose from its analytic route (roadmap R2.4): where the
 * aircraft is, which way its nose and its top point, and how fast it moves, for
 * the chase camera, the model and the read-only HUD while no flight model runs
 * (full fidelity is R2.5).
 *
 * Routes are great-circle legs that meet at corners, so the heading jumps at a
 * waypoint. The pose smooths it: heading (unwrapped) and climb are the means over
 * ±SMOOTH_WINDOW of the route, so a turn takes the window's time and the
 * aircraft banks into it by the coordinated-turn angle atan(v·ω/g), capped at
 * MAX_BANK. The speed is the mean over the same window, so it eases from leg to leg
 * rather than stepping (the chase camera and the HUD read it, decision 259). Pitch is the
 * flight-path angle. Position stays the route's, so the flight passes its waypoints exactly. The wingmen's slots are in formation.ts.
 *
 * Pure and deterministic: a pose depends on the route and the time only.
 */
import { headingTangent } from '../../core/greatCircle';
import type { Dir } from '../../core/greatCircle';
import { DEG } from '../../core/units';
import type { GameTime, Meters } from '../../core/units';
import type { MissionPhase } from './mission';
import { routeState } from './route';
import type { Route } from './route';

/** Half the time a turn or a change of climb is spread over (s). */
export const SMOOTH_WINDOW = 10;
export const SMOOTH_SAMPLES = 21;
export const MAX_BANK = 60 * DEG;
export const GRAVITY = 9.81;

export interface AnalyticPose {
  /** Position (world, m). */
  pos: [number, number, number];
  /** Unit vectors: nose, top, and velocity (m/s), in the world frame. */
  forward: Dir;
  up: Dir;
  velocity: [number, number, number];
  heading: number;
  pitch: number;
  bank: number;
  speed: number;
  /** Height above sea level (m) and climb rate (m/s). */
  altitude: Meters;
  climb: number;
  airborne: boolean;
  phase: MissionPhase;
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * Smoothed heading and speed at t: the weighted means over the window, each heading
 * unwrapped against the one before (a circular mean would cancel to nothing across a
 * reversal). The speed is smoothed too, since a route's speed steps from leg to leg.
 */
function sampled(route: Route, t: GameTime, radius: Meters): { heading: number; speed: number } {
  let sum = 0;
  let speed = 0;
  let weights = 0;
  let prev = 0;
  let unwrapped = 0;
  for (let i = 0; i < SMOOTH_SAMPLES; i++) {
    const u = (i / (SMOOTH_SAMPLES - 1)) * 2 - 1;
    const w = 1 - Math.abs(u) * 0.5;
    const s = routeState(route, t + u * SMOOTH_WINDOW, radius);
    const h = s.heading;
    unwrapped = i === 0 ? h : unwrapped + wrap(h - prev);
    prev = h;
    sum += w * unwrapped;
    speed += w * s.speed;
    weights += w;
  }
  return { heading: wrap(sum / weights), speed: speed / weights };
}

function sampledAltitude(route: Route, t: GameTime, radius: Meters): number {
  let s = 0;
  for (let i = 0; i < SMOOTH_SAMPLES; i++) {
    const u = (i / (SMOOTH_SAMPLES - 1)) * 2 - 1;
    s += routeState(route, t + u * SMOOTH_WINDOW, radius).altitude;
  }
  return s / SMOOTH_SAMPLES;
}

/** Spacing of the window's samples (s). */
const SAMPLE_STEP = (2 * SMOOTH_WINDOW) / (SMOOTH_SAMPLES - 1);

/**
 * The sampled means step as each sample crosses a corner; between whole sample
 * steps the pose interpolates them, so heading, speed and altitude change continuously.
 */
function smoothed(route: Route, t: GameTime, radius: Meters): { heading: number; speed: number } {
  const t0 = Math.floor(t / SAMPLE_STEP) * SAMPLE_STEP;
  const a = sampled(route, t0, radius);
  const b = sampled(route, t0 + SAMPLE_STEP, radius);
  const f = (t - t0) / SAMPLE_STEP;
  return {
    heading: wrap(a.heading + wrap(b.heading - a.heading) * f),
    speed: a.speed + (b.speed - a.speed) * f,
  };
}

function smoothedAltitude(route: Route, t: GameTime, radius: Meters): number {
  const t0 = Math.floor(t / SAMPLE_STEP) * SAMPLE_STEP;
  const a0 = sampledAltitude(route, t0, radius);
  return a0 + (sampledAltitude(route, t0 + SAMPLE_STEP, radius) - a0) * ((t - t0) / SAMPLE_STEP);
}

/** The flight's lead aircraft at game time t. */
export function analyticPose(route: Route, t: GameTime, radius: Meters): AnalyticPose {
  const s = routeState(route, t, radius);
  const dt = 0.5;
  const now = s.airborne ? smoothed(route, t, radius) : null;
  const heading = now ? now.heading : s.heading;
  const turn = s.airborne
    ? wrap(smoothed(route, t + dt, radius).heading - smoothed(route, t - dt, radius).heading) /
      (2 * dt)
    : 0;
  const climb = s.airborne
    ? (smoothedAltitude(route, t + dt, radius) - smoothedAltitude(route, t - dt, radius)) / (2 * dt)
    : 0;
  // Airborne, the speed eases from leg to leg as the heading does; on the ground it is the route's.
  const speed = now ? now.speed : s.speed;
  const pitch = speed > 1 ? Math.atan2(climb, speed) : 0;
  const bank = Math.max(-MAX_BANK, Math.min(MAX_BANK, Math.atan((speed * turn) / GRAVITY)));
  const p = s.point;
  const r = radius + Math.max(0, s.altitude);
  const pos: [number, number, number] = [p[0] * r, p[1] * r, p[2] * r];
  // The local frame: east-north tangent along the heading, and up.
  const t0 = headingTangent(p, heading);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const forward: Dir = [t0[0] * cp + p[0] * sp, t0[1] * cp + p[1] * sp, t0[2] * cp + p[2] * sp];
  const up0: Dir = [p[0] * cp - t0[0] * sp, p[1] * cp - t0[1] * sp, p[2] * cp - t0[2] * sp];
  // Right of the nose: forward × up.
  const right: Dir = [
    forward[1] * up0[2] - forward[2] * up0[1],
    forward[2] * up0[0] - forward[0] * up0[2],
    forward[0] * up0[1] - forward[1] * up0[0],
  ];
  // A right bank tips the top toward the right.
  const cb = Math.cos(bank);
  const sb = Math.sin(bank);
  const up: Dir = [
    up0[0] * cb + right[0] * sb,
    up0[1] * cb + right[1] * sb,
    up0[2] * cb + right[2] * sb,
  ];
  const velocity: [number, number, number] = [
    t0[0] * speed + p[0] * climb,
    t0[1] * speed + p[1] * climb,
    t0[2] * speed + p[2] * climb,
  ];
  return {
    pos,
    forward,
    up,
    velocity,
    heading,
    pitch,
    bank,
    speed,
    altitude: s.altitude,
    climb,
    airborne: s.airborne,
    phase: s.phase,
  };
}
