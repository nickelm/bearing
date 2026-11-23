/**
 * Free Flight's traffic (decision 218): a few aircraft circling near the base and
 * two ground radars, so the sensors and their displays have something to find.
 * There is no war: nobody shoots, and the traffic never reacts beyond its radars
 * turning to track the player when they come close. Positions are analytic in game
 * time, laid out by a hash of the base, so a base always has the same traffic.
 */
import { Vec3d } from '../core/vec3d';
import { KM } from '../core/units';
import type { Emitter, RadarSpec, SensorTarget } from '../sim/sensors/sensors';
import { scanHash } from '../sim/sensors/sensors';
import { TYPE_PROFILES } from '../sim/avionics/profiles';
import type { Side } from '../campaign/cast';

export interface TrafficAircraft {
  id: string;
  side: Side;
  /** Model spec id for its view. */
  model: string;
  rcs: number;
  size: number;
  /** Circle: center (unit), radius (m), altitude (m), speed (m/s), phase (rad), sense (+1 clockwise). */
  center: Vec3d;
  radius: number;
  altitude: number;
  speed: number;
  phase: number;
  sense: 1 | -1;
  radar: RadarSpec | null;
  kind: string;
}

export interface TrafficSite {
  id: string;
  dir: Vec3d;
  radar: RadarSpec;
  kind: string;
  /** Range inside which it tracks the player (m). */
  trackRange: number;
  /** Its side: the Pact's unless the player flies for the Pact. */
  side?: Side;
}

/** The Pact fighters' radar: the MiG-29 analogue's profile (decision 224). */
const FIGHTER_RADAR: RadarSpec = TYPE_PROFILES.vo31!.radar!;
const SAM_RADAR: RadarSpec = {
  kind: 'pulse',
  range: 45_000,
  azimuth: Math.PI,
  elevation: Math.PI / 2,
  notch: 0,
};

/** Where the aircraft is at game time `t` (m) and its velocity (m/s), on a planet of `radius`. */
export function trafficState(
  a: TrafficAircraft,
  t: number,
  radius: number,
): { pos: Vec3d; vel: Vec3d; heading: number; bank: number } {
  const up = a.center;
  const east = new Vec3d(0, 1, 0).cross(up).normalize();
  const north = up.clone().cross(east);
  const ang = a.phase + (a.sense * a.speed * t) / a.radius;
  // Clockwise seen from above: north to east as the angle grows.
  const off = north.clone().scale(Math.cos(ang)).addScaled(east, Math.sin(ang));
  const pos = up
    .clone()
    .scale(radius)
    .addScaled(off, a.radius)
    .normalize()
    .scale(radius + a.altitude);
  const tangent = north.clone().scale(-Math.sin(ang)).addScaled(east, Math.cos(ang)).scale(a.sense);
  const heading = Math.atan2(tangent.dot(east), tangent.dot(north));
  const bank = a.sense * Math.atan((a.speed * a.speed) / (9.81 * a.radius));
  return { pos, vel: tangent.scale(a.speed), heading, bank };
}

/** The other side's model for a traffic aircraft when the player flies for the Pact (R2.7). */
const MIRRORED: Readonly<Record<string, { model: string; kind: string }>> = {
  'pact-fighter': { model: 'alliance-fighter', kind: '16' },
  'pact-strike': { model: 'alliance-strike', kind: '' },
  'alliance-fighter': { model: 'pact-fighter', kind: '' },
};

const other = (s: Side): Side => (s === 'alliance' ? 'pact' : 'alliance');

/**
 * The traffic around base point `base` (unit), laid out by a hash of `key`, for a player
 * of side `own`: the Alliance's traffic as it was, or for a Pact player its mirror, the
 * same circles flown by the other side's types.
 */
export function buildTraffic(
  base: Readonly<Vec3d>,
  key: string,
  radius: number,
  own: Side = 'alliance',
): { aircraft: TrafficAircraft[]; sites: TrafficSite[] } {
  const t = buildAllianceTraffic(base, key, radius);
  if (own === 'alliance') return t;
  return {
    aircraft: t.aircraft.map((a) => ({ ...a, side: other(a.side), ...MIRRORED[a.model] })),
    sites: t.sites.map((x) => ({ ...x, kind: 'HK', side: 'alliance' as Side })),
  };
}

