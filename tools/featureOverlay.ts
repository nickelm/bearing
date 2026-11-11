/**
 * Draws the named features (S2, decision 95) onto an offline map: polygon features
 * as tints per feature, ridge lines, river stems, peaks, straits and anchors.
 */
import {
  FEATURE_KIND_NAMES,
  FeatureKind,
  featureAnchor,
  featurePolyline,
} from '../src/worldgen/strategic/graph';
import type { FeatureList } from '../src/worldgen/strategic/graph';
import type { MapCanvas, Rgb } from './mapCanvas';

/** A stable pastel per feature id. */
function hashColor(id: number, base: Rgb, spread: number): Rgb {
  let h = (id + 1) * 2654435761;
  h ^= h >>> 15;
  const r = ((h >>> 0) % 1000) / 1000 - 0.5;
  const g = (((h >>> 10) >>> 0) % 1000) / 1000 - 0.5;
  const b = (((h >>> 20) >>> 0) % 1000) / 1000 - 0.5;
  const c = (x: number) => Math.min(1, Math.max(0, x));
  return [c(base[0] + r * spread), c(base[1] + g * spread), c(base[2] + b * spread)];
}

const WATER: Record<number, Rgb> = {
  [FeatureKind.Ocean]: [0.12, 0.22, 0.42],
  [FeatureKind.Sea]: [0.2, 0.38, 0.6],
  [FeatureKind.Bay]: [0.35, 0.6, 0.8],
  [FeatureKind.Lake]: [0.3, 0.7, 0.85],
};
const LAND: Record<number, Rgb> = {
  [FeatureKind.Range]: [0.55, 0.38, 0.25],
  [FeatureKind.Hills]: [0.72, 0.62, 0.42],
  [FeatureKind.Plain]: [0.72, 0.8, 0.5],
  [FeatureKind.Plateau]: [0.75, 0.55, 0.55],
  [FeatureKind.Desert]: [0.95, 0.82, 0.5],
  [FeatureKind.Forest]: [0.2, 0.5, 0.25],
  [FeatureKind.Wetland]: [0.35, 0.6, 0.55],
};

/** Per-cell tint for the features map: cover over relief over water; null keeps the base map. */
export function featureCellColor(f: FeatureList, cell: number): Rgb | null {
  const cover = f.layers.cover[cell]!;
  if (cover >= 0) return hashColor(cover, LAND[f.kind[cover]!]!, 0.15);
  const relief = f.layers.relief[cell]!;
  if (relief >= 0) return hashColor(relief, LAND[f.kind[relief]!]!, 0.15);
  const water = f.layers.water[cell]!;
  if (water >= 0) return hashColor(water, WATER[f.kind[water]!]!, 0.25);
  return null;
}

export function drawFeatures(c: MapCanvas, f: FeatureList): void {
  for (let i = 0; i < f.count; i++) {
    const k = f.kind[i]!;
    const line = featurePolyline(f, i);
    if (k === FeatureKind.River) {
      c.polyline(line, 0.8 + 2.2 * f.importance[i]!, () => [0.1, 0.3, 0.95]);
    } else if (k === FeatureKind.Range) {
      c.polyline(line, 2, () => [0.3, 0.15, 0.05]);
    }
  }
  for (let i = 0; i < f.count; i++) {
    const k = f.kind[i]!;
    const p = featureAnchor(f, i);
    if (k === FeatureKind.Peak) c.dot(p, 1.5 + 3 * f.importance[i]!, [0.15, 0.05, 0]);
    else if (k === FeatureKind.Strait) c.square(p, 3, [1, 0.2, 1]);
    else if (k !== FeatureKind.River) c.dot(p, 2, [1, 1, 1]);
  }
}

/** One line per feature, most important first: kind, name, size, importance. */
export function featureTable(f: FeatureList, limit = Infinity): string {
  const ids = [...Array(f.count).keys()].sort(
    (a, b) => f.importance[b]! - f.importance[a]! || a - b,
  );
  return ids
    .slice(0, limit)
    .map((i) => {
      const k = f.kind[i]!;
      const size =
        k === FeatureKind.River
          ? `${Math.round(f.size[i]! / 1e3)} km, ${Math.round(f.measure[i]!)} m³/s`
          : k === FeatureKind.Peak
            ? `${Math.round(f.height[i]!)} m, prominence ${Math.round(f.measure[i]!)} m`
            : k === FeatureKind.Strait
              ? `${Math.round(f.measure[i]! / 1e3)} km wide`
              : `${Math.round(f.size[i]! / 1e6).toLocaleString('en-US')} km²`;
      return `${f.importance[i]!.toFixed(2)}  ${FEATURE_KIND_NAMES[k]!.padEnd(11)} ${f.names[i]!.padEnd(28)} ${size}`;
    })
    .join('\n');
}
