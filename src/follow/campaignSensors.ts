/**
 * The campaign as the sensors see it (roadmap R2.6, decision 303): what a followed or
 * flown aircraft's sensor model (sim/sensors/sensors.ts) is given to look at. Main thread,
 * no three.js or DOM; the analytic routes give every flight's place at any time.
 *
 * - **Flights** are radar targets: each airborne flight within reach is one target at its
 *   lead, `m<id>` (the id the missile seeker and the kills use), with a cross-section and
 *   a size by its type's role. A flight in formation shows as one contact, as it would at
 *   a radar's resolution; its wingmen as separate contacts wait for R3.
 * - **Airborne emitters.** A flight of the other side whose type carries an air-to-air
 *   radar emits it: searching, or tracking the aircraft when it is within 80% of the
 *   radar's range against a fighter and inside its scan. Its own side's radars are left
 *   off the threat display.
 * - **Ground emitters.** The other side's defended places (target sites with an air
 *   defense, airbases) carry a surface-to-air radar (`SAM_RADAR`): searching, tracking
 *   within 25 km. They stand for the aggregate's point defenses until R3.5's sites.
 * - **Datalink.** While an airborne early warning aircraft of the own side flies, its
 *   picture reaches the datalink: the other side's flights within its reach, delayed and
 *   with an error.
 */
import type { Side } from '../campaign/cast';
import type { Dir } from '../core/greatCircle';
import { Vec3d } from '../core/vec3d';
import { aircraftType } from '../sim/air/aircraft';
import type { AircraftRole } from '../sim/air/aircraft';
import { analyticPose } from '../sim/air/analyticPose';
import type { Mission } from '../sim/air/mission';
import { routeState } from '../sim/air/route';
import { TYPE_PROFILES } from '../sim/avionics/profiles';
import { detectionRange } from '../sim/sensors/sensors';
import type { DatalinkFeed, Emitter, RadarSpec, SensorTarget } from '../sim/sensors/sensors';

/** How far from the aircraft flights are looked at (m): beyond any radar's or datalink's reach. */
export const SENSOR_REACH = 400_000;
/** An early warning aircraft's reach for the datalink (m). */
export const AEW_REACH = 350_000;
/** A defended place's surface-to-air radar (as Free Flight's sites), and its tracking range (m). */
export const SAM_RADAR: RadarSpec = {
  kind: 'pulse',
  range: 45_000,
  azimuth: Math.PI,
  elevation: Math.PI / 2,
  notch: 0,
};
export const SAM_TRACK = 25_000;

/** Radar cross-section (m²) and size (m) by role. */
const SIGNATURE: Partial<Record<AircraftRole, { rcs: number; size: number }>> = {
  'air-superiority': { rcs: 5, size: 18 },
  multirole: { rcs: 4, size: 15 },
  'deep-strike': { rcs: 10, size: 22 },
  'carrier-attack': { rcs: 8, size: 17 },
  'stealth-strike': { rcs: 0.05, size: 20 },
  cas: { rcs: 8, size: 17 },
  sead: { rcs: 6, size: 18 },
  'attack-helicopter': { rcs: 6, size: 17 },
  bomber: { rcs: 40, size: 40 },
  'maritime-bomber': { rcs: 40, size: 40 },
  aew: { rcs: 60, size: 45 },
  tanker: { rcs: 60, size: 45 },
};
const DEFAULT_SIGNATURE = { rcs: 20, size: 30 };

/** What the threat display calls a type's radar: the digits of its name ("Vo-31" → "31"). */
export function emitterLabel(name: string): string {
  return name.match(/\d+/)?.[0] ?? name.slice(0, 3).toUpperCase();
}

/** A defended place of the war (a target site with an air defense, an airbase). */
export interface DefendedSite {
  id: string;
  side: Side;
  point: Readonly<Dir>;
}

/** What the threat display calls a side's surface-to-air radar. */
const SAM_LABEL: Record<Side, string> = { pact: 'SA6', alliance: 'HK' };