function buildAllianceTraffic(
  base: Readonly<Vec3d>,
  key: string,
  radius: number,
): { aircraft: TrafficAircraft[]; sites: TrafficSite[] } {
  const up = base.clone().normalize();
  const east = new Vec3d(0, 1, 0).cross(up).normalize();
  const north = up.clone().cross(east);
  const place = (bearing: number, dist: number) =>
    up
      .clone()
      .scale(radius)
      .addScaled(north, Math.cos(bearing) * dist)
      .addScaled(east, Math.sin(bearing) * dist)
      .normalize();
  const h = (i: number) => scanHash(key, i);
  const kinds: {
    id: string;
    side: Side;
    model: string;
    rcs: number;
    size: number;
    radar: RadarSpec | null;
    kind: string;
  }[] = [
    {
      id: 'bandit-1',
      side: 'pact',
      model: 'pact-fighter',
      rcs: 5,
      size: 15,
      radar: FIGHTER_RADAR,
      kind: '29',
    },
    {
      id: 'bandit-2',
      side: 'pact',
      model: 'pact-fighter',
      rcs: 5,
      size: 15,
      radar: FIGHTER_RADAR,
      kind: '29',
    },
    {
      id: 'strike-1',
      side: 'pact',
      model: 'pact-strike',
      rcs: 10,
      size: 20,
      radar: null,
      kind: '',
    },
    {
      id: 'friend-1',
      side: 'alliance',
      model: 'alliance-fighter',
      rcs: 4,
      size: 15,
      radar: null,
      kind: '',
    },
  ];
  const aircraft = kinds.map((k, i) => {
    const bearing = 2 * Math.PI * h(i * 7);
    const dist = (25 + 45 * h(i * 7 + 1)) * KM;
    return {
      ...k,
      center: place(bearing, dist),
      radius: (8 + 7 * h(i * 7 + 2)) * KM,
      altitude: 1500 + 7500 * h(i * 7 + 3),
      speed: 190 + 70 * h(i * 7 + 4),
      phase: 2 * Math.PI * h(i * 7 + 5),
      sense: (h(i * 7 + 6) < 0.5 ? 1 : -1) as 1 | -1,
    };
  });
  const sites: TrafficSite[] = [0, 1].map((i) => ({
    id: `sam-${i + 1}`,
    dir: place(2 * Math.PI * h(100 + i), (35 + 30 * h(110 + i)) * KM),
    radar: SAM_RADAR,
    kind: 'SA6',
    trackRange: 25 * KM,
  }));
  return { aircraft, sites };
}

/**
 * The traffic as the sensors' targets at game time `t`: the fighters' and the sites'
 * radars track `ownId` when it is within reach and in their scan, and search otherwise.
 */
export function trafficTargets(
  traffic: { aircraft: TrafficAircraft[]; sites: TrafficSite[] },
  t: number,
  radius: number,
  groundAt: (dir: Readonly<Vec3d>) => number,
  own: { id: string; pos: Readonly<Vec3d> },
): SensorTarget[] {
  const out: SensorTarget[] = [];
  for (const a of traffic.aircraft) {
    const s = trafficState(a, t, radius);
    let emitter: Emitter | null = null;
    if (a.radar) {
      const to = own.pos.clone().sub(s.pos);
      const ahead = to.clone().normalize().dot(s.vel.clone().normalize());
      const tracking = to.length() < 35 * KM && ahead > Math.cos(a.radar.azimuth);
      emitter = {
        radar: a.radar,
        kind: a.kind,
        ground: false,
        state: tracking ? 'track' : 'search',
        tracking: tracking ? own.id : null,
      };
    }
    out.push({
      id: a.id,
      side: a.side,
      pos: s.pos,
      vel: s.vel,
      rcs: a.rcs,
      size: a.size,
      airborne: true,
      emitter,
    });
  }
  for (const site of traffic.sites) {
    const pos = site.dir.clone().scale(radius + Math.max(0, groundAt(site.dir)) + 8);
    const tracking = own.pos.clone().sub(pos).length() < site.trackRange;
    out.push({
      id: site.id,
      side: site.side ?? 'pact',
      pos,
      vel: new Vec3d(0, 0, 0),
      rcs: 30,
      size: 10,
      airborne: false,
      emitter: {
        radar: site.radar,
        kind: site.kind,
        ground: true,
        state: tracking ? 'track' : 'search',
        tracking: tracking ? own.id : null,
      },
    });
  }
  return out;
}
