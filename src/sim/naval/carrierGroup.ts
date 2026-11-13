/**
 * Carrier groups at sea (decision 56): an analytic position on the cast's
 * patrol track. A group sails its stretch of sea lane back and forth at
 * PATROL_SPEED, starting at the middle of the track heading toward its end, so
 * its position at any game time is a closed-form function of that time. The
 * planner reads it to launch and recover the air wing at the group's
 * predicted position; the map draws it from the same function.
 */
import type { CarrierGroupCast } from '../../campaign/cast';
import { alongPolyline, polylineStations, tangentHeading } from '../../core/greatCircle';
import type { Dir } from '../../core/greatCircle';
import { KNOT } from '../../core/units';
import type { GameTime, Meters } from '../../core/units';

export const PATROL_SPEED = 15 * KNOT;

export interface CarrierTrack {
  cast: CarrierGroupCast;
  /** Arc length at each track vertex (m). */
  stations: Float64Array;
  length: Meters;
}

export interface CarrierState {
  point: Dir;
  /** Heading of travel, clockwise from north (rad). */
  heading: number;
  speed: number;
}

export function carrierTrack(cast: CarrierGroupCast, radius: Meters): CarrierTrack {
  const stations = polylineStations(cast.track, radius);
  return { cast, stations, length: stations[stations.length - 1]! };
}

/** The group's position at game time t. */
export function carrierState(c: CarrierTrack, t: GameTime): CarrierState {
  const L = c.length;
  if (L <= 0) {
    const p = alongPolyline(c.cast.track, c.stations, 0);
    return { point: p.point, heading: 0, speed: 0 };
  }
  // Distance sailed since the start, from the middle of the track: a triangle wave over [0, L].
  const d = L / 2 + PATROL_SPEED * t;
  const m = ((d % (2 * L)) + 2 * L) % (2 * L);
  const forward = m <= L;
  const s = forward ? m : 2 * L - m;
  const at = alongPolyline(c.cast.track, c.stations, s);
  const tangent: Dir = forward ? at.tangent : [-at.tangent[0], -at.tangent[1], -at.tangent[2]];
  return { point: at.point, heading: tangentHeading(at.point, tangent), speed: PATROL_SPEED };
}
