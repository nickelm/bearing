/**
 * Following a campaign flight (roadmap R2.4): the pure parts, without three.js or
 * the DOM. Which model and chase rig a followed type gets, where the flight's
 * aircraft are drawn, and the read-only HUD frame built from an analytic pose.
 *
 * - **Models.** A type is drawn with its bundle's geometry (rule 17). Until R2.7
 *   gives every type on the demo's orders a model, a type without one is drawn
 *   with a stand-in of its class and side (`STAND_INS`), painted in the type's own
 *   camouflage scheme; the rig then comes with the stand-in, since it frames the
 *   model on screen.
 * - **Drawn altitude.** Routes stand on the coarse ground (decision 240) and on
 *   sea level at their bases, while the simulation view draws the finer tiles. The
 *   drawn aircraft keeps at least `FOLLOW_CLEARANCE` above the drawn ground in the
 *   air and stands on it on the ground. The lift is presentation only: the route
 *   and the campaign never see it.
 */
import { headingTangent } from '../core/greatCircle';
import type { Dir } from '../core/greatCircle';
import { FOOT, KNOT } from '../core/units';
import type { Meters } from '../core/units';
import { analyticPose } from '../sim/air/analyticPose';
import { formationAt, slotPose } from '../sim/air/formation';
import type { Formation } from '../sim/air/formation';
import type { AnalyticPose } from '../sim/air/analyticPose';
import type { AircraftBundle, RigSpec } from '../sim/air/bundles';
import type { Mission, MissionPhase } from '../sim/air/mission';
import { routeState } from '../sim/air/route';
import { calibratedAirspeed, standardAtmosphere } from '../sim/flight/atmosphere';
import type { HudFrame } from '../ui/flight/hud';
import { Vec3d } from '../core/vec3d';
import type { Reference } from '../sim/flight/aiPilot';

/** The bundle whose geometry stands in for a type without one, by class and side (until R2.7). */
export const STAND_INS: Readonly<Record<string, { alliance: string; pact: string }>> = {
  fighter: { alliance: 'alliance-fighter', pact: 'pact-fighter' },
  strike: { alliance: 'alliance-strike', pact: 'pact-strike' },
  bomber: { alliance: 'c150', pact: 'c150' },
  helicopter: { alliance: 'alliance-utility-helo', pact: 'alliance-utility-helo' },
};

export interface FollowedLook {
  /** The bundle whose geometry draws the type. */
  drawn: string;
  /** The camouflage scheme to paint it in (the type's own when it has one). */
  scheme: string | null;
  /** Drawn with another type's geometry. */
  standIn: boolean;
  /** The chase rig: the type's own, else the drawn bundle's, else null (the camera's default). */
  rig: RigSpec | null;
}

/**
 * The model and rig a followed type gets. `bundles` are all bundles by id (the
 * loader's table); a type whose class has no stand-in, or whose stand-in has no
 * geometry yet, falls back to the fighter's.
 */
export function followedLook(
  b: AircraftBundle,
  bundles: Readonly<Record<string, AircraftBundle>>,
): FollowedLook {
  // A variant (the Vo-31K) draws another bundle's geometry and takes its rig with it.
  if (b.geometry) {
    const rig = b.rig ?? bundles[b.geometry]?.rig ?? null;
    return { drawn: b.geometry, scheme: b.scheme, standIn: false, rig };
  }
  const side = b.airWar?.side ?? 'alliance';
  const pick = (cls: string) => {
    const id = STAND_INS[cls]?.[side];
    return id && bundles[id]?.geometry ? bundles[id] : null;
  };
  const s = pick(b.class) ?? pick('fighter')!;
  return { drawn: s.geometry!, scheme: b.scheme ?? s.scheme, standIn: true, rig: b.rig ?? s.rig };
}

/**
 * Least height of the drawn aircraft above the drawn ground in flight (m): above the
 * tallest canopy (tropical stands reach about 43 m, worldgen/canopy.ts) with room to
 * spare, since the lift reads the ground, not the trees (decision 255). Helicopters fly
 * lower, over the canopy.
 */
