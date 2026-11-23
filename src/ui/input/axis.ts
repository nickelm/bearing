/**
 * Axis tuning (Proposal 0014, decision 362): pure functions from a raw axis value (−1..1) to
 * the value an action reads. The order is inversion, deadzone, response curve, sensitivity.
 *
 * - **Deadzone** is scaled: past it the output starts from 0, so there is no jump.
 * - **Curve** is the expo blend `(1 − e)·v + e·v³`: 0 is linear, 1 is a cube, finer near center.
 * - **Sensitivity** scales the result, clamped to ±1.
 * - **Cross-talk guard** (left stick): each axis has its own (axial) deadzone, and it grows
 *   with the other axis's deflection, so the sideways wobble of a firm push up (collective,
 *   throttle) or the vertical wobble of a firm push sideways (pedals) never registers. A
 *   deliberate diagonal still moves both.
 */

export interface AxisTuning {
  /** Index of the device axis (−1: unbound). */
  axis: number;
  invert: boolean;
  /** 0..0.9 of the travel. */
  deadzone: number;
  /** 0..1: linear to cubic. */
  curve: number;
  /** 0.1..2. */
  sensitivity: number;
}

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** A scaled deadzone: 0 inside `dz`, then linear from 0 to ±1. */
export function deadzone(v: number, dz: number): number {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * Math.min(1, (a - dz) / Math.max(1e-6, 1 - dz));
}

/** The expo response curve. */
export function curve(v: number, e: number): number {
  const k = clamp(e, 0, 1);
  return (1 - k) * v + k * v * v * v;
}

/** One axis through its tuning; `dz` overrides the tuning's deadzone (the cross-talk guard's). */
export function tuneAxis(raw: number, t: Readonly<AxisTuning>, dz = t.deadzone): number {
  const v = t.invert ? -raw : raw;
  return clamp(curve(deadzone(v, dz), t.curve) * t.sensitivity, -1, 1);
}

/**
 * The cross-talk guard's deadzones for a stick's two axes: each axis's own deadzone, or
 * `guard` times the other axis's deflection if that is larger.
 */
export function guardedDeadzones(
  x: number,
  y: number,
  dzX: number,
  dzY: number,
  guard: number,
): { x: number; y: number } {
  return {
    x: Math.max(dzX, guard * Math.abs(y)),
    y: Math.max(dzY, guard * Math.abs(x)),
  };
}

/** Both axes of a stick tuned with the cross-talk guard. */
export function tuneStick(
  rawX: number,
  rawY: number,
  tx: Readonly<AxisTuning>,
  ty: Readonly<AxisTuning>,
  guard: number,
): { x: number; y: number } {
  const dz = guardedDeadzones(rawX, rawY, tx.deadzone, ty.deadzone, guard);
  return { x: tuneAxis(rawX, tx, dz.x), y: tuneAxis(rawY, ty, dz.y) };
}
