/**
 * Districts (proposal 0009, decision 263): each block's type from its distance to the
 * center (as a share of the extent toward it), its adjacency to rail, water and
 * arterials, its slope, the tier and the style, drawn from rng(seed,
 * "settlements/districts").fork(key) in block order.
 */
import type { Rng } from '../../core/rng';
import type { StylePalette } from './styles';
import { District, Ground, Style, Tier } from './types';

export interface BlockContext {
  /** Centroid (m, local frame). */
  cx: number;
  cy: number;
  share: number;
  /** Distances (m) to the nearest rail, water and arterial. */
  rail: number;
  water: number;
  arterial: number;
  slope: number;
  area: number;
  inCore: boolean;
}

/** Share of blocks that become terraced rows, by style. */
const TERRACED: readonly number[] = [0.5, 0.2, 0.6, 0.1, 0.3, 0.1, 0.8];

export function assignDistricts(
  blocks: BlockContext[],
  tier: Tier,
  style: Style,
  palette: StylePalette,
  port: boolean,
  r: Rng,
): District[] {
  const out: District[] = blocks.map(() => District.Detached);
  const city = tier === Tier.City;
  // Rail yards: the rail-side blocks nearest the center.
  const railSide = blocks
    .map((b, i) => ({ b, i }))
    .filter((x) => x.b.rail < 120 && !x.b.inCore && x.b.share > 0.1 && x.b.share < 0.7)
    .sort((a, b) => a.b.share - b.b.share || a.i - b.i);
  const yards = new Set(railSide.slice(0, city ? 3 : 1).map((x) => x.i));
  // Ports: water-side blocks of a port settlement.
  const quay = port
    ? blocks
        .map((b, i) => ({ b, i }))
        .filter((x) => x.b.water < 160 && !x.b.inCore)
        .sort((a, b) => a.b.share - b.b.share || a.i - b.i)
        .slice(0, city ? 5 : 2)
        .map((x) => x.i)
    : [];
  const ports = new Set(quay);
  blocks.forEach((b, i) => {
    const u = r.nextFloat();
    const v = r.nextFloat();
    if (b.inCore) out[i] = District.OldCore;
    else if (yards.has(i)) out[i] = District.RailYard;
    else if (ports.has(i)) out[i] = District.Port;
    else if (
      (b.rail < 260 || b.water < 200) &&
      b.share > 0.3 &&
      u < (style === Style.Eastern ? 0.75 : 0.55)
    )
      out[i] = District.Industrial;
    else if (b.share > 0.7 && b.arterial < 150 && u < 0.15) out[i] = District.Industrial;
    else if (b.slope > 0.2 && v < 0.5) out[i] = District.Civic;
    else if (v < (city ? 0.08 : 0.05)) out[i] = District.Civic;
    else if (
      palette.microdistricts &&
      tier !== Tier.Village &&
      b.share > 0.3 &&
      b.share < 0.85 &&
      u < 0.75
    )
      out[i] = District.Microdistrict;
    else if (b.share < (city ? 0.4 : 0.25)) out[i] = District.InnerGrid;
    else if (b.share < 0.65 && u < TERRACED[style]!) out[i] = District.Terraced;
    else out[i] = District.Detached;
  });
  // Towers (decision 292): a downtown at the center for American and Southeast Asian
  // cities (and a few towers in their large towns); a business district off the center
  // near a main road for European cities, round the largest block there.
  const big = city || (tier === Tier.Town && blocks.length > 150);
  if (palette.business === 'center' && big) {
    const core = city ? 0.13 : 0.06;
    blocks.forEach((b, i) => {
      if (
        b.share < core &&
        out[i] !== District.RailYard &&
        out[i] !== District.Port &&
        b.slope < 0.15
      )
        out[i] = District.Business;
    });
  } else if (palette.business === 'edge' && city) {
    let seed = -1;
    blocks.forEach((b, i) => {
      if (b.share < 0.35 || b.share > 0.7 || b.arterial > 250 || b.slope > 0.1) return;
      if (out[i] === District.RailYard || out[i] === District.Port) return;
      if (seed < 0 || b.area > blocks[seed]!.area) seed = i;
    });
    if (seed >= 0) {
      const s0 = blocks[seed]!;
      blocks
        .map((b, i) => ({ i, d: Math.hypot(b.cx - s0.cx, b.cy - s0.cy) }))
        .filter((x) => x.d < 650 && blocks[x.i]!.slope < 0.12)
        .sort((a, b) => a.d - b.d || a.i - b.i)
        .slice(0, 28)
        .forEach((x) => {
          if (out[x.i] !== District.RailYard && out[x.i] !== District.Port)
            out[x.i] = District.Business;
        });
    }
  }
  // Power and utilities: a city's outer industrial or water-side block.
  if (city) {
    let best = -1;
    let score = Infinity;
    blocks.forEach((b, i) => {
      if (
        out[i] === District.OldCore ||
        out[i] === District.RailYard ||
        out[i] === District.Port ||
        out[i] === District.Business
      )
        return;
      if (b.share < 0.5 || b.area < 15_000) return;
      const s =
        Math.min(b.water, 400) + (out[i] === District.Industrial ? 0 : 200) + b.slope * 2000;
      if (s < score) {
        score = s;
        best = i;
      }
    });
    if (best >= 0) out[best] = District.Utilities;
  }
  return out;
}

/** The ground between a district's buildings. */
export function districtGround(d: District, r: Rng): Ground {
  switch (d) {
    case District.OldCore:
    case District.InnerGrid:
      return Ground.Courtyard;
    case District.Detached:
    case District.Terraced:
      return Ground.Garden;
    case District.Microdistrict:
      return Ground.Park;
    case District.Industrial:
      return r.nextFloat() < 0.35 ? Ground.Gravel : Ground.Concrete;
    case District.RailYard:
      return Ground.Ballast;
    case District.Port:
      return Ground.Concrete;
    case District.Utilities:
      return Ground.Gravel;
    case District.Business:
      return Ground.Square;
    case District.Civic: {
      const u = r.nextFloat();
      return u < 0.55
        ? Ground.Park
        : u < 0.75
          ? Ground.Square
          : u < 0.9
            ? Ground.Sports
            : Ground.Cemetery;
    }
    default:
      return Ground.Garden;
  }
}
