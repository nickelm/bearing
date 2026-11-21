/**
 * Villages and farmsteads (proposal 0009, decision 265).
 *
 * - **Villages** are street villages along the road through them, or, for clustered
 *   styles and by chance, a ring lane round a green; a few side lanes branch off.
 *   Parcels are strips along the frontage of every street, both sides, at the style's
 *   width and depth; each holds a house at its front and, on farm plots, a barn behind.
 * - **Farmsteads** are two to five buildings round a yard at a field corner (the
 *   terrain's field Voronoi cells, decision 162) on the farmland round a village or
 *   town, turned to the field boundary.
 */
import type { Rng } from '../../core/rng';
import { fieldAt } from '../canopy';
import { boxCorners, polylineLength, SpatialHash, segDist } from './geom';
import type { Poly } from './geom';
import { boxInside, FLOOR_HEIGHT } from './buildings';
import type { StylePalette } from './styles';
import { BuildingKind, Extra, Roof, Style } from './types';
import type { Building } from './types';

/** Frontage width and depth (m) of a village plot, by style. */
export const VILLAGE_PLOT: readonly [number, number][] = [
  [22, 45],
  [26, 50],
  [14, 26],
  [32, 50],
  [16, 22],
  [30, 55],
  [10, 24],
];

export interface StripParcel {
  polygon: Poly;
  frontage: [number, number, number, number];
  /** The street it fronts. */
  street: number;
}

type Box = [number, number, number, number, number];

/** Separating-axis overlap of two oriented boxes [cx, cy, angle, hl, hw]. */
export function boxesOverlap(a: Box, b: Box): boolean {
  const axes = [a[2], a[2] + Math.PI / 2, b[2], b[2] + Math.PI / 2];
  const ca = boxCorners(a[0], a[1], a[2], a[3], a[4]);
  const cb = boxCorners(b[0], b[1], b[2], b[3], b[4]);
  for (const t of axes) {
    const ux = Math.cos(t);
    const uy = Math.sin(t);
    let a0 = Infinity;
    let a1 = -Infinity;
    let b0 = Infinity;
    let b1 = -Infinity;
    for (let i = 0; i < 4; i++) {
      const pa = ca[i * 2]! * ux + ca[i * 2 + 1]! * uy;
      const pb = cb[i * 2]! * ux + cb[i * 2 + 1]! * uy;
      a0 = Math.min(a0, pa);
      a1 = Math.max(a1, pa);
      b0 = Math.min(b0, pb);
      b1 = Math.max(b1, pb);
    }
    if (a1 <= b0 || b1 <= a0) return false;
  }
  return true;
}

/**
 * Strip parcels along streets: plots of `width` × `depth` m, `gap` m off each street's
 * edge, kept where they stay off water, off every street and off each other, and
 * inside `inside`.
 */
