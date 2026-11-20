/**
 * The street tensor field (proposal 0009, decision 262), after Chen, Esch, Wonka,
 * Müller and Zhang, "Interactive Procedural Street Modeling" (SIGGRAPH 2008).
 *
 * A tensor is stored as w (cos 2θ, sin 2θ), so opposite directions add, and the
 * field is the sum of basis tensors, each with a weight that falls off with distance:
 *
 * - a seeded **base grid** everywhere, weakly;
 * - a **grid field** along each arterial (Gaussian falloff over `arterialReach`);
 * - a **radial field** round the center (radial avenues and rings), by style;
 * - **boundary fields** along rivers, coasts and rails;
 * - **contour fields** where the ground slopes, rising from 3% to dominate at 10%.
 *
 * The major eigenvector points along θ; the minor one across it.
 */
import { Lattice, LineSet, smoothstep } from './geom';
import type { SettlementGround } from './types';

export interface FieldOptions {
  baseAngle: number;
  arterialReach: number;
  radialWeight: number;
  /** Scale (m) of the radial field's falloff. */
  radialReach: number;
  boundaryReach: number;
  /** The contour field's weight on steep ground. */
  contourWeight: number;
}

/** Heights on a lazy lattice, so tracing asks the ground once per lattice point. */
export class GroundCache {
  private readonly cells = new Map<number, number>();
  constructor(
    private readonly ground: SettlementGround,
    readonly step = 30,
  ) {}

  private at(i: number, j: number): number {
    const k = (i + 100_000) * 200_000 + (j + 100_000);
    let h = this.cells.get(k);
    if (h === undefined) {
      h = this.ground.height(i * this.step, j * this.step);
      this.cells.set(k, h);
    }
    return h;
  }

  height(x: number, y: number): number {
    const fx = x / this.step;
    const fy = y / this.step;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const u = fx - i;
    const v = fy - j;
    const a = this.at(i, j);
    const b = this.at(i + 1, j);
    const c = this.at(i, j + 1);
    const d = this.at(i + 1, j + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  /** Gradient (rise per meter) by central differences over one lattice step. */
  gradient(x: number, y: number): [number, number] {
    const s = this.step;
    return [
      (this.height(x + s, y) - this.height(x - s, y)) / (2 * s),
      (this.height(x, y + s) - this.height(x, y - s)) / (2 * s),
    ];
  }
}

export interface FieldLines {
  arterials: { points: number[]; weight: number }[];
  boundaries: { points: number[]; weight: number }[];
}

/** Lattice spacing (m) of the cached field: basis tensors vary over hundreds of meters. */
const FIELD_STEP = 20;

export class TensorField {
  private readonly arterials: LineSet;
  private readonly boundaries: LineSet;
  private readonly cache: Lattice<[number, number, number]>;

  constructor(
    lines: FieldLines,
    private readonly ground: GroundCache,
    readonly options: FieldOptions,
  ) {
    this.arterials = new LineSet(lines.arterials, 300);
    this.boundaries = new LineSet(lines.boundaries, 300);
    this.cache = new Lattice(FIELD_STEP, (x, y) => this.exact(x, y));
  }

  /** The summed tensor (w cos 2θ, w sin 2θ) and the slope at (x, y). */
  private exact(x: number, y: number): [number, number, number] {
    const o = this.options;
    let sx = 0.08 * Math.cos(2 * o.baseAngle);
    let sy = 0.08 * Math.sin(2 * o.baseAngle);
    const add = (angle: number, w: number) => {
      sx += w * Math.cos(2 * angle);
      sy += w * Math.sin(2 * angle);
    };
    this.arterials.perLine(x, y, 3 * o.arterialReach, (d, a, w) =>
      add(a, w * Math.exp(-((d / o.arterialReach) ** 2))),
    );
    // Boundaries (coasts come as many short pieces): the nearest one only.
    const b = this.boundaries.nearest(x, y, 3 * o.boundaryReach);
    if (b.d < Infinity) add(b.angle, b.weight * Math.exp(-((b.d / o.boundaryReach) ** 2)));
    const rr = Math.hypot(x, y);
    if (o.radialWeight > 0 && rr > 1) {
      add(Math.atan2(y, x), o.radialWeight * Math.exp(-((rr / o.radialReach) ** 2)));
    }
    const [gx, gy] = this.ground.gradient(x, y);
    const slope = Math.hypot(gx, gy);
    if (slope > 0.03) {
      add(Math.atan2(gy, gx) + Math.PI / 2, o.contourWeight * smoothstep(0.03, 0.1, slope));
    }
    return [sx, sy, slope];
  }

  /** The major direction θ (rad) at (x, y), the field's strength and the slope, from the lattice. */
  at(x: number, y: number): { angle: number; strength: number; slope: number } {
    const fx = x / FIELD_STEP;
    const fy = y / FIELD_STEP;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const u = fx - i;
    const v = fy - j;
    const a = this.cache.at(i, j);
    const b = this.cache.at(i + 1, j);
    const c = this.cache.at(i, j + 1);
    const d = this.cache.at(i + 1, j + 1);
    const mix = (k: number) =>
      (a[k]! * (1 - u) + b[k]! * u) * (1 - v) + (c[k]! * (1 - u) + d[k]! * u) * v;
    const sx = mix(0);
    const sy = mix(1);
    return { angle: Math.atan2(sy, sx) / 2, strength: Math.hypot(sx, sy), slope: mix(2) };
  }
}
