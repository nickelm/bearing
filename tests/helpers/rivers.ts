/** Synthetic rivers for tests. */
import { latLonToDirection } from '../../src/core/coords';
import { DEG } from '../../src/core/units';
import type { Rivers } from '../../src/worldgen/rivers';

/** One straight river along the equator from lon 10° to 10.5° (about 8.7 km). */
export function straightRiver(width: number): Rivers {
  const pts = 8;
  const points = new Float64Array(pts * 3);
  for (let i = 0; i < pts; i++) {
    const d = latLonToDirection(0, (10 + (0.5 * i) / (pts - 1)) * DEG);
    points.set([d.x, d.y, d.z], i * 3);
  }
  return {
    count: 1,
    offsets: Uint32Array.from([0, pts]),
    cells: new Int32Array(pts),
    points,
    discharge: new Float32Array(pts).fill((width / 4) ** 2),
    width: new Float32Array(pts).fill(width),
    downstream: Int32Array.from([-1]),
  };
}
