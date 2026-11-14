/**
 * The form of the clouds (decision 141): what the weather makes of a column of
 * cloud, shared by the coverage bake, the volumetric march and the cloud
 * shadow, so that all three describe the same cloud.
 *
 * - Development. The bake stores one number per texel, `s` in 0..1, for the
 *   kind and depth of cloud the weather gives there:
 *
 *     0     flat fair-weather cumulus, 700 m thick, separate heaps
 *     0.25  towering cumulus and stratocumulus, 1,400 m, heaps that touch
 *     0.5   an overcast deck, 1,100 m, closed
 *     0.75  a rain layer, 4 km
 *     1     a storm tower: 11 km, with an anvil
 *
 *   From the weather: dry cloud runs from 0 to 0.5 with the cover fraction,
 *   precipitation takes it from 0.5 to 0.75, and a storm cell (the storm
 *   field times a cell pattern the bake adds) to 1. Thickness and fill (the
 *   share of a covered area that the heaps take) are piecewise linear in `s`,
 *   so one filtered channel carries the type across a front.
 * - Density. A point is in cloud where the shape noise exceeds 1 − c, with c
 *   the coverage times the fill times a profile of the height in the layer:
 *   cumulus narrows toward a rounded top, a deck keeps its width and ends in
 *   a bumpy top, a tower keeps a rain layer at its foot, a column above it
 *   and an anvil that reaches past the column. The noise is spread evenly
 *   over 0..1 (noiseVolume.ts), so the mean density of a layer follows from c
 *   alone: what the march uses where its steps are too long for the noise.
 *
 * Every function exists in TSL and, where the CPU needs it (the bounds of the
 * march), as a plain function.
 */
import type { Node } from 'three/webgpu';
import { clamp, float, max, mix, smoothstep } from 'three/tsl';

type F = Node<'float'>;

/** Meters per unit of the bake's cloud-base channel (a half float: bases to within a meter). */
export const BASE_SCALE = 10_200;
/** Thickness of a rain layer (m): what a storm tower stands on. */
export const RAIN_LAYER = 4000;
/** Thickness of a full storm tower (m). */
export const TOWER_THICKNESS = 11_000;
/** Height over which a flat cloud base fades in (m). */
export const BASE_SOFTNESS = 90;
/** The share of a cloud's noise range over which its density rises from nothing to full. */
export const EDGE = 0.35;
/** The anvil's underside and the top's fade, as fractions of a tower's thickness. */
const ANVIL_FROM = 0.8;