export const FOLLOW_CLEARANCE: Meters = 90;
export const HELICOPTER_CLEARANCE: Meters = 50;

/**
 * An airbase as the sim knows it (the coarse point its routes start and end at) and as
 * the view draws it (sited on the eroded ground, decision 220): unit directions and the
 * sited runway's heading (rad, 0..π).
 */
export interface AirfieldShift {
  from: Dir;
  to: Dir;
  heading: number;
}

/** Within SHIFT_FULL of a coarse airbase point the drawn aircraft moves fully to the sited field; the shift fades out by SHIFT_FADE (m). */
export const SHIFT_FULL: Meters = 3_000;
export const SHIFT_FADE: Meters = 30_000;

/**
 * The pose moved from a coarse airbase point to its sited field (decision 253): fully
 * near the base, fading out with distance, so the parked aircraft stands on the drawn
 * field and the takeoff and landing run continuously into the route. On the ground the
 * nose turns to the sited runway's heading (the end nearer the route's heading).
 * Presentation only, like the drawn altitude.
 */
export function shiftedToAirfield(
  p: Readonly<AnalyticPose>,
  fields: readonly AirfieldShift[],
  radius: Meters,
): AnalyticPose {
  if (fields.length === 0) return p as AnalyticPose;
  const r = Math.hypot(...p.pos);
  const d: Dir = [p.pos[0] / r, p.pos[1] / r, p.pos[2] / r];
  let best: AirfieldShift | null = null;
  let bestCos = -2;
  for (const f of fields) {
    const c = d[0] * f.from[0] + d[1] * f.from[1] + d[2] * f.from[2];
    if (c > bestCos) {
      bestCos = c;
      best = f;
    }
  }
  const dist = Math.acos(Math.min(1, bestCos)) * radius;
  if (!best || dist >= SHIFT_FADE) return p as AnalyticPose;
  const x = Math.max(0, Math.min(1, (dist - SHIFT_FULL) / (SHIFT_FADE - SHIFT_FULL)));
  const w = 1 - x * x * (3 - 2 * x);
  const q: Dir = [
    d[0] + w * (best.to[0] - best.from[0]),
    d[1] + w * (best.to[1] - best.from[1]),
    d[2] + w * (best.to[2] - best.from[2]),
  ];
  const n = Math.hypot(...q);
  const out: AnalyticPose = { ...p, pos: [(q[0] / n) * r, (q[1] / n) * r, (q[2] / n) * r] };
  if (!p.airborne) {
    const up: Dir = [q[0] / n, q[1] / n, q[2] / n];
    const turn = (h: number) =>
      Math.abs(Math.atan2(Math.sin(h - p.heading), Math.cos(h - p.heading)));
    const h =
      turn(best.heading) <= turn(best.heading + Math.PI) ? best.heading : best.heading + Math.PI;
    out.heading = h;
    out.forward = headingTangent(up, h);
    out.up = up;
  }
  return out;
}

/** Height of a carrier's flight deck above the sea (m; tools/models/carrier.py). */
export const DECK_HEIGHT: Meters = 23.2;

/**
 * A carrier-based flight's deck (decision 255): its route's ground points (the carrier
 * where it was at launch and at the planned landing) moved to where the carrier is now,
 * so the flight stands on the deck and its takeoff and landing run from it.
 */
export function carrierFields(
  m: Readonly<Mission>,
  carrier: { point: Dir; heading: number } | null,
): AirfieldShift[] {
  if (!carrier || m.base.kind !== 'carrier') return [];
  return m.route.segments
    .filter((s) => s.kind === 'ground')
    .map((s) => ({
      from: [...s.a] as Dir,
      to: [...carrier.point] as Dir,
      heading: carrier.heading,
    }));
}

