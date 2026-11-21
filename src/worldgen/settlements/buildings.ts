/**
 * Buildings (proposal 0009, decision 264): one per parcel from district and style
 * rules, turned to the parcel's frontage, inset by the district's setbacks and checked
 * to stand inside the parcel; microdistricts set slabs in parkland instead. Draws from
 * rng(seed, "settlements/buildings").fork(key), parcel by parcel.
 */
import type { Rng } from '../../core/rng';
import { boxCorners, minAreaBox, pointInPoly } from './geom';
import type { Poly } from './geom';
import type { StylePalette } from './styles';
import { BuildingKind, District, Extra, Roof, Style } from './types';
import type { Building } from './types';

export const FLOOR_HEIGHT = 3;

/** Parcel rules per district: target area (m²), least frontage (m), setbacks and depth (m). */
export interface DistrictRule {
  parcelArea: number;
  frontage: number;
  front: number;
  side: number;
  depth: [number, number];
  floors: [number, number];
  kind: BuildingKind;
}

export const DISTRICT_RULES: Readonly<Record<number, DistrictRule>> = {
  [District.OldCore]: {
    parcelArea: 240,
    frontage: 6,
    front: 0.5,
    side: 0.3,
    depth: [10, 16],
    floors: [2, 4],
    kind: BuildingKind.Perimeter,
  },
  [District.InnerGrid]: {
    parcelArea: 520,
    frontage: 10,
    front: 0.5,
    side: 0.3,
    depth: [12, 15],
    floors: [4, 6],
    kind: BuildingKind.Perimeter,
  },
  [District.Terraced]: {
    parcelArea: 170,
    frontage: 5,
    front: 3,
    side: 0.2,
    depth: [9, 11],
    floors: [2, 3],
    kind: BuildingKind.Terrace,
  },
  [District.Detached]: {
    parcelArea: 750,
    frontage: 12,
    front: 6,
    side: 3,
    depth: [8, 12],
    floors: [1, 2],
    kind: BuildingKind.House,
  },
  [District.Microdistrict]: {
    parcelArea: 1e9,
    frontage: 10,
    front: 20,
    side: 20,
    depth: [12, 14],
    floors: [5, 9],
    kind: BuildingKind.Slab,
  },
  [District.Industrial]: {
    parcelArea: 5000,
    frontage: 25,
    front: 10,
    side: 8,
    depth: [25, 60],
    floors: [1, 1],
    kind: BuildingKind.Shed,
  },
  [District.RailYard]: {
    parcelArea: 9000,
    frontage: 30,
    front: 15,
    side: 10,
    depth: [15, 25],
    floors: [1, 1],
    kind: BuildingKind.Shed,
  },
  [District.Port]: {
    parcelArea: 4000,
    frontage: 25,
    front: 12,
    side: 8,
    depth: [20, 35],
    floors: [1, 1],
    kind: BuildingKind.Warehouse,
  },
  [District.Civic]: {
    parcelArea: 1e9,
    frontage: 10,
    front: 10,
    side: 10,
    depth: [10, 20],
    floors: [1, 2],
    kind: BuildingKind.Civic,
  },
  [District.Business]: {
    parcelArea: 2600,
    frontage: 20,
    front: 8,
    side: 6,
    depth: [24, 40],
    floors: [12, 40],
    kind: BuildingKind.Tower,
  },
  [District.Utilities]: {
    parcelArea: 1e9,
    frontage: 10,
    front: 25,
    side: 25,
    depth: [30, 60],
    floors: [1, 1],
    kind: BuildingKind.Shed,
  },
};

/** Parcel size by style: Nordic plots are generous, Mediterranean and Arid ones tight. */
export const STYLE_PARCEL: readonly number[] = [1, 1.1, 0.7, 1.5, 0.6, 1.35, 0.55];

function pick<T>(r: Rng, items: readonly T[]): T {
  return items[Math.min(items.length - 1, Math.floor(r.nextFloat() * items.length))]!;
}

function pickRoof(u: number, weights: readonly [Roof, number][]): Roof {
  for (const [roof, w] of weights) {
    if (u < w) return roof;
    u -= w;
  }
  return weights[weights.length - 1]![0];
}

