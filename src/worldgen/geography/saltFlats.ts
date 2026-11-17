/**
 * Salt flats (decision 210): the playas of closed basins, as point features
 * anchored at each playa's most interior cell. A playa with a straight run of
 * at least `SALT_FLAT_MIN_RUN` is also a natural airstrip site (decision 205:
 * runways keep their real length), which the graph lists for casting.
 */
import { BasinCell } from '../drainage';
import { FeatureKind } from '../strategic/graph';
import type { Point, SaltFlatSite } from '../strategic/graph';
import type { FeatureBuilder } from './builder';
import type { GeographyInput } from './context';

/** Shortest straight run (m) of a playa that can take an airstrip. */
export const SALT_FLAT_MIN_RUN = 4_000;

export function extractSaltFlats(
  input: GeographyInput,
  fb: FeatureBuilder,
  region: Int32Array,
): SaltFlatSite[] {
  const { grid, radius } = input.ctx;
  const basin = input.ctx.basinCell;
  const out: SaltFlatSite[] = [];
  if (!basin) return out;
  const n = grid.cellCount;
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  const cells: number[] = [];
  const R2 = radius * radius;
  for (let s = 0; s < n; s++) {
    if (seen[s] || basin[s] !== BasinCell.Playa) continue;
    cells.length = 0;
    stack.push(s);
    seen[s] = 1;
    while (stack.length > 0) {
      const c = stack.pop()!;
      cells.push(c);
      for (let k = 0; k < 8; k++) {
        const m = grid.neighbors8[c * 8 + k]!;
        if (m < 0 || seen[m] || basin[m] !== BasinCell.Playa) continue;
        seen[m] = 1;
        stack.push(m);
      }
    }
    let area = 0;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const c of cells) {
      const a = grid.areas[c]! * R2;
      area += a;
      x += grid.centers[3 * c]! * a;
      y += grid.centers[3 * c + 1]! * a;
      z += grid.centers[3 * c + 2]! * a;
    }
    // Anchor: the member nearest the centroid; extent: the farthest member from it.
    let best = cells[0]!;
    let bestDot = -2;
    const l = Math.hypot(x, y, z);
    for (const c of cells) {
      const d =
        (grid.centers[3 * c]! * x + grid.centers[3 * c + 1]! * y + grid.centers[3 * c + 2]! * z) /
        l;
      if (d > bestDot) {
        bestDot = d;
        best = c;
      }
    }
    let far = 0;
    for (const c of cells) far = Math.max(far, grid.angleBetween(best, c) * radius);
    const cellSize = Math.sqrt(area / cells.length);
    // A run across the playa: its longest chord, which a cell adds a cell's width to.
    const run = 2 * far + cellSize;
    const anchor: Point = [
      grid.centers[3 * best]!,
      grid.centers[3 * best + 1]!,
      grid.centers[3 * best + 2]!,
    ];
    const feature = fb.add({
      kind: FeatureKind.SaltFlat,
      anchor,
      extent: far + cellSize / 2,
      size: area,
      height: input.ctx.height[best]!,
      measure: run,
      magnitude: area,
      region: region[best]!,
    });
    out.push({ feature, cell: best, area, airstrip: run >= SALT_FLAT_MIN_RUN });
  }
  return out;
}
