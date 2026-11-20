/**
 * Mouse aim (decisions 198, 219), shared by every flown jet: Free Flight's and a
 * campaign aircraft the player takes over (R2.5), so the player flies the same way
 * in both (rule 12: one flight director, one flight model).
 *
 * - `aimDirection`: where the aim ring points, the cursor's direction in the chase
 *   view with its look centered, so looking around does not steer the jet.
 * - `flyMouseAim`: the director flies toward the aim; the rudder keys stay the
 *   pilot's (the director zeroes the pedals in the air for its own turn
 *   coordination), and a held stick key takes its axis (decision 219).
 */
import { DEG } from '../../core/units';
import { Vec3d } from '../../core/vec3d';
import type { FlightControls } from '../../sim/flight/controlLaws';
import { along } from '../../sim/flight/flightDirector';
import type { FlightDirector } from '../../sim/flight/flightDirector';
import type { FlightModel } from '../../sim/flight/flightModel';
import { FLIGHT_STEP } from '../../sim/flight/rigidBody';

/** The chase camera's rest frame that the aim ring is drawn in. */
export interface AimFrame {
  restForward: Readonly<Vec3d>;
  restUp: Readonly<Vec3d>;
  /** Vertical field of view (rad). */
  fov: number;
}

/** The aim's direction for a cursor (normalized device coordinates) in a view of `aspect`. */
export function aimDirection(
  frame: Readonly<AimFrame>,
  aspect: number,
  cursor: Readonly<{ x: number; y: number }>,
): Vec3d {
  const tanY = Math.tan(frame.fov / 2);
  const right = frame.restForward.clone().cross(frame.restUp).normalize();
  return frame.restForward
    .clone()
    .addScaled(right, cursor.x * tanY * aspect)
    .addScaled(frame.restUp, cursor.y * tanY)
    .normalize();
}

/** One step of mouse aim: the director toward `aim`, the pedals kept, held stick keys blended over. */
export function flyMouseAim(
  director: FlightDirector,
  m: FlightModel,
  aim: Readonly<Vec3d>,
  ctl: FlightControls,
  input: { overrideStick(ctl: FlightControls): void },
): void {
  const pedals = ctl.yaw;
  const a = along(m, aim);
  director.fly(
    m,
    {
      course: a.course,
      gamma: a.gamma,
      speed: null,
      maxBank: 80 * DEG,
      maxTurnRate: 20 * DEG,
      maxLoadDelta: 4,
    },
    ctl,
    FLIGHT_STEP,
  );
  ctl.yaw = pedals;
  input.overrideStick(ctl);
}