/** True if every corner of the box lies inside the polygon. */
export function boxInside(
  p: Poly,
  x: number,
  y: number,
  angle: number,
  hl: number,
  hw: number,
): boolean {
  const c = boxCorners(x, y, angle, hl, hw);
  for (let i = 0; i < 4; i++) if (!pointInPoly(c[i * 2]!, c[i * 2 + 1]!, p)) return false;
  return true;
}

/**
 * The building on a parcel, or null if none fits. `share` is the distance from the
 * center as a share of the extent, for heights.
 */
export function parcelBuilding(
  polygon: Poly,
  frontage: [number, number, number, number],
  district: District,
  style: Style,
  palette: StylePalette,
  share: number,
  r: Rng,
): Omit<Building, 'parcel' | 'block' | 'landmark'> | null {
  const rule = DISTRICT_RULES[district]!;
  const [ax, ay, bx, by] = frontage;
  const fl = Math.hypot(bx - ax, by - ay);
  if (fl < 1e-6) return null;
  const ux = (bx - ax) / fl;
  const uy = (by - ay) / fl;
  // Inward normal of a counterclockwise polygon's edge.
  const nx = -uy;
  const ny = ux;
  let u0 = Infinity;
  let u1 = -Infinity;
  let n1 = 0;
  for (let i = 0; i < polygon.length; i += 2) {
    const dx = polygon[i]! - ax;
    const dy = polygon[i + 1]! - ay;
    const u = dx * ux + dy * uy;
    const n = dx * nx + dy * ny;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    n1 = Math.max(n1, n);
  }
  const depthWant = rule.depth[0] + r.nextFloat() * (rule.depth[1] - rule.depth[0]);
  const arcade = style === Style.SoutheastAsian && rule.kind === BuildingKind.Terrace;
  const front = (arcade ? 0.5 : rule.front) * (0.8 + 0.4 * r.nextFloat());
  const depth = Math.min(depthWant, n1 - front - 1.5);
  let length = u1 - u0 - 2 * rule.side;
  if (rule.kind === BuildingKind.House) length = Math.min(length, 8 + r.nextFloat() * 6);
  // Towers keep a squarish footprint, at most 45 m on a side.
  if (rule.kind === BuildingKind.Tower) length = Math.min(length, 26 + r.nextFloat() * 19);
  if (rule.kind === BuildingKind.Shed || rule.kind === BuildingKind.Warehouse) length *= 0.9;
  const along = (u0 + u1) / 2 + (rule.kind === BuildingKind.House ? (r.nextFloat() - 0.5) * 3 : 0);
  const floorsU = r.nextFloat();
  const roofU = r.nextFloat();
  const extraU = r.nextFloat();
  const colorU = r.nextFloat();
  if (depth < 5 || length < 5) return null;
  let hl = length / 2;
  let hw = depth / 2;
  const angle = Math.atan2(uy, ux);
  let cx = ax + ux * along + nx * (front + hw);
  let cy = ay + uy * along + ny * (front + hw);
  let fits = false;
  for (let tries = 0; tries < 5 && !fits; tries++) {
    fits = boxInside(polygon, cx, cy, angle, hl, hw);
    if (!fits) {
      hl *= 0.85;
      hw *= 0.85;
      cx = ax + ux * along + nx * (front + hw);
      cy = ay + uy * along + ny * (front + hw);
      if (hl < 2.5 || hw < 2.5) break;
    }
  }
  if (!fits) return null;
  // Floors: taller toward the center for perimeter blocks.
  let floors = rule.floors[0] + Math.floor(floorsU * (rule.floors[1] - rule.floors[0] + 1));
  if (rule.kind === BuildingKind.House) {
    floors =
      palette.houseFloors[0] +
      Math.floor(floorsU * (palette.houseFloors[1] - palette.houseFloors[0] + 1));
  }
  if (rule.kind === BuildingKind.Perimeter && share < 0.15) floors += 1;
  if (style === Style.Nordic && rule.kind === BuildingKind.Perimeter)
    floors = Math.max(2, floors - 2);
  // Shophouses: a floor more over an arcade at the street (decision 292).
  if (style === Style.SoutheastAsian && rule.kind === BuildingKind.Terrace) floors += 1;
  const tower = rule.kind === BuildingKind.Tower;
  // Towers rise toward the downtown's center: up to 60 floors at its middle.
  if (tower)
    floors = Math.round(
      floors * (1 + 0.5 * Math.max(0, 1 - share / 0.1)) * (0.6 + 0.4 * r.nextFloat()) + 4,
    );
  const industrial = rule.kind === BuildingKind.Shed || rule.kind === BuildingKind.Warehouse;
  const height = industrial
    ? 7 + floorsU * 7
    : floors * (tower ? 3.6 : FLOOR_HEIGHT) + (tower ? 2 : 0.5);
  let roof: Roof;
  if (industrial) roof = roofU < 0.6 ? Roof.Flat : Roof.Shed;
  else if (tower) roof = Roof.Flat;
  else if (rule.kind === BuildingKind.Perimeter)
    roof =
      style === Style.Mediterranean ||
      style === Style.Arid ||
      (style === Style.Eastern && roofU < 0.5)
        ? Roof.Flat
        : roofU < 0.5
          ? Roof.Hip
          : Roof.Gable;
  else roof = pickRoof(roofU, palette.houseRoofs);
  const span = Math.min(hw, hl) * 2;
  const roofHeight =
    roof === Roof.Flat ? 0 : roof === Roof.Shed ? span * 0.15 : span * palette.pitch * 0.5;
  let extras = 0;
  if (!industrial && roof !== Roof.Flat && extraU < palette.chimneys) extras |= Extra.Chimney;
  if (rule.kind === BuildingKind.Perimeter && style === Style.Western && extraU > 0.7)
    extras |= Extra.Dormer;
  if (
    rule.kind === BuildingKind.Perimeter &&
    (style === Style.Mediterranean || style === Style.Eastern) &&
    extraU > 0.5
  )
    extras |= Extra.Balcony;
  if (roof === Roof.Flat && !industrial && extraU < 0.2) extras |= Extra.WaterTank;
  if (style === Style.Arid && rule.kind === BuildingKind.House) extras |= Extra.Courtyard;
  const walls = tower ? palette.towerWalls : palette.walls;
  const roofs = roof === Roof.Flat || industrial ? palette.flatRoofs : palette.roofs;
  return {
    kind: rule.kind,
    x: cx,
    y: cy,
    angle,
    halfLength: hl,
    halfWidth: hw,
    height,
    floors: industrial ? 1 : floors,
    roof,
    roofHeight,
    wall: industrial ? 0xa8a49c : walls[Math.floor(colorU * walls.length) % walls.length]!,
    roofColor: roofs[Math.floor(((colorU * 7.31) % 1) * roofs.length) % roofs.length]!,
    extras,
  };
}

