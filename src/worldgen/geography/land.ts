/**
 * Land features (decision 95): continents and islands from the labeled landmasses,
 * and archipelagos from the graph's archipelago nodes.
 *
 * - **Continents** are landmasses of at least CONTINENT_MIN_AREA; smaller
 *   landmasses of at least ISLAND_MIN_AREA are islands.
 * - **Archipelagos** are the graph's archipelago nodes: their islands get the
 *   archipelago as `parent`, and their label axis runs along the cluster's
 *   principal direction across its extent.
 * - Each land node's `feature` is set to its continent, island or archipelago.
 */
import { FeatureKind } from '../strategic/graph';
import type { FeatureBuilder } from './builder';
import type { GeographyInput } from './context';
import { along, cellPoint, dot, normalize, regionShape, tangentFrame } from './shape';

export const CONTINENT_MIN_AREA = 250_000e6;
export const ISLAND_MIN_AREA = 150e6;

export function extractLand(input: GeographyInput, fb: FeatureBuilder, region: Int32Array): void {
  const { grid, labels, height, radius } = input.ctx;
  const lms = labels.landmasses;
  const cellsOf: number[][] = lms.map(() => []);
  for (let c = 0; c < grid.cellCount; c++) {
    const l = labels.label[c]!;
    if (l >= 0) cellsOf[l]!.push(c);
  }
  const featureOf = new Int32Array(lms.length).fill(-1);
  for (const lm of lms) {
    if (lm.area < ISLAND_MIN_AREA) continue;
    const cells = cellsOf[lm.id]!;
    const shape = regionShape(grid, cells, (c) => labels.label[c] === lm.id, radius);
    let top = 0;
    for (const c of cells) top = Math.max(top, height[c]!);
    const kind = lm.area >= CONTINENT_MIN_AREA ? FeatureKind.Continent : FeatureKind.Island;
    featureOf[lm.id] = fb.add({
      kind,
      anchor: shape.anchor,
      extent: shape.extent,
      size: lm.area,
      height: top,
      measure: 0,
      magnitude: lm.area,
      region:
        input.nodeOfLandmass[lm.id]! >= 0
          ? input.nodeOfLandmass[lm.id]!
          : region[shape.anchorCell]!,
      polyline: shape.axis,
      cells,
    });
  }

  input.nodes.forEach((node, id) => {
    if (node.kind === 'landmass') {
      node.feature = featureOf[input.members[id]![0]!]!;
      return;
    }
    // Principal direction of the member islands around the node's centroid.
    const anchor = node.centroid;
    const { east, north } = tangentFrame(anchor);
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    let top = 0;
    for (const l of input.members[id]!) {
      for (const c of cellsOf[l]!) {
        const p = cellPoint(grid, c);
        const k = dot(p, anchor);
        top = Math.max(top, height[c]!);
        if (k <= 0.05) continue;
        const x = dot(p, east) / k;
        const y = dot(p, north) / k;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
      }
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const dir = normalize([
      east[0] * Math.cos(theta) + north[0] * Math.sin(theta),
      east[1] * Math.cos(theta) + north[1] * Math.sin(theta),
      east[2] * Math.cos(theta) + north[2] * Math.sin(theta),
    ]);
    const t = (0.8 * node.extent) / radius;
    const arch = fb.add({
      kind: FeatureKind.Archipelago,
      anchor,
      extent: node.extent,
      size: node.area,
      height: top,
      measure: 0,
      magnitude: node.area,
      region: id,
      polyline: [along(anchor, dir, -t), anchor, along(anchor, dir, t)],
    });
    node.feature = arch;
    for (const l of input.members[id]!) {
      const f = featureOf[l]!;
      if (f >= 0) fb.records[f]!.parent = arch;
    }
  });
}
