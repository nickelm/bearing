/**
 * Stage: river extraction (design doc, pipeline step 6).
 *
 * River cells are land cells whose discharge reaches `minDischarge`. The
 * network is cut into polylines at sources (no river upstream), confluences
 * (two or more rivers upstream) and mouths (the next cell is sea). Each
 * polyline runs downstream and ends on the first cell of the river it joins,
 * or on the sea cell at its mouth, so polylines meet exactly.
 *
 * Widths follow hydraulic geometry, w = a · Q^0.5 (Leopold & Maddock), in
 * real meters. Rivers are not scaled with relief: a river carrying the same
 * water is as wide here as on Earth.
 *
 * Everything is in flat typed arrays, so a worker can transfer it.
 */
import { cubeFaceUvToDirection } from '../core/coords';
import type { CubeFace } from '../core/coords';
import { Vec3d } from '../core/vec3d';

export interface Rivers {
  /** Number of polylines. */
  count: number;
  /** Point range of polyline k: [offsets[k], offsets[k + 1]). Length count + 1. */
  offsets: Uint32Array;
  /** Global-grid cell of each point. */
  cells: Int32Array;
  /** Unit direction of each point, xyz interleaved (float64). */
  points: Float64Array;
  /** Discharge at each point (m³/s). */
  discharge: Float32Array;
  /** Channel width at each point (m). */
  width: Float32Array;
  /** Polyline that polyline k flows into, or −1 if it reaches the sea. */
  downstream: Int32Array;
}

export const RIVER_TUNING = {
  /** Smallest discharge drawn as a river (m³/s). */
  minDischarge: 20,
  /** Coefficient a in w = a · Q^0.5 (m per (m³/s)^0.5). */
  widthCoefficient: 4,
};

export function riverWidth(discharge: number, a = RIVER_TUNING.widthCoefficient): number {
  return a * Math.sqrt(Math.max(0, discharge));
}

/** Unit direction of the center of cell `c` on an n-per-face grid. */
export function cellCenterDirection(n: number, c: number, out = new Vec3d()): Vec3d {
  const nn = n * n;
  const face = Math.floor(c / nn) as CubeFace;
  const r = c - face * nn;
  const j = Math.floor(r / n);
  const i = r - j * n;
  return cubeFaceUvToDirection(face, (i + 0.5) / n, (j + 0.5) / n, out);
}

export function extractRivers(
  n: number,
  height: Float32Array,
  receiver: Int32Array,
  discharge: Float32Array,
  tuning = RIVER_TUNING,
): Rivers {
  const count = 6 * n * n;
  const isRiver = (c: number) => height[c]! > 0 && discharge[c]! >= tuning.minDischarge;

  // River donors per river cell.
  const donors = new Uint8Array(count);
  for (let c = 0; c < count; c++) {
    if (!isRiver(c)) continue;
    const r = receiver[c]!;
    if (r >= 0 && isRiver(r)) donors[r]!++;
  }
  // Polylines start at sources and confluences, in cell order (deterministic).
  const starts: number[] = [];
  for (let c = 0; c < count; c++) if (isRiver(c) && donors[c] !== 1) starts.push(c);
  const startIndex = new Map<number, number>();
  starts.forEach((c, k) => startIndex.set(c, k));

  const offsets = new Uint32Array(starts.length + 1);
  const cells: number[] = [];
  const downstream = new Int32Array(starts.length).fill(-1);
  starts.forEach((start, k) => {
    offsets[k] = cells.length;
    let c = start;
    cells.push(c);
    for (;;) {
      const r = receiver[c]!;
      if (r < 0) break;
      cells.push(r); // Ends on the joined river's first cell, or on the sea cell at the mouth.
      if (!isRiver(r)) break;
      if (donors[r] !== 1) {
        downstream[k] = startIndex.get(r) ?? -1;
        break;
      }
      c = r;
    }
  });
  offsets[starts.length] = cells.length;

  const m = cells.length;
  const points = new Float64Array(m * 3);
  const q = new Float32Array(m);
  const width = new Float32Array(m);
  const d = new Vec3d();
  const cellArr = Int32Array.from(cells);
  for (let p = 0; p < m; p++) {
    const c = cellArr[p]!;
    cellCenterDirection(n, c, d);
    points[p * 3] = d.x;
    points[p * 3 + 1] = d.y;
    points[p * 3 + 2] = d.z;
    q[p] = discharge[c]!;
    width[p] = riverWidth(q[p]!, tuning.widthCoefficient);
  }
  // A mouth point lies on a sea cell (discharge 0); carry the river's flow onto it.
  for (let k = 0; k < starts.length; k++) {
    const last = offsets[k + 1]! - 1;
    if (last > offsets[k]! && height[cellArr[last]!]! <= 0) {
      q[last] = q[last - 1]!;
      width[last] = width[last - 1]!;
    }
  }
  return { count: starts.length, offsets, cells: cellArr, points, discharge: q, width, downstream };
}

/** All typed arrays of a river set, e.g. for a worker transfer list. */
export function riverBuffers(r: Rivers): ArrayBuffer[] {
  return [r.offsets, r.cells, r.points, r.discharge, r.width, r.downstream].map(
    (a) => a.buffer as ArrayBuffer,
  );
}