const sat = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const t = sat((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** How far the cloud field's detail moves the cover a column's development is taken from, either way. */
export const DETAIL_SWING = 0.12;

/**
 * Development 0..0.75 from a cover fraction and the precipitation as a
 * fraction of 4 mm/h. The cover is the weather's plus the local swing of the
 * cloud field's detail (up to DETAIL_SWING either way), so the cores of cloud
 * systems stand deeper than their edges; past full cover a dry deck thickens
 * a little more (to 0.54).
 */
export function developmentOf(cover: number, precip: number): number {
  const dry = 0.5 * smooth(0.08, 0.92, cover) + 0.04 * smooth(0.9, 1.2, cover);
  const wet = 0.5 + 0.25 * Math.sqrt(sat(precip));
  return dry + (Math.max(dry, wet) - dry) * smooth(0, 0.04, precip);
}

/** `developmentOf` in TSL, with a storm cell's strength 0..1 taking it to 1. */
export function development(cover: F, precip: F, tower: F): F {
  const dry = smoothstep(0.08, 0.92, cover)
    .mul(0.5)
    .add(smoothstep(0.9, 1.2, cover).mul(0.04));
  const wet = clamp(precip, 0, 1).sqrt().mul(0.25).add(0.5);
  const s = mix(dry, max(dry, wet), smoothstep(0, 0.04, precip));
  return mix(s, float(1), clamp(tower, 0, 1)) as F;
}

/** Thickness of the cloud layer (m) at a development. */
export function thicknessOf(s: number): number {
  const t1 = sat(4 * s);
  const t2 = sat(4 * s - 1);
  const t3 = sat(4 * s - 2);
  const t4 = sat(4 * s - 3);
  return (
    700 +
    700 * t1 -
    300 * t2 +
    (RAIN_LAYER - 1100) * t3 +
    (TOWER_THICKNESS - RAIN_LAYER) * smooth(0.02, 0.12, t4) * (0.75 + 0.25 * smooth(0.3, 1, t4))
  );
}

/** The thickest cloud any development up to `s` has (m): the march's upper bound. */
export function thicknessUpTo(s: number): number {
  return Math.max(thicknessOf(s), s > 0.25 ? 1400 : 0);
}

/** What a baked texel says about the cloud above it. */
export interface CloudColumn {
  /** Coverage 0..1: mostly 0 or 1, with soft edges (cloudLayer.ts). */
  cover: F;
  /** Cloud base above sea level (m). */
  base: F;
  /** Thickness of the layer (m). */
  thickness: F;
  /** Share of a covered area the cloud takes at its widest, 0.4..1. */
  fill: F;
  /** 0 for heaps, 1 for a closed deck. */
  deck: F;
  /** A storm cell's strength 0..1: 0 away from towers. */
  tower: F;
  /** Precipitation as a fraction of 4 mm/h. */
  precip: F;
}

/** The column a baked texel (coverage, precipitation, base, development) describes. */
export function cloudColumn(cover: F, precip: F, base: F, s: F): CloudColumn {
  const t1 = clamp(s.mul(4), 0, 1);
  const t2 = clamp(s.mul(4).sub(1), 0, 1);
  const t3 = clamp(s.mul(4).sub(2), 0, 1);
  const t4 = clamp(s.mul(4).sub(3), 0, 1);
  const rise = smoothstep(0.02, 0.12, t4).mul(smoothstep(0.3, 1, t4).mul(0.25).add(0.75));
  const thickness = t1
    .mul(700)
    .add(700)
    .sub(t2.mul(300))
    .add(t3.mul(RAIN_LAYER - 1100))
    .add(rise.mul(TOWER_THICKNESS - RAIN_LAYER));
  return {
    cover,
    precip,
    base,
    thickness: thickness as F,
    fill: t1.mul(0.2).add(0.4).add(t2.mul(0.4)) as F,
    deck: t2 as F,
    tower: t4 as F,
  };
}

/**
 * The local coverage 0..1 at a height above sea level (m): the column's
 * coverage and fill, shaped over the height in the layer. Zero below the base
 * and above the top.
 */
export function coverageAt(column: CloudColumn, h: F, towers = true): F {
  const above = h.sub(column.base);
  const y = clamp(above.div(column.thickness), 0, 1);
  const bottom = clamp(above.div(BASE_SOFTNESS), 0, 1);
  // Heaps narrow toward a rounded top; a deck keeps its width and ends in bumps.
  const heap = smoothstep(0.1, 0.95, y)
    .mul(-0.8)
    .add(1)
    .mul(smoothstep(1.0, 0.88, y));
  const deck = smoothstep(1.0, 0.7, y);
  let profile = mix(heap, deck, column.deck) as F;
  if (towers) {
    // A tower: the rain layer at its foot, a column where the cell is strong, and an anvil
    // that reaches out to the cell's rim.
    const foot = smoothstep(RAIN_LAYER + 600, RAIN_LAYER - 600, above);
    const body = smoothstep(0.3, 0.6, column.tower).mul(
      // A waist under the anvil.
      smoothstep(0.75, 0.45, y).mul(0.2).add(0.8),
    );
    const anvil = smoothstep(ANVIL_FROM - 0.04, ANVIL_FROM + 0.03, y)
      .mul(smoothstep(1.0, 0.93, y))
      .mul(smoothstep(0.08, 0.35, column.tower));
    const tower = max(max(foot, body.mul(smoothstep(1.0, 0.9, y))), anvil);
    profile = mix(profile, tower, smoothstep(0.0, 0.06, column.tower)) as F;
  }
  return column.cover.mul(column.fill).mul(profile).mul(bottom) as F;
}

/**
 * Cloud density 0..1 from the local coverage `c` and a shape-noise value
 * spread evenly over 0..1: zero where the noise is under 1 − c, full from
 * EDGE of the way to 1 on, so a cloud has a body and a soft rim.
 */
export function densityFrom(c: F, noise: F): F {
  return clamp(noise.sub(c.oneMinus()).div(max(c.mul(EDGE), 1e-3)), 0, 1) as F;
}

/** The mean of `densityFrom` over the noise: c · (1 − EDGE / 2). */
export function meanDensity(c: F): F {
  return c.mul(1 - EDGE / 2) as F;
}
