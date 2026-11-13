/** Flight-model test fixtures: the Kestrel's flight spec and a flat world with one runway. */
import { Vec3d } from '../../src/core/vec3d';
import { DEG } from '../../src/core/units';
import spec from '../../src/render/common/models/specs/alliance-fighter.json';
import { parseFlightSpec } from '../../src/sim/flight/flightSpec';
import type { FlightSpec } from '../../src/sim/flight/flightSpec';
import { FlightModel } from '../../src/sim/flight/flightModel';
import type { GroundQuery } from '../../src/sim/flight/flightModel';
import { onRunway, runwayFrame, toRunway } from '../../src/sim/flight/runway';
import type { Runway } from '../../src/sim/flight/runway';
import { latLonToDirection } from '../../src/core/coords';

export const RADIUS = 1_000_000;

export function kestrelSpec(): FlightSpec {
  return parseFlightSpec((spec as { flight: unknown }).flight, 'alliance-fighter');
}

export function testRunway(elevation = 120): Runway {
  return {
    id: 0,
    name: 'Test Air Base',
    side: 'alliance',
    center: latLonToDirection(20 * DEG, 30 * DEG, new Vec3d()),
    heading: 75 * DEG,
    length: 2700,
    width: 45,
    elevation,
  };
}

/** Flat ground at the runway's elevation everywhere; runway surface on the runway. */
export function flatGround(r: Runway): GroundQuery {
  const frame = runwayFrame(r);
  return {
    height: () => r.elevation,
    surface: (d) => {
      const c = toRunway(r, frame, d.clone().scale(RADIUS + r.elevation), RADIUS);
      return onRunway(r, c.along, c.across) ? 'runway' : 'field';
    },
  };
}

export function kestrel(): FlightModel {
  return new FlightModel(kestrelSpec(), RADIUS);
}
