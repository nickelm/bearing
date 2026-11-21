/**
 * Stage: the curvature map (Proposal 0010, *Surface*; decision 298), baked once per
 * world on the global grid from the exaggerated heights.
 *
 * Curvature here is how far a cell lies below (concave: valleys, basins, creases;
 * positive) or above (convex: ridges, crests, spurs; negative) the mean of the ground
 * around it, at two scales: the eight neighbors (about 1.5 km at 1024² on the
 * campaign planet) and the neighbors' neighbors (about 3 km). The sum is squashed
 * through tanh by a reference relief, so it lies in (−1, 1) whatever the range.
 *
 * The terrain shader darkens concave and lightens convex ground by it, so relief
 * reads in flat light and from above; the mesh's own facets add the fine scale
 * (`TerrainArt`). Rock dressing reads it too: crest teeth on convex ground, scree in
 * concave feet. Presentation data, like the zones: nothing in the campaign reads it.
 */
import { neighbors8 } from './drainage';

export const CURVATURE_TUNING = {
  /** Height difference from the mean (m) that gives tanh(1) ≈ 0.76. */
  reference: 90,
  /** Weights of the near (8 neighbors) and the far (two hops) scale. */
  near: 0.6,
  far: 0.4,
};

/** Curvature per global cell in (−1, 1): positive concave, negative convex, 0 at sea. */
export function curvatureMap(
  n: number,
  height: Float32Array,
  tuning: Partial<typeof CURVATURE_TUNING> = {},
): Float32Array {
  const t = { ...CURVATURE_TUNING, ...tuning };
  const count = height.length;
  const nb = new Int32Array(8);
  // The sea counts at sea level, so coasts are not cliffs into a deep bowl.
  const land = (c: number) => Math.max(0, height[c]!);
  const mean = (src: (c: number) => number, out: Float32Array) => {
    for (let c = 0; c < count; c++) {
      neighbors8(n, c, nb);
      let s = 0;
      let k = 0;
      for (const m of nb) {
        if (m < 0) continue;
        s += src(m);
        k++;
      }
      out[c] = k ? s / k : src(c);
    }
  };
  const m1 = new Float32Array(count);
  mean(land, m1);
  const m2 = new Float32Array(count);
  mean((c) => m1[c]!, m2);
  const out = new Float32Array(count);
  for (let c = 0; c < count; c++) {
    if (height[c]! <= 0) continue;
    const h = land(c);
    const d = t.near * (m1[c]! - h) + t.far * (m2[c]! - h);
    out[c] = Math.tanh(d / t.reference);
  }
  return out;
}
