/**
 * A terrain floor under analytic routes (roadmap R1.6): route altitudes are
 * above sea level and change linearly along each leg, so a low-level leg at
 * 100 m flew through any hill on its way. With a terrain source, `floorRoute`
 * keeps every airborne point at least the aircraft's clearance above the ground:
 *
 * - **Legs** are cut into pieces of FLOOR_STEP; each piece's ends rise to the
 *   highest ground (plus clearance) sampled every SAMPLE_STEP along the pieces
 *   on either side, so the straight line between them clears both. Pieces that
 *   needed nothing merge back into one leg.
 * - **Orbits** rise whole to the highest ground under their racetrack.
 * - **Ground segments** stand at the ground's height (a field above the sea).
 * - The clearance shrinks to zero within GROUND_RAMP of a takeoff or landing
 *   point, where the flight meets the field.
 * - Neighboring segments share their end altitudes (the higher one wins).
 *
 * Times, speeds and fuel do not change: only altitudes and the number of
 * segments. The coarse ground is smoother than the drawn one, so the source
 * should be conservative (`globalMaxSampler`: the highest of the cells around
 * a point).
 */
import { arcDistance, slerp } from '../../core/greatCircle';
import type { Dir } from '../../core/greatCircle';
import type { Meters } from '../../core/units';
import type { AircraftType } from './aircraft';
import { orbitPoint, perimeter } from './route';
import type { Route, RouteSegment } from './route';

/** Ground height (m above the sea, 0 over water) under a unit direction. */
export type GroundSource = (d: Readonly<Dir>) => number;

export const FLOOR_STEP: Meters = 5e3;
export const SAMPLE_STEP: Meters = 1e3;
export const GROUND_RAMP: Meters = 4e3;
/** Points sampled around an orbit's racetrack. */
const ORBIT_SAMPLES = 64;

/** Clearance above the ground (m): the old low-level altitudes, now above the ground. */
export function clearanceFor(t: AircraftType): Meters {
  return t.helicopter ? 30 : 100;
}

/** The route with a terrain floor; the input is not changed. */
export function floorRoute(
  route: Route,
  ground: GroundSource,
  clearance: Meters,
  R: Meters,
): Route {
  const fields = route.segments.filter((s) => s.kind === 'ground').map((s) => s.a);
  const need = (p: Readonly<Dir>): number => {
    let near = Infinity;
    for (const f of fields) near = Math.min(near, arcDistance(p, f, R));
    return Math.max(0, ground(p)) + clearance * Math.min(1, near / GROUND_RAMP);
  };
  const out: RouteSegment[] = [];
  for (const s of route.segments) {
    if (s.kind === 'ground') {
      const h = Math.max(0, ground(s.a));
      out.push({ ...s, a: [...s.a], b: [...s.b], alt0: h, alt1: h });
    } else if (s.kind === 'orbit') {
      let h = s.alt0;
      const P = perimeter(s.turn);
      for (let k = 0; k < ORBIT_SAMPLES; k++) {
        h = Math.max(h, need(orbitPoint(s.a, s.b, s.turn, (P * k) / ORBIT_SAMPLES, R).point));
      }
      out.push({ ...s, a: [...s.a], b: [...s.b], alt0: h, alt1: h });
    } else {
      out.push(...floorLeg(s, need, R));
    }
  }
  // Shared ends: the higher wins (a raised orbit lifts the end of the leg into it).
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let i = 0; i + 1 < out.length; i++) {
      const a = out[i]!;
      const b = out[i + 1]!;
      if (a.kind === 'ground' || b.kind === 'ground' || a.alt1 === b.alt0) continue;
      const h = Math.max(a.alt1, b.alt0);
      if (a.alt1 < h) {
        a.alt1 = h;
        if (a.kind === 'orbit') a.alt0 = h;
      }
      if (b.alt0 < h) {
        b.alt0 = h;
        if (b.kind === 'orbit') b.alt1 = h;
      }
      changed = true;
    }
    if (!changed) break;
  }
  return { ...route, segments: out };
}

function floorLeg(s: RouteSegment, need: (p: Readonly<Dir>) => number, R: Meters): RouteSegment[] {
  const d = arcDistance(s.a, s.b, R);
  const m = Math.max(1, Math.ceil(d / FLOOR_STEP));
  const samples = Math.max(1, Math.ceil(d / m / SAMPLE_STEP));
  // Highest need over each piece, ends included.
  const pieceNeed: number[] = [];
  for (let k = 0; k < m; k++) {
    let h = -Infinity;
    for (let j = 0; j <= samples; j++)
      h = Math.max(h, need(slerp(s.a, s.b, (k + j / samples) / m)));
    pieceNeed.push(h);
  }
  const line = (f: number) => s.alt0 + (s.alt1 - s.alt0) * f;
  const alt: number[] = [];
  const raised: boolean[] = [];
  for (let k = 0; k <= m; k++) {
    const base = line(k / m);
    const want = Math.max(pieceNeed[k - 1] ?? -Infinity, pieceNeed[k] ?? -Infinity);
    alt.push(Math.max(base, want));
    raised.push(want > base);
  }
  if (!raised.includes(true)) return [{ ...s, a: [...s.a], b: [...s.b] }];
  // Pieces between vertices; runs whose vertices all stayed on the line merge.
  const out: RouteSegment[] = [];
  const piece = (k0: number, k1: number): RouteSegment => {
    const f0 = k0 / m;
    const f1 = k1 / m;
    // The leg's own end times at its ends, so neighbors still meet exactly.
    const t0 = k0 === 0 ? s.t0 : s.t0 + (s.t1 - s.t0) * f0;
    return {
      ...s,
      t0,
      t1: k1 === m ? s.t1 : s.t0 + (s.t1 - s.t0) * f1,
      a: k0 === 0 ? [...s.a] : slerp(s.a, s.b, f0),
      b: k1 === m ? [...s.b] : slerp(s.a, s.b, f1),
      alt0: alt[k0]!,
      alt1: alt[k1]!,
      fuel0: s.fuel0 - s.flow * (t0 - s.t0),
    };
  };
  let k0 = 0;
  for (let k = 1; k <= m; k++) {
    // Keep merging while this vertex and the run's start stayed on the line.
    if (k < m && !raised[k] && !raised[k0] && !raised[k + 1]) continue;
    out.push(piece(k0, k));
    k0 = k;
  }
  return out;
}