/** The drawn ground under a pose: a carrier's deck for its flight on the ground, else the terrain's. */
export function drawnGround(
  m: Readonly<Mission>,
  p: Readonly<AnalyticPose>,
  terrain: number | null,
): number | null {
  return m.base.kind === 'carrier' && !p.airborne ? DECK_HEIGHT : terrain;
}

/**
 * The flight's aircraft at game time t: the lead and its formation slots, one per
 * aircraft still in the flight (losses lower `aircraft`, decision 250), in the
 * formation its plug-in names for the phase (`formations`), spaced by the drawn
 * wingspan `span` (m). The lead is moved onto the sited airfields near its base (`fields`).
 */
export function flightPoses(
  m: Readonly<Mission>,
  t: number,
  radius: Meters,
  fields: readonly AirfieldShift[] = [],
  formations: Partial<Record<MissionPhase, Formation>> = {},
  span: Meters = 10,
): AnalyticPose[] {
  const lead = drawnLeadPose(m, t, radius, fields);
  const f = formationAt(m.timeline ?? [], formations, t);
  const out: AnalyticPose[] = [lead];
  for (let k = 1; k < Math.max(1, m.aircraft); k++) out.push(slotPose(lead, k, f, span));
  return out;
}

/** The lead's pose at game time t as the view places it: its route, moved onto the sited field near its base. */
export function drawnLeadPose(
  m: Readonly<Mission>,
  t: number,
  radius: Meters,
  fields: readonly AirfieldShift[] = [],
): AnalyticPose {
  return shiftedToAirfield(analyticPose(m.route, t, radius), fields, radius);
}

/**
 * The lead's reference at full fidelity (R2.5, owner decision 8: full fidelity flies
 * where the view draws): its drawn pose (`pose`, the route on the sited field) lifted
 * to the drawn altitude over the drawn ground (`ground`, m at a unit direction, or null
 * while unknown). The lift is the target, not the eased one the view draws: the AI
 * climbs over a ridge in its own time, the tracker's height gain deciding how fast.
 */
export function drawnReference(
  pose: (t: number) => AnalyticPose | null,
  ground: (d: Readonly<Vec3d>) => number | null,
  gearHeight: Meters,
  clearance: Meters = FOLLOW_CLEARANCE,
): Reference {
  return (t) => {
    const p = pose(t);
    if (!p) return null;
    const pos = new Vec3d(p.pos[0], p.pos[1], p.pos[2]);
    const l = liftedPose(
      p,
      drawnAltitude(p, ground(pos.clone().normalize()), gearHeight, clearance),
    );
    return {
      pos: new Vec3d(l.pos[0], l.pos[1], l.pos[2]),
      vel: new Vec3d(l.velocity[0], l.velocity[1], l.velocity[2]),
    };
  };
}

/**
 * The pose lifted to `drawnAltitude` (m above sea level): the position moved out
 * along the local vertical; attitude and velocity stay.
 */
export function liftedPose(p: Readonly<AnalyticPose>, drawnAltitude: Meters): AnalyticPose {
  const r = Math.hypot(...p.pos);
  const d: Dir = [p.pos[0] / r, p.pos[1] / r, p.pos[2] / r];
  const radius = r - Math.max(0, p.altitude);
  const nr = radius + drawnAltitude;
  return { ...p, pos: [d[0] * nr, d[1] * nr, d[2] * nr], altitude: drawnAltitude };
}

/**
 * The altitude to draw at (m above sea level): the route's, but on the ground
 * `gearHeight` above the drawn ground and in the air at least `clearance` (FOLLOW_CLEARANCE)
 * above it. `ground` is the drawn ground's height (m), or null while unknown.
 */
export function drawnAltitude(
  p: Readonly<AnalyticPose>,
  ground: number | null,
  gearHeight: Meters,
  clearance: Meters = FOLLOW_CLEARANCE,
): Meters {
  const route = Math.max(0, p.altitude);
  if (ground === null) return route;
  const g = Math.max(0, ground);
  if (!p.airborne) return g + gearHeight;
  return Math.max(route, g + clearance);
}

