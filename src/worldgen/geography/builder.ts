/**
 * Accumulates named-feature records in id order and packs them into a FeatureList
 * (decision 95). Importance is set when packing, from each feature's magnitude on a
 * per-kind log scale times a per-kind weight, so it compares across kinds.
 */
import { FEATURE_LAYER, FeatureKind } from '../strategic/graph';
import type { FeatureLayer, FeatureList, Point } from '../strategic/graph';

export interface FeatureRecord {
  kind: FeatureKind;
  anchor: Point;
  extent: number;
  size: number;
  height: number;
  measure: number;
  /** What importance scales with (area, discharge, prominence…), in the units of IMPORTANCE_SCALE. */
  magnitude: number;
  parent?: number;
  region: number;
  polyline?: readonly Point[];
  /** Cells in the kind's raster layer. */
  cells?: readonly number[];
}

/** Per kind: [weight, magnitude at score 0, magnitude at score 1] (log scale). */
export const IMPORTANCE_SCALE: Record<FeatureKind, [number, number, number]> = {
  [FeatureKind.Continent]: [1, 250_000e6, 4_000_000e6],
  [FeatureKind.Island]: [0.7, 150e6, 250_000e6],
  [FeatureKind.Archipelago]: [0.75, 1_000e6, 200_000e6],
  [FeatureKind.Ocean]: [1, 1_200_000e6, 8_000_000e6],
  [FeatureKind.Sea]: [0.85, 50_000e6, 1_200_000e6],
  [FeatureKind.Bay]: [0.55, 3_000e6, 60_000e6],
  // Straits: magnitude is 1 − width / STRAIT_MAX_WIDTH, narrower is more notable.
  [FeatureKind.Strait]: [0.65, 0.05, 1],
  [FeatureKind.Lake]: [0.6, 150e6, 20_000e6],
  [FeatureKind.Range]: [0.9, 3_000e6, 300_000e6],
  // Peaks: prominence in reference meters.
  [FeatureKind.Peak]: [0.6, 500, 4_000],
  [FeatureKind.Hills]: [0.45, 4_000e6, 100_000e6],
  [FeatureKind.Plain]: [0.6, 40_000e6, 1_000_000e6],
  [FeatureKind.Plateau]: [0.65, 10_000e6, 300_000e6],
  [FeatureKind.Desert]: [0.8, 15_000e6, 1_000_000e6],
  [FeatureKind.Forest]: [0.7, 20_000e6, 1_000_000e6],
  [FeatureKind.Wetland]: [0.5, 1_500e6, 50_000e6],
  // Rivers: discharge at the mouth relative to the main-stem threshold.
  [FeatureKind.River]: [0.75, 1, 60],
};

export function importanceOf(kind: FeatureKind, magnitude: number): number {
  const [w, lo, hi] = IMPORTANCE_SCALE[kind];
  const t = Math.log(Math.max(magnitude, 1e-12) / lo) / Math.log(hi / lo);
  return w * (0.35 + 0.65 * Math.min(1, Math.max(0, t)));
}

export class FeatureBuilder {
  readonly records: FeatureRecord[] = [];
  readonly layers: Record<FeatureLayer, Int16Array>;

  constructor(cellCount: number) {
    this.layers = {
      land: new Int16Array(cellCount).fill(-1),
      water: new Int16Array(cellCount).fill(-1),
      relief: new Int16Array(cellCount).fill(-1),
      cover: new Int16Array(cellCount).fill(-1),
    };
  }

  get count(): number {
    return this.records.length;
  }

  add(r: FeatureRecord): number {
    const id = this.records.length;
    if (id >= 0x7fff) throw new RangeError('too many named features for an Int16 layer');
    this.records.push(r);
    const layer = FEATURE_LAYER[r.kind];
    if (layer && r.cells) {
      const map = this.layers[layer];
      for (const c of r.cells) map[c] = id;
    }
    return id;
  }

  pack(): FeatureList {
    const n = this.records.length;
    const f: FeatureList = {
      count: n,
      kind: new Uint8Array(n),
      importance: new Float32Array(n),
      anchor: new Float64Array(n * 3),
      extent: new Float32Array(n),
      size: new Float32Array(n),
      height: new Float32Array(n),
      measure: new Float32Array(n),
      parent: new Int32Array(n),
      region: new Int32Array(n),
      offsets: new Uint32Array(n + 1),
      points: new Float64Array(this.records.reduce((s, r) => s + (r.polyline?.length ?? 0), 0) * 3),
      layers: this.layers,
      names: this.records.map(() => ''),
    };
    let p = 0;
    this.records.forEach((r, i) => {
      f.kind[i] = r.kind;
      f.importance[i] = importanceOf(r.kind, r.magnitude);
      f.anchor.set(r.anchor, i * 3);
      f.extent[i] = r.extent;
      f.size[i] = r.size;
      f.height[i] = r.height;
      f.measure[i] = r.measure;
      f.parent[i] = r.parent ?? -1;
      f.region[i] = r.region;
      f.offsets[i] = p;
      for (const q of r.polyline ?? []) f.points.set(q, 3 * p++);
    });
    f.offsets[n] = p;
    return f;
  }
}
