/**
 * A zone's palette shift on the terrain's colors (decision 210): hue, saturation
 * and value from its recipe, within the limits of docs/visual-style.md (*Zones*).
 * The shift fades to nothing at a boundary, from both sides, so neighboring zones
 * meet without a seam; where a barrier divides them the boundary sits on it.
 * Pure: no three.js, so tests and tools use it as the renderer does.
 */
import { directionToCubeFace } from '../../core/coords';
import type { Vec3d } from '../../core/vec3d';
import { NO_ZONE, ZONE_TUNING } from '../../worldgen/zones';
import type { Zones } from '../../worldgen/zones';
import type { Rgb } from './palette';

function rgbToHsv([r, g, b]: Rgb): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-9) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max > 0 ? d / max : 0, max];
}

function hsvToRgb(h: number, s: number, v: number): Rgb {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const k = Math.floor(h / 60) % 6;
  const [r, g, b] =
    k === 0
      ? [c, x, 0]
      : k === 1
        ? [x, c, 0]
        : k === 2
          ? [0, c, x]
          : k === 3
            ? [0, x, c]
            : k === 4
              ? [x, 0, c]
              : [c, 0, x];
  return [r + m, g + m, b + m];
}

/** A color shifted by the zone under direction `d`, or as it was at sea and on boundaries. */
export type ZoneShift = (rgb: Rgb, d: Readonly<Vec3d>) => Rgb;

export function makeZoneShift(zones: Zones, n: number): ZoneShift {
  const uv = { face: 0, u: 0, v: 0 } as ReturnType<typeof directionToCubeFace>;
  const E = ZONE_TUNING.edgeCells;
  return (rgb, d) => {
    directionToCubeFace(d, uv);
    const i = Math.min(n - 1, Math.max(0, Math.floor(uv.u * n)));
    const j = Math.min(n - 1, Math.max(0, Math.floor(uv.v * n)));
    const c = (uv.face * n + j) * n + i;
    const z = zones.zone[c]!;
    if (z === NO_ZONE) return rgb;
    const rec = zones.records[z];
    if (!rec) return rgb;
    const w = Math.min(1, (zones.edge[c]! + 0.5) / E);
    const [h, s, v] = rgbToHsv(rgb);
    const r = rec.recipe;
    const out = hsvToRgb(
      (h + w * r.hue + 360) % 360,
      Math.min(1, s * (1 + w * (r.saturation - 1))),
      Math.min(1, v * (1 + w * (r.value - 1))),
    );
    return out;
  };
}
