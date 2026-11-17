/**
 * The Kestrel's drag coefficient by term (decision 207), shared by the flight model and the
 * approach energy cue (energy.ts), so the cue predicts with the drag the model flies:
 *
 *   CD = CD0(Mach) + k·CL²·(1 − ground effect) + CDsep(|α|) + gear + flaps + speedbrake + stores
 *
 * The speedbrake's drag grows as sin²δ / sin²δmax, as a hinged plate's; damaged gear doors
 * add their own increment to the gear's.
 */
import { lookup } from './flightSpec';
import type { FlightSpec } from './flightSpec';

/** The drag coefficient by term (all referred to the wing area). */
export interface DragBreakdown {
  /** Zero-lift drag at this Mach number. */
  cd0: number;
  /** Induced drag, k·CL², less the ground effect's relief. */
  induced: number;
  /** Separated-flow drag at high angle of attack. */
  separated: number;
  /** The gear in proportion to its travel, and damaged doors. */
  gear: number;
  flaps: number;
  speedbrake: number;
  stores: number;
}

export function emptyDrag(): DragBreakdown {
  return { cd0: 0, induced: 0, separated: 0, gear: 0, flaps: 0, speedbrake: 0, stores: 0 };
}

/** The speedbrake's share of its full drag (and pitch moment) at deflection `delta` (rad). */
export function speedbrakeShare(spec: FlightSpec, delta: number): number {
  const sbMax = Math.sin(spec.speedbrake.maxDeflection);
  const sbSin = Math.sin(delta);
  return (sbSin * sbSin) / (sbMax * sbMax);
}

export interface DragState {
  cl: number;
  /** Angle of attack (rad). */
  alpha: number;
  mach: number;
  /** Gear 0..1 and flaps 0..1 (they follow the gear), and damaged doors. */
  gear: number;
  flaps: number;
  gearDamaged: boolean;
  /** The speedbrake's share of its full drag (speedbrakeShare). */
  speedbrake: number;
  /** Ground effect 0..1 (exp(−2.5 h / span)). */
  groundEffect: number;
}

/** Fills `out` with the drag terms for state `s` and returns their sum, CD. */
export function dragCoefficient(
  spec: FlightSpec,
  s: Readonly<DragState>,
  out: DragBreakdown,
): number {
  const a = spec.aero;
  // Separated flow by |α|, folded past 90° (a tail slide meets the flow on the same plate).
  const absA = Math.abs(s.alpha);
  out.cd0 = lookup(a.cd0, s.mach);
  out.induced = a.induced * s.cl * s.cl * (1 - a.groundEffectDrag * s.groundEffect);
  out.separated = lookup(a.cdSeparated, absA <= Math.PI / 2 ? absA : Math.PI - absA);
  out.gear = a.cdGear * s.gear + (s.gearDamaged ? a.cdGearDamage : 0);
  out.flaps = a.cdFlaps * s.flaps;
  out.speedbrake = a.cdSpeedbrake * s.speedbrake;
  out.stores = a.cdStores;
  return (
    out.cd0 + out.induced + out.separated + out.gear + out.flaps + out.speedbrake + out.stores
  );
}