export function stripParcels(
  streets: { points: number[]; halfWidth: number }[],
  width: number,
  depth: number,
  ok: (x: number, y: number) => boolean,
  maxParcels: number,
): StripParcel[] {
  const out: StripParcel[] = [];
  const boxes = new SpatialHash<Box>(80);
  const segs = new SpatialHash<[number, number, number, number, number]>(60);
  for (const s of streets) {
    const p = s.points;
    for (let i = 0; i + 3 < p.length; i += 2) {
      segs.addBox(
        Math.min(p[i]!, p[i + 2]!),
        Math.min(p[i + 1]!, p[i + 3]!),
        Math.max(p[i]!, p[i + 2]!),
        Math.max(p[i + 1]!, p[i + 3]!),
        [p[i]!, p[i + 1]!, p[i + 2]!, p[i + 3]!, s.halfWidth],
      );
    }
  }
  const clearOfStreets = (poly: Poly) => {
    for (let i = 0; i < 4; i++) {
      const x = poly[i * 2]!;
      const y = poly[i * 2 + 1]!;
      if (segs.near(x, y, 20, ([ax, ay, bx, by, hw]) => segDist(x, y, ax, ay, bx, by).d < hw + 1))
        return false;
    }
    return true;
  };
  streets.forEach((s, si) => {
    const p = s.points;
    const L = polylineLength(p);
    // Walk the polyline at `width` steps.
    let seg = 0;
    let segStart = 0;
    for (let at = width / 2; at + width / 2 <= L && out.length < maxParcels; at += width) {
      let segLen = Math.hypot(p[seg * 2 + 2]! - p[seg * 2]!, p[seg * 2 + 3]! - p[seg * 2 + 1]!);
      while (segStart + segLen < at && seg * 2 + 5 < p.length) {
        segStart += segLen;
        seg++;
        segLen = Math.hypot(p[seg * 2 + 2]! - p[seg * 2]!, p[seg * 2 + 3]! - p[seg * 2 + 1]!);
      }
      const t = segLen > 0 ? (at - segStart) / segLen : 0;
      const x = p[seg * 2]! + (p[seg * 2 + 2]! - p[seg * 2]!) * t;
      const y = p[seg * 2 + 1]! + (p[seg * 2 + 3]! - p[seg * 2 + 1]!) * t;
      const ux = (p[seg * 2 + 2]! - p[seg * 2]!) / (segLen || 1);
      const uy = (p[seg * 2 + 3]! - p[seg * 2 + 1]!) / (segLen || 1);
      for (const side of [1, -1]) {
        const nx = -uy * side;
        const ny = ux * side;
        const off = s.halfWidth + 2 + depth / 2;
        const cx = x + nx * off;
        const cy = y + ny * off;
        const angle = Math.atan2(uy, ux);
        const box: Box = [cx, cy, angle, width / 2 - 0.5, depth / 2];
        const poly = boxCorners(cx, cy, angle, box[3], box[4]);
        let good = true;
        for (let i = 0; i < 4 && good; i++) good = ok(poly[i * 2]!, poly[i * 2 + 1]!);
        if (!good || !ok(cx, cy) || !clearOfStreets(poly)) continue;
        if (boxes.near(cx, cy, Math.max(width, depth) * 1.2, (b) => boxesOverlap(b, box))) continue;
        boxes.add(cx, cy, box);
        // The street edge, run so the plot lies on its left (boxCorners is counterclockwise).
        const fx0 = x + nx * (s.halfWidth + 2) - ux * (width / 2 - 0.5);
        const fy0 = y + ny * (s.halfWidth + 2) - uy * (width / 2 - 0.5);
        const fx1 = x + nx * (s.halfWidth + 2) + ux * (width / 2 - 0.5);
        const fy1 = y + ny * (s.halfWidth + 2) + uy * (width / 2 - 0.5);
        out.push({
          polygon: poly,
          frontage: side === 1 ? [fx0, fy0, fx1, fy1] : [fx1, fy1, fx0, fy0],
          street: si,
        });
      }
    }
  });
  return out;
}

type B = Omit<Building, 'parcel' | 'block' | 'landmark'>;

/** A farmhouse at the plot's front and, on farm plots, a barn behind it. */
export function plotBuildings(
  parcel: StripParcel,
  style: Style,
  palette: StylePalette,
  farm: boolean,
  r: Rng,
): B[] {
  const [ax, ay, bx, by] = parcel.frontage;
  const fl = Math.hypot(bx - ax, by - ay) || 1;
  const ux = (bx - ax) / fl;
  const uy = (by - ay) / fl;
  const nx = -uy;
  const ny = ux;
  const angle = Math.atan2(uy, ux);
  const out: B[] = [];
  const floors =
    palette.houseFloors[0] +
    Math.floor(r.nextFloat() * (palette.houseFloors[1] - palette.houseFloors[0] + 1));
  const hl = Math.min(fl / 2 - 2, 4 + r.nextFloat() * 3);
  const hw = 4 + r.nextFloat() * 1.5;
  const front = style === Style.Mediterranean || style === Style.Arid ? 0.8 : 4 + r.nextFloat() * 3;
  const along = fl / 2 + (r.nextFloat() - 0.5) * (fl - 2 * hl - 2) * 0.5;
  const cx = ax + ux * along + nx * (front + hw);
  const cy = ay + uy * along + ny * (front + hw);
  const roofU = r.nextFloat();
  let roof = palette.houseRoofs[0]![0];
  let acc = 0;
  for (const [k, w] of palette.houseRoofs) {
    acc += w;
    if (roofU < acc) {
      roof = k;
      break;
    }
  }
  const pal = (l: readonly number[]) => l[Math.floor(r.nextFloat() * l.length) % l.length]!;
  if (hl > 2.5 && boxInside(parcel.polygon, cx, cy, angle, hl, hw)) {
    out.push({
      kind: farm ? BuildingKind.Farm : BuildingKind.House,
      x: cx,
      y: cy,
      angle,
      halfLength: hl,
      halfWidth: hw,
      height: floors * FLOOR_HEIGHT + 0.5,
      floors,
      roof,
      roofHeight: roof === Roof.Flat ? 0 : 2 * hw * palette.pitch * 0.5,
      wall: pal(palette.walls),
      roofColor: pal(roof === Roof.Flat ? palette.flatRoofs : palette.roofs),
      extras: r.nextFloat() < palette.chimneys ? Extra.Chimney : 0,
    });
  }
  if (farm) {
    const bhl = Math.min(fl / 2 - 2, 7 + r.nextFloat() * 4);
    const bhw = 5 + r.nextFloat() * 2;
    const back = front + 2 * hw + 6 + bhw;
    const bxc = ax + ux * (fl / 2) + nx * back;
    const byc = ay + uy * (fl / 2) + ny * back;
    if (bhl > 3 && boxInside(parcel.polygon, bxc, byc, angle, bhl, bhw)) {
      out.push({
        kind: BuildingKind.Barn,
        x: bxc,
        y: byc,
        angle,
        halfLength: bhl,
        halfWidth: bhw,
        height: 5 + r.nextFloat() * 2,
        floors: 1,
        roof: style === Style.Arid ? Roof.Flat : Roof.Gable,
        roofHeight: style === Style.Arid ? 0 : bhw * palette.pitch,
        wall: style === Style.Nordic ? 0x8e3b2e : pal(palette.walls),
        roofColor: pal(palette.roofs),
        extras: 0,
      });
    }
  }
  return out;
}

