/**
 * A main rotor's downwash at the ground (decision 176): where the wake meets the
 * ground and how fast it spreads out there, for the ground cover's flattening
 * (G4) and later the dust, spray and snow it raises (G5, H3).
 *
 * - **Speed.** Momentum theory's induced velocity at the disc in a hover,
 *   v = √(T / 2ρA); the wake speeds up below the disc toward 2v and turns
 *   outward at the ground in a wall jet that peaks about one to two rotor radii
 *   from the axis at roughly v (Fradenburgh's and Leishman's measurements).
 *   OUTWASH × v stands in for that peak.
 * - **Height.** Near the ground the wash is at full strength up to a rotor
 *   radius of hub height, and fades out by FADE_DIAMETERS rotor diameters
 *   (the guide's "below about one and a half rotor diameters" plus a margin for
 *   the fade).
 * - **Where.** Along the disc's axis from the hub to the ground: a tilted disc
 *   moves the wash's center upstream of the helicopter's track, as in flight.
 *   Forward speed blows the wake behind and weakens it: the speed falls with
 *   the advance ratio (no ground vortex modeled).
 */
import { Vec3d } from '../../../core/vec3d';
import type { RotorcraftModel } from './rotorcraftModel';

/** Peak outwash at the ground per unit of hover induced velocity. */
export const OUTWASH = 1.1;
/** The wash is gone by this many rotor diameters of hub height. */
export const FADE_DIAMETERS = 1.75;

/** The downwash at the ground: center (planet-centered, m), outwash speed (m/s), rotor radius (m). */
export interface Downwash {
  center: Vec3d;
  speed: number;
  radius: number;
}

/**
 * The downwash of `h`'s main rotor at the ground, into `out`, or null when the
 * rotor is too high or carries no thrust.
 */
export function rotorDownwash(h: RotorcraftModel, out: Downwash): Downwash | null {
  const t = h.telemetry;
  const R = h.spec.main.radius;
  const thrust = Math.max(0, t.thrust);
  const rho = Math.max(0.05, t.air.density);
  if (!(thrust > 0)) return null;
  const v = Math.sqrt(thrust / (2 * rho * h.main.area));
  const height = Math.max(0, t.hubHeight);
  const fade = smooth(FADE_DIAMETERS * 2 * R, R, height);
  // Forward flight blows the wake behind and spreads it: weaker with the advance ratio.
  const forward = 1 / (1 + 25 * t.mu * t.mu);
  const speed = OUTWASH * v * fade * forward;
  if (!(speed > 0.05)) return null;
  const up = h.pos.clone().normalize();
  const hub = h.q.rotate(h.main.hub, new Vec3d()).add(h.pos);
  const n = h.q.rotate(h.discNormal(new Vec3d()), new Vec3d());
  // From the hub down the disc's axis to the ground (the wake leaves against the thrust).
  const c = Math.max(0.5, n.dot(up));
  out.center.copy(hub).addScaled(n, -height / c);
  out.speed = speed;
  out.radius = R;
  return out;
}

function smooth(e0: number, e1: number, x: number): number {
  const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return k * k * (3 - 2 * k);
}
