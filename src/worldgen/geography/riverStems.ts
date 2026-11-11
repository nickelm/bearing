/**
 * River main stems (decision 95) from the coarse drainage: receivers and discharge.
 *
 * - **Mouths.** Land cells that drain into the sea or nowhere (inland basins).
 * - **Stems.** From each mouth with at least `mainDischarge`, upstream through the
 *   donor with the most discharge, until the discharge falls below
 *   STEM_END_FRACTION of the mouth's (and at least `mainDischarge` / 4).
 * - **Tributaries.** A donor joining a stem with at least `mainDischarge` and at
 *   least TRIBUTARY_FRACTION of the stem's discharge there starts a stem of its
 *   own, ending at the confluence, with the stem as its parent.
 * - Stems shorter than STEM_MIN_LENGTH are dropped. Importance follows the mouth
 *   discharge over `mainDischarge`.
 *
 * `mainDischarge` adapts to the world: the larger of MAIN_DISCHARGE_MIN and the
 * discharge of the MAIN_STEM_TARGET-th largest mouth, so a wet world names its
 * big rivers and not every creek.
 */
import { FeatureKind } from '../strategic/graph';
import type { Point } from '../strategic/graph';
import type { FeatureBuilder } from './builder';
import type { GeographyInput } from './context';
import { cellPoint, polylineLength, simplify, smooth } from './shape';

export const MAIN_DISCHARGE_MIN = 100;
export const MAIN_STEM_TARGET = 60;
export const STEM_END_FRACTION = 0.03;
export const TRIBUTARY_FRACTION = 0.3;
export const STEM_MIN_LENGTH = 60e3;

export function extractRivers(input: GeographyInput, fb: FeatureBuilder, region: Int32Array): void {
  const { grid, height, discharge, receiver, radius } = input.ctx;
  const N = grid.cellCount;
  // Donors in CSR form.
  const count = new Int32Array(N + 1);
  for (let c = 0; c < N; c++) {
    const r = receiver[c]!;
    if (height[c]! > 0 && r >= 0) count[r + 1]!++;
  }
  for (let c = 0; c < N; c++) count[c + 1]! += count[c]!;
  const donors = new Int32Array(count[N]!);
  const fill = count.slice(0, N);
  for (let c = 0; c < N; c++) {
    const r = receiver[c]!;
    if (height[c]! > 0 && r >= 0) donors[fill[r]!++] = c;
  }
  const mouths: number[] = [];
  for (let c = 0; c < N; c++) {
    if (height[c]! <= 0) continue;
    const r = receiver[c]!;
    if (r < 0 || height[r]! <= 0) mouths.push(c);
  }
  mouths.sort((a, b) => discharge[b]! - discharge[a]! || a - b);
  const main = Math.max(
    MAIN_DISCHARGE_MIN,
    discharge[mouths[Math.min(mouths.length - 1, MAIN_STEM_TARGET - 1)] ?? 0] ?? 0,
  );

  const tol = (0.8 * Math.PI) / 2 / grid.n;
  // Stems in discovery order: [start cell, parent feature], breadth first from the biggest mouths.
  const queue: { cell: number; parent: number }[] = mouths
    .filter((c) => discharge[c]! >= main)
    .map((cell) => ({ cell, parent: -1 }));
  for (let h = 0; h < queue.length; h++) {
    const { cell: mouth, parent } = queue[h]!;
    const qMouth = discharge[mouth]!;
    const end = Math.max(main / 4, STEM_END_FRACTION * qMouth);
    const path = [mouth];
    const tributaries: number[] = [];
    let cur = mouth;
    for (;;) {
      let best = -1;
      for (let k = count[cur]!; k < count[cur + 1]!; k++) {
        const d = donors[k]!;
        if (
          best < 0 ||
          discharge[d]! > discharge[best]! ||
          (discharge[d] === discharge[best] && d < best)
        )
          best = d;
      }
      if (best < 0 || discharge[best]! < end) break;
      for (let k = count[cur]!; k < count[cur + 1]!; k++) {
        const d = donors[k]!;
        if (
          d !== best &&
          discharge[d]! >= main &&
          discharge[d]! >= TRIBUTARY_FRACTION * discharge[best]!
        )
          tributaries.push(d);
      }
      path.push(best);
      cur = best;
    }
    // Source to mouth; a tributary ends at its confluence.
    const cells = path.reverse();
    const pts: Point[] = cells.map((c) => cellPoint(grid, c));
    if (parent >= 0) {
      const conf = receiver[mouth]!;
      if (conf >= 0) pts.push(cellPoint(grid, conf));
    }
    const length = polylineLength(pts, radius);
    if (length < STEM_MIN_LENGTH) continue;
    const line = smooth(simplify(pts, tol), 2);
    const mid = cells[Math.floor(cells.length / 2)]!;
    let extent = 0;
    const a = cellPoint(grid, mid);
    for (const p of pts) {
      extent = Math.max(extent, Math.acos(Math.min(1, a[0] * p[0] + a[1] * p[1] + a[2] * p[2])));
    }
    const id = fb.add({
      kind: FeatureKind.River,
      anchor: a,
      extent: extent * radius,
      size: length,
      height: Math.max(0, height[cells[0]!]!),
      measure: qMouth,
      magnitude: qMouth / main,
      parent,
      region: region[mouth]!,
      polyline: line,
    });
    for (const t of tributaries) queue.push({ cell: t, parent: id });
  }
}
