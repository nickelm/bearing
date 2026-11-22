/**
 * One puff's motion over a step (Proposal 0011, decision 321): the TypeScript reference of
 * the compute pass's update kernel (`puffCompute.ts`), line for line, so tests can check
 * the forces here and the GPU against this.
 *
 * - **Forces.** The puff's velocity relaxes at its look's `drag` rate toward a target: the
 *   wind it takes (weaker near the ground) plus its rise speed along the local up, times
 *   the rise curve. Buoyancy is the rise term, drag the relaxation, and a small turbulent
 *   acceleration, a smooth function of the puff's seed, the time and where it is, keeps
 *   columns from rising as rods. A puff thrown out fast (an explosion's) slows to the air's
 *   motion within a second or two.
 * - **The ground.** A puff never sinks more than halfway into the ground it was born over
 *   (`floor`, its distance from the planet's center there).
 * - **Curves.** Radius, color, glow and coverage come from the look's curves at the puff's
 *   share of its life.
 * - **Floating origin.** Positions are relative to the pool's anchor; `shift` (the old
 *   anchor minus the new, computed in float64) moves every puff when the anchor moves.
 */
import { readTable } from './curves';

/** Rows per look in the motion table (`lookMotion`). */
export const MOTION_ROWS = 2;

export interface PuffState {
  /** Position relative to the anchor (m). */
  pos: [number, number, number];
  vel: [number, number, number];
  age: number;
  life: number;
  look: number;
  /** Base radius (m). */
  size: number;
  seed: number;
  /** Distance from the planet's center of the ground below the puff's birth (m). */
  floor: number;
  /** Multiplies the look's color (the ground's own color for downwash dust). */
  tint: [number, number, number];
  // Written by the step:
  radius: number;
  color: [number, number, number];
  glow: number;
  coverage: number;
}

export interface PuffEnv {
  dt: number;
  /** Effect clock (s). */
  time: number;
  /** Wind aloft (world, m/s). */
  wind: readonly [number, number, number];
  /** The anchor (world, m), as float32 holds it. */
  anchor: readonly [number, number, number];
  /** Old anchor minus new (m); zero most frames. */
  shift: readonly [number, number, number];
}

/** A puff's own drift (m/s) per unit of its look's turbulence (m/s²): the column's cone. */
export const FAN = 0.6;
/** Height (m) over which the wind grows from its share at the ground to its full value. */
export const SHEAR_HEIGHT = 400;
/** Share of the wind at the ground. */
export const GROUND_WIND = 0.55;
/** A puff's center stays at least this share of its radius above the ground: half sunk at most. */
export const SINK = 0;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * A puff's own drift direction, from its seed alone: added to its target velocity times the
 * look's turbulence, it fans a column out into a cone, so its outline is lumpy, not a tube.
 */
export function fan(seed: number): [number, number, number] {
  return [Math.sin(seed * 1.713 + 0.5), Math.sin(seed * 2.917 + 1.3), Math.sin(seed * 4.331 + 2.1)];
}

/** Turbulent acceleration direction (unit-ish), a smooth function of seed, time and place. */
export function turbulence(
  seed: number,
  time: number,
  p: readonly [number, number, number],
): [number, number, number] {
  return [
    Math.sin(seed * 12.9898 + time * 0.9 + p[1] * 0.013),
    Math.sin(seed * 7.233 + time * 0.7 + p[2] * 0.011),
    Math.sin(seed * 3.137 + time * 1.1 + p[0] * 0.017),
  ];
}

/** Advances one live puff by `env.dt`; marks a dead one (radius and coverage 0). */
export function stepPuff(
  s: PuffState,
  env: PuffEnv,
  curves: Float32Array,
  motion: Float32Array,
): void {
  for (let i = 0; i < 3; i++) s.pos[i]! += env.shift[i]!;
  if (s.age >= s.life) {
    s.radius = 0;
    s.coverage = 0;
    return;
  }
  const dt = env.dt;
  s.age += dt;
  const t = Math.min(1, s.age / s.life);
  const m = s.look * MOTION_ROWS * 4;
  const riseSpeed = motion[m]!;
  const drag = motion[m + 1]!;
  const turb = motion[m + 2]!;
  const windShare = motion[m + 3]!;
  const row0 = readTable(curves, s.look, t, 0);
  const row1 = readTable(curves, s.look, t, 1);
  const w = [s.pos[0] + env.anchor[0], s.pos[1] + env.anchor[1], s.pos[2] + env.anchor[2]];
  const dist = Math.hypot(w[0]!, w[1]!, w[2]!);
  const up = [w[0]! / dist, w[1]! / dist, w[2]! / dist];
  const height = dist - s.floor;
  const shear = GROUND_WIND + (1 - GROUND_WIND) * smooth(0, SHEAR_HEIGHT, height);
  const n = turbulence(s.seed, env.time, s.pos);
  const d = fan(s.seed);
  const k = Math.min(1, drag * dt);
  for (let i = 0; i < 3; i++) {
    const target =
      env.wind[i]! * windShare * shear + up[i]! * riseSpeed * row1[2] + d[i]! * turb * FAN;
    s.vel[i]! += (target - s.vel[i]!) * k + n[i]! * turb * dt;
    s.pos[i]! += s.vel[i]! * dt;
  }
  s.radius = s.size * row1[0];
  // Never more than halfway into the ground it was born over.
  const h2 = height + (s.vel[0]! * up[0]! + s.vel[1]! * up[1]! + s.vel[2]! * up[2]!) * dt;
  const least = s.radius * SINK;
  if (h2 < least) {
    const lift = least - h2;
    for (let i = 0; i < 3; i++) s.pos[i]! += up[i]! * lift;
    const into = Math.min(0, s.vel[0]! * up[0]! + s.vel[1]! * up[1]! + s.vel[2]! * up[2]!);
    for (let i = 0; i < 3; i++) s.vel[i]! -= up[i]! * into;
  }
  s.color = [row0[0] * s.tint[0], row0[1] * s.tint[1], row0[2] * s.tint[2]];
  s.glow = row0[3];
  s.coverage = s.age >= s.life ? 0 : row1[1];
}
