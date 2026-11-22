/**
 * Life curves of the puffs (Proposal 0011, decision 320): a puff's radius, color, glow,
 * coverage and rise follow curves over its life, from birth (0) to death (1). A curve is a
 * list of keys; `sampleCurve` reads it piecewise linearly, and `CURVE_SAMPLES` evenly spaced
 * samples of every look's curves go into one table that the compute pass reads.
 */

/** A key: [time 0..1 of the life, value]. Keys are in increasing time. */
export type CurveKey = readonly [number, number];
export type Curve = readonly CurveKey[];
/** A color key: [time, r, g, b], linear RGB. */
export type ColorKey = readonly [number, number, number, number];
export type ColorCurve = readonly ColorKey[];

/** Samples per curve in the table: the compute pass interpolates between them. */
export const CURVE_SAMPLES = 16;
/** vec4 rows per sample: (r, g, b, glow) and (radius, coverage, rise, 0). */
export const CURVE_ROWS = 2;

/** The value of `curve` at `t` (clamped to its ends). */
export function sampleCurve(curve: Curve, t: number): number {
  if (curve.length === 0) return 0;
  if (t <= curve[0]![0]) return curve[0]![1];
  for (let i = 1; i < curve.length; i++) {
    const b = curve[i]!;
    if (t <= b[0]) {
      const a = curve[i - 1]!;
      const k = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 1;
      return a[1] + (b[1] - a[1]) * k;
    }
  }
  return curve[curve.length - 1]![1];
}

/** The color of `curve` at `t`. */
export function sampleColor(curve: ColorCurve, t: number): [number, number, number] {
  const ch = (c: number): number =>
    sampleCurve(
      curve.map((k) => [k[0], k[c]!] as const),
      t,
    );
  return [ch(1), ch(2), ch(3)];
}

/** What the table holds of one look. */
export interface LookCurves {
  color: ColorCurve;
  glow: Curve;
  radius: Curve;
  coverage: Curve;
  rise: Curve;
}

/**
 * The table of every look's curves: look-major, then sample, then row; each row a vec4.
 * Row 0 is (r, g, b, glow), row 1 (radius, coverage, rise, 0).
 */
export function curveTable(looks: readonly LookCurves[]): Float32Array {
  const out = new Float32Array(looks.length * CURVE_SAMPLES * CURVE_ROWS * 4);
  looks.forEach((l, li) => {
    for (let s = 0; s < CURVE_SAMPLES; s++) {
      const t = s / (CURVE_SAMPLES - 1);
      const o = (li * CURVE_SAMPLES + s) * CURVE_ROWS * 4;
      const c = sampleColor(l.color, t);
      out.set([c[0], c[1], c[2], sampleCurve(l.glow, t)], o);
      out.set(
        [sampleCurve(l.radius, t), sampleCurve(l.coverage, t), sampleCurve(l.rise, t), 0],
        o + 4,
      );
    }
  });
  return out;
}

/**
 * The table read at `t` for a look, interpolating between samples as the compute pass does:
 * the CPU reference (puffModel.ts) uses it, so tests compare like with like.
 */
export function readTable(
  table: Float32Array,
  look: number,
  t: number,
  row: 0 | 1,
): [number, number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (CURVE_SAMPLES - 1);
  const i0 = Math.min(CURVE_SAMPLES - 2, Math.floor(x));
  const f = x - i0;
  const at = (s: number) => ((look * CURVE_SAMPLES + s) * CURVE_ROWS + row) * 4;
  const a = at(i0);
  const b = at(i0 + 1);
  return [0, 1, 2, 3].map((c) => table[a + c]! * (1 - f) + table[b + c]! * f) as [
    number,
    number,
    number,
    number,
  ];
}
