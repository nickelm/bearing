/**
 * Spawn positions for Free Flight (decision 134): lined up at a runway's
 * threshold on the gear, or in the air along the runway's heading.
 */
import { Vec3d } from '../../core/vec3d';
import { KNOT } from '../../core/units';
import type { FlightModel } from './flightModel';
import { headingVector, runwayFrame, runwayPoint } from './runway';
import type { Runway, RunwayEnd } from './runway';

/** Distance from the threshold to the lined-up aircraft's CG (m). */
export const LINEUP_DISTANCE = 40;

/**
 * Lines the aircraft up on `end` of runway `r`: on the centerline just past the
 * threshold, wheels on the pavement with the struts near their static
 * compression, at rest. The caller sets idle and the parking brake.
 */
export function spawnOnRunway(model: FlightModel, r: Readonly<Runway>, end: Readonly<RunwayEnd>) {
  const frame = runwayFrame(r);
  const along = end.threshold + end.sign * LINEUP_DISTANCE;
  // Struts a little compressed, so the aircraft settles in a few tenths of a second.
  const height = model.gearHeight - 0.08;
  const pos = runwayPoint(r, frame, along, 0, height, model.radius);
  model.place(pos, new Vec3d(), end.heading, 0, 0);
  model.gear = 1;
  model.speedbrake = 0;
  model.power = 0;
  model.afterburner = 0;
}

/** Air start: `altitude` above the field, `speed` true airspeed along the end's heading, gear up. */
export function spawnInAir(
  model: FlightModel,
  r: Readonly<Runway>,
  end: Readonly<RunwayEnd>,
  altitude = 3000,
  speed = 300 * KNOT,
) {
  const frame = runwayFrame(r);
  const pos = runwayPoint(r, frame, end.threshold, 0, altitude, model.radius);
  const up = pos.clone().normalize();
  const vel = headingVector(up, end.heading).scale(speed);
  // About the 1-g angle of attack at 300 kt at 3 km.
  model.place(pos, vel, end.heading, 3.5 * (Math.PI / 180), 0);
  model.gear = 0;
  model.speedbrake = 0;
  model.power = 0.45;
  // Long airborne, as far as the control laws know: not the moment of a liftoff.
  model.lawState.airborne = 30;
  model.afterburner = 0;
}