/**
 * Microdistrict slabs: rows of five- and nine-story slabs in parkland inside the block,
 * with a school where one fits.
 */
export function microdistrictSlabs(
  block: Poly,
  palette: StylePalette,
  r: Rng,
): Omit<Building, 'parcel' | 'block' | 'landmark'>[] {
  const box = minAreaBox(block);
  const angle = Math.atan2(box.uy, box.ux);
  const out: Omit<Building, 'parcel' | 'block' | 'landmark'>[] = [];
  const rowGap = 48;
  const rows = Math.max(1, Math.floor((2 * box.hv - 30) / rowGap));
  for (let k = 0; k < rows; k++) {
    const v = -box.hv + 22 + rowGap * (k + 0.5) * ((2 * box.hv - 44) / (rowGap * rows));
    const slabLen = 55 + r.nextFloat() * 35;
    const count = Math.max(1, Math.floor((2 * box.hu - 30) / (slabLen + 25)));
    const nine = r.nextFloat() < 0.45;
    for (let j = 0; j < count; j++) {
      const u = -box.hu + 15 + (j + 0.5) * ((2 * box.hu - 30) / count);
      const cx = box.cx + box.ux * u - box.uy * v;
      const cy = box.cy + box.uy * u + box.ux * v;
      const hl = slabLen / 2;
      const hw = 6.5;
      if (!boxInside(block, cx, cy, angle, hl + 8, hw + 8)) continue;
      const floors = nine ? 9 : 5;
      out.push({
        kind: BuildingKind.Slab,
        x: cx,
        y: cy,
        angle,
        halfLength: hl,
        halfWidth: hw,
        height: floors * FLOOR_HEIGHT + 0.5,
        floors,
        roof: Roof.Flat,
        roofHeight: 0,
        wall: pick(r, palette.walls),
        roofColor: pick(r, palette.flatRoofs),
        extras: Extra.Balcony,
      });
    }
  }
  return out;
}
