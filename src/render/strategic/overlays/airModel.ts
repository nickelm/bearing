/**
 * What the map draws of the air war at a game time (visual-style Part II,
 * Military Overlays; C2): flights as small aircraft icons with their heading
 * and short trails, carrier groups as ship icons, and mission routes as thin
 * dashed lines. Pure TypeScript from the sim's mission records and the cast's
 * carrier tracks: routes are analytic (sim/air/route.ts), so positions follow
 * the display clock without new data from the worker.
 *
 * - **Flights** show from climb-out to approach: one icon per flight, at its
 *   position, nose along its heading, in its side's color.
 * - **Trails** are the last TRAIL_TIME of the track, sampled TRAIL_SAMPLES times.
 * - **Routes** (a debug toggle until mission search selects one; the guide
 *   draws routes on hover and selection) are the whole planned track,
 *   racetracks included, densified for draping.
 * - **Carriers** sail their patrol tracks.
 * - **Side.** Decision 48: the side is a view. `side` filters to one side's
 *   missions; 'both' is a developer view of ground truth until the
 *   intelligence overlay exists.
 */
import type { Side } from '../../../campaign/cast';
import { headingTangent, slerp } from '../../../core/greatCircle';
import type { Dir } from '../../../core/greatCircle';
import { MINUTE } from '../../../core/units';
import type { GameTime } from '../../../core/units';
import type { Mission } from '../../../sim/air/mission';
import { ORBIT_LEG, routeState } from '../../../sim/air/route';
import { carrierState } from '../../../sim/naval/carrierGroup';
import type { CarrierTrack } from '../../../sim/naval/carrierGroup';
import { FACTION_COLORS } from './militaryModel';
import type { LineStyle, MilitaryOverlays, OverlayLine, OverlayMark } from './militaryModel';

export type AirLayer = 'routes' | 'trails' | 'carriers' | 'flights';
export const AIR_LAYERS: readonly AirLayer[] = ['routes', 'trails', 'carriers', 'flights'];

export const TRAIL_TIME = 4 * MINUTE;
export const TRAIL_SAMPLES = 8;
/** Icon sizes (CSS px). */
export const FLIGHT_ICON = 14;
export const CARRIER_ICON = 18;
/** Largest step between route points, as a central angle (rad): about 10 km on the 1,000 km planet. */
const MAX_STEP = 0.01;
const ORBIT_SAMPLES = 24;

const BANDS = ['globe', 'theater', 'region'] as const;

const TRAIL_STYLE = (color: number): LineStyle => ({
  color,
  width: 1.5,
  casing: 0,
  casingOpacity: 0,
  dash: 0,
  duty: 1,
  roundEnds: true,
  teeth: null,
});

const ROUTE_STYLE = (color: number): LineStyle => ({
  color,
  width: 1,
  casing: 1,
  casingOpacity: 0.6,
  dash: 10,
  duty: 0.55,
  roundEnds: true,
  teeth: null,
});

export interface AirViewOptions {
  side: Side | 'both';
  /** Draw every visible mission's route (debug until selection exists). */
  routes: boolean;
}

function densify(points: Dir[]): Float64Array {
  const out: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (i > 0) {
      const q = points[i - 1]!;
      const w = Math.acos(Math.min(1, q[0] * p[0] + q[1] * p[1] + q[2] * p[2]));
      const n = Math.ceil(w / MAX_STEP);
      for (let k = 1; k < n; k++) out.push(...slerp(q, p, k / n));
    }
    out.push(p[0], p[1], p[2]);
  }
  return Float64Array.from(out);
}

/** The whole planned track of a mission: leg ends and one lap of each racetrack. */
export function routeTrack(m: Mission, radius: number): Dir[] {
  const pts: Dir[] = [];
  for (const s of m.route.segments) {
    if (s.kind === 'ground') continue;
    if (s.kind === 'leg') {
      if (pts.length === 0) pts.push(s.a);
      pts.push(s.b);
      continue;
    }
    const lap = Math.min(
      s.t1 - s.t0,
      (2 * ORBIT_LEG + 2 * Math.PI * s.turn) / Math.max(s.speed, 1),
    );
    for (let k = 0; k <= ORBIT_SAMPLES; k++) {
      pts.push(routeState(m.route, s.t0 + (lap * k) / ORBIT_SAMPLES, radius).point);
    }
  }
  return pts;
}

export function buildAirOverlays(
  missions: readonly Mission[],
  carriers: readonly CarrierTrack[],
  t: GameTime,
  radius: number,
  options: AirViewOptions,
): MilitaryOverlays<AirLayer> {
  const lines: OverlayLine<AirLayer>[] = [];
  const marks: OverlayMark<AirLayer>[] = [];
  const visible = (side: Side) => options.side === 'both' || options.side === side;
  for (const m of missions) {
    if (!visible(m.side)) continue;
    const color = FACTION_COLORS[m.side];
    const now = routeState(m.route, t, radius);
    if (options.routes && now.segment >= 0) {
      const track = routeTrack(m, radius);
      if (track.length >= 2) {
        lines.push({
          layer: 'routes',
          points: densify(track),
          style: ROUTE_STYLE(color),
          bands: BANDS,
        });
      }
    }
    if (!now.airborne) continue;
    const trail: Dir[] = [];
    for (let k = TRAIL_SAMPLES; k >= 0; k--) {
      const s = routeState(m.route, t - (TRAIL_TIME * k) / TRAIL_SAMPLES, radius);
      if (s.airborne) trail.push(s.point);
    }
    if (trail.length >= 2) {
      lines.push({
        layer: 'trails',
        points: densify(trail),
        style: TRAIL_STYLE(color),
        bands: BANDS,
      });
    }
    marks.push({
      layer: 'flights',
      shape: 'aircraft',
      point: now.point,
      axis: headingTangent(now.point, now.heading),
      length: FLIGHT_ICON,
      width: FLIGHT_ICON,
      color,
      outline: 0,
      casing: 1.5,
      bands: BANDS,
    });
  }
  for (const c of carriers) {
    if (!visible(c.cast.side)) continue;
    const s = carrierState(c, t);
    marks.push({
      layer: 'carriers',
      shape: 'carrier',
      point: s.point,
      axis: headingTangent(s.point, s.heading),
      length: CARRIER_ICON,
      width: CARRIER_ICON,
      color: FACTION_COLORS[c.cast.side],
      outline: 0,
      casing: 1.5,
      bands: BANDS,
    });
  }
  return { lines, marks };
}