/**
 * The war's flights and defended places as sensor targets at game time t, for an aircraft
 * of `own.side` at `own.pos` with id `own.id` (the radars that track it name it).
 */
export function campaignTargets(
  missions: readonly Mission[],
  t: number,
  R: number,
  own: { id: string; side: Side; pos: Readonly<Vec3d>; exclude?: number },
  sites: readonly DefendedSite[],
  groundAt: (dir: Readonly<Vec3d>) => number,
): SensorTarget[] {
  const out: SensorTarget[] = [];
  const reach = SENSOR_REACH / R;
  const ownDir = own.pos.clone().normalize();
  const d = new Vec3d();
  for (const m of missions) {
    if (m.id === own.exclude || m.aircraft <= 0) continue;
    const s = routeState(m.route, t, R);
    if (!s.airborne) continue;
    d.set(s.point[0], s.point[1], s.point[2]);
    if (Math.acos(Math.max(-1, Math.min(1, d.dot(ownDir)))) > reach) continue;
    const p = analyticPose(m.route, t, R);
    const pos = new Vec3d(p.pos[0], p.pos[1], p.pos[2]);
    const vel = new Vec3d(p.velocity[0], p.velocity[1], p.velocity[2]);
    const type = aircraftType(m.aircraftType);
    const sig = SIGNATURE[type.role] ?? DEFAULT_SIGNATURE;
    let emitter: Emitter | null = null;
    const radar = TYPE_PROFILES[m.aircraftType]?.radar;
    if (radar && m.side !== own.side) {
      const to = own.pos.clone().sub(pos);
      const ahead = to.clone().normalize().dot(vel.clone().normalize());
      const tracking =
        to.length() < 0.8 * detectionRange(radar, 5) && ahead > Math.cos(radar.azimuth);
      emitter = {
        radar,
        kind: emitterLabel(type.name),
        ground: false,
        state: tracking ? 'track' : 'search',
        tracking: tracking ? own.id : null,
      };
    }
    out.push({
      id: `m${m.id}`,
      side: m.side,
      pos,
      vel,
      rcs: sig.rcs,
      size: sig.size,
      airborne: true,
      emitter,
    });
  }
  for (const site of sites) {
    if (site.side === own.side) continue;
    d.set(site.point[0], site.point[1], site.point[2]).normalize();
    if (Math.acos(Math.max(-1, Math.min(1, d.dot(ownDir)))) > reach) continue;
    const pos = d.clone().scale(R + Math.max(0, groundAt(d)) + 8);
    const tracking = own.pos.clone().sub(pos).length() < SAM_TRACK;
    out.push({
      id: site.id,
      side: site.side,
      pos,
      vel: new Vec3d(),
      rcs: 30,
      size: 10,
      airborne: false,
      emitter: {
        radar: SAM_RADAR,
        kind: SAM_LABEL[site.side],
        ground: true,
        state: tracking ? 'track' : 'search',
        tracking: tracking ? own.id : null,
      },
    });
  }
  return out;
}

/**
 * The datalink's picture for `side` (decision 303): while an early warning aircraft of the
 * side is airborne, the other side's flights within its reach, 5 s late and 400 m off.
 */
export function campaignDatalink(
  missions: readonly Mission[],
  t: number,
  R: number,
  side: Side,
  targets: readonly SensorTarget[],
): DatalinkFeed | null {
  const aews: Vec3d[] = [];
  for (const m of missions) {
    if (m.side !== side || m.aircraft <= 0) continue;
    if (aircraftType(m.aircraftType).role !== 'aew') continue;
    const s = routeState(m.route, t, R);
    if (!s.airborne) continue;
    aews.push(new Vec3d(s.point[0], s.point[1], s.point[2]).scale(R + s.altitude));
  }
  if (aews.length === 0) return null;
  return {
    delay: 5,
    error: 400,
    targets: targets.filter(
      (x) => x.airborne && x.side !== side && aews.some((a) => a.distanceTo(x.pos) < AEW_REACH),
    ),
  };
}