/**
 * Eases the drawn lift (drawn altitude less route altitude, m) toward its target:
 * up at once, so the aircraft never sinks into a ridge, and down over a time
 * constant of `DROP_TIME` seconds, so a valley does not pull it down in a step.
 */
export const DROP_TIME = 4;
export function easeLift(current: number, target: number, dt: number): number {
  if (target >= current) return target;
  return target + (current - target) * Math.exp(-dt / DROP_TIME);
}

/** Phases flown with the gear down near the ground. */
const GEAR_PHASES: ReadonlySet<MissionPhase> = new Set(['departure', 'approach', 'recovery']);
/** Height above the ground (m) below which the gear is down in those phases. */
export const GEAR_HEIGHT_AGL: Meters = 1000 * FOOT;

/** Whether the followed aircraft has its gear down: on the ground, or low in departure and arrival. */
export function gearDown(p: Readonly<AnalyticPose>, heightAboveGround: Meters): boolean {
  if (!p.airborne) return true;
  return GEAR_PHASES.has(p.phase) && heightAboveGround < GEAR_HEIGHT_AGL;
}

export interface FollowHudInputs {
  pose: Readonly<AnalyticPose>;
  /** Fuel per aircraft (kg), from the route. */
  fuel: number;
  /** Height above the drawn ground (m). */
  radarAltitude: Meters;
  gear: number;
  gearDown: boolean;
  /** Afterburner on (a takeoff or climb by a type that has one), 0..1. */
  afterburner: number;
}

/**
 * The read-only HUD frame of a followed aircraft (R2.4): what its analytic pose
 * knows. Airspeed is the true airspeed of the route's ground speed (no wind),
 * calibrated at the standard atmosphere; angle of attack, sideslip and warnings
 * are none, the load is the coordinated turn's 1/cos(bank), and the mode reads
 * FOLLOW: no one flies it from here (full fidelity is R2.5).
 */
export function followHudFrame(i: FollowHudInputs): HudFrame {
  const p = i.pose;
  const tas = p.speed;
  const air = standardAtmosphere(Math.max(0, p.altitude));
  const cas = p.airborne ? calibratedAirspeed(tas, air) : 0;
  const v = Math.hypot(...p.velocity);
  const velocity: [number, number, number] =
    v > 1 ? [p.velocity[0] / v, p.velocity[1] / v, p.velocity[2] / v] : [...p.forward];
  const power = p.airborne ? (p.climb > 2 ? 0.9 : 0.7) : 0.1;
  return {
    cas,
    mach: tas / air.speedOfSound,
    altitude: Math.max(0, p.altitude),
    radarAltitude: i.radarAltitude,
    verticalSpeed: p.climb,
    heading: p.heading,
    pitch: p.pitch,
    bank: p.bank,
    alpha: 0,
    beta: 0,
    load: p.airborne ? 1 / Math.cos(p.bank) : 1,
    throttle: power,
    power,
    afterburner: i.afterburner,
    fuel: i.fuel,
    unlimitedFuel: false,
    gear: i.gear,
    gearDown: i.gearDown,
    speedbrake: 0,
    brakes: false,
    parkingBrake: !p.airborne && p.speed < 1,
    onGround: !p.airborne,
    velocity,
    boresight: [...p.forward],
    warnings: [],
    aid: null,
    aoaBracket: null,
    speedCues: null,
    mode: 'follow',
    control: null,
    hover: null,
    debug: null,
    panels: true,
  };
}

/** Fuel per aircraft (kg) of the flight at t. */
export function flightFuel(m: Readonly<Mission>, t: number, radius: Meters): number {
  return Math.max(0, routeState(m.route, t, radius).fuel);
}

/** Below this ground speed a followed helicopter counts as hovering (rotor disc still spins). */
export const HOVER_SPEED = 10 * KNOT;