/**
 * A field corner near local (x, y): a point on a field boundary (decision 162) with a
 * third field within 30 m, searched on a 15 m lattice within `reach` m. `toSea` maps
 * local coordinates to the sea-level sphere (m). Returns the corner and the boundary's
 * direction there, or null.
 */
export function fieldCorner(
  x: number,
  y: number,
  reach: number,
  toSea: (x: number, y: number) => [number, number, number],
  seed: number,
): { x: number; y: number; angle: number } | null {
  let best: { x: number; y: number; angle: number } | null = null;
  let bestD = Infinity;
  const step = 15;
  const key = (c: readonly number[]) => `${c[0]},${c[1]},${c[2]}`;
  for (let j = -reach; j <= reach; j += step) {
    for (let i = -reach; i <= reach; i += step) {
      const d = Math.hypot(i, j);
      if (d > reach || d >= bestD) continue;
      const px = x + i;
      const py = y + j;
      const f = fieldAt(...toSea(px, py), seed);
      if (f.edge > 6) continue;
      const own = new Set([key(f.cell), key(f.cell2)]);
      let third = false;
      for (let k = 0; k < 6 && !third; k++) {
        const a = (k / 6) * 2 * Math.PI;
        const g = fieldAt(...toSea(px + 30 * Math.cos(a), py + 30 * Math.sin(a)), seed);
        if (!own.has(key(g.cell))) third = true;
      }
      if (!third) continue;
      // Boundary direction: across the gradient of the edge distance.
      const e1 = fieldAt(...toSea(px + 4, py), seed).edge;
      const e2 = fieldAt(...toSea(px, py + 4), seed).edge;
      const angle = Math.atan2(e2 - f.edge, e1 - f.edge) + Math.PI / 2;
      best = { x: px, y: py, angle };
      bestD = d;
    }
  }
  return best;
}

/** Two to five farm buildings round a yard, turned to `angle`. */
export function farmstead(
  x: number,
  y: number,
  angle: number,
  palette: StylePalette,
  style: Style,
  r: Rng,
): B[] {
  const n = 2 + Math.floor(r.nextFloat() * 4);
  const out: B[] = [];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // Slots round a 20 m yard: house, barn opposite, sheds on the sides.
  const slots: [number, number, number, number, BuildingKind][] = [
    [0, -16, 6, 4.5, BuildingKind.Farm],
    [0, 17, 11, 6, BuildingKind.Barn],
    [-17, 0, 4, 7, BuildingKind.Barn],
    [17, 0, 4, 6, BuildingKind.Barn],
    [-17, 22, 4, 4, BuildingKind.Barn],
  ];
  const pal = (l: readonly number[]) => l[Math.floor(r.nextFloat() * l.length) % l.length]!;
  for (let k = 0; k < n; k++) {
    const [u, v, hl, hw, kind] = slots[k]!;
    const house = kind === BuildingKind.Farm;
    const roof = style === Style.Arid ? Roof.Flat : Roof.Gable;
    out.push({
      kind,
      x: x + u * c - v * s,
      y: y + u * s + v * c,
      angle: k >= 2 ? angle + Math.PI / 2 : angle,
      halfLength: hl,
      halfWidth: hw,
      height: house ? FLOOR_HEIGHT * 2 + 0.5 : 5 + r.nextFloat() * 2,
      floors: house ? 2 : 1,
      roof,
      roofHeight: roof === Roof.Flat ? 0 : Math.min(hl, hw) * palette.pitch,
      wall: !house && style === Style.Nordic ? 0x8e3b2e : pal(palette.walls),
      roofColor: pal(palette.roofs),
      extras: house && r.nextFloat() < palette.chimneys ? Extra.Chimney : 0,
    });
  }
  return out;
}
