/**
 * Water on the strategic map (visual-style Part II, Base Map and Strategic Palette;
 * decision 82): flat depth bands, a thin dark coastline, and lakes drawn the same way.
 *
 * - **Depth bands.** Three flat tints by reference depth, the depth before the
 *   planet's relief scaling (decision 14): shelf above 200 m, mid-depth to 3,000 m,
 *   deep below. Each band edge is antialiased over one pixel of depth change.
 * - **Coastline.** A line about 1.2 px wide where the coast distance estimate of
 *   decision 39 (`shore`, −h / |∇h| per vertex, in meters) crosses zero, measured in
 *   pixels with the fragment's footprint. The same distance antialiases the
 *   land–sea edge, so the coast is as sharp as the line.
 * - **Lakes.** The signed lake depth (lake level − height) gives the lake's edge,
 *   outline and depth band, with the same colors and line.
 * - Water is flat: no hillshade, no relief light.
 *
 * `waterBandWeights` and `lineCoverage` are the CPU reference for tests.
 */
import type { Node } from 'three/webgpu';
import { abs, clamp, float, max, min, mix, vec3 } from 'three/tsl';
import { hexToLinear } from './biomeFill';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Reference depth (m) where the shelf band ends and where the deep band begins. */
export const SHELF_DEPTH = 200;
export const DEEP_DEPTH = 3000;
/** Coastline width on screen (px). */
export const COASTLINE_PX = 1.2;

/** Part II water colors (sRGB hex). */
export const SHELF_WATER = 0x8db5c4;
export const MID_WATER = 0x6c97ac;
export const DEEP_WATER = 0x4f7a93;
export const COASTLINE = 0x2f4756;

/** Weight of the coarser band past an edge at `edge`, for a value `x` changing `width` per pixel. */
const bandStep = (x: number, edge: number, width: number) =>
  Math.min(1, Math.max(0, (x - edge) / Math.max(width, 1e-9) + 0.5));

/** Shares of the shelf, mid-depth and deep tints at a reference depth (m). */
export function waterBandWeights(depth: number, widthPerPx = 1e-9): [number, number, number] {
  const mid = bandStep(depth, SHELF_DEPTH, widthPerPx);
  const deep = bandStep(depth, DEEP_DEPTH, widthPerPx);
  return [1 - mid, mid - deep, deep];
}

/** Coverage of a line `px` pixels wide at a distance of `distPx` pixels from its center. */
export function lineCoverage(distPx: number, px = COASTLINE_PX): number {
  return Math.min(1, Math.max(0, px / 2 + 0.5 - Math.abs(distPx)));
}

const rgb = (h: number) => {
  const c = hexToLinear(h);
  return vec3(c[0], c[1], c[2]) as V3;
};

export interface MapWaterInputs {
  /** Signed lake depth (m) and its change per pixel. */
  lake: F;
  lakeWidth: F;
  /** Coast distance (m, positive at sea) and the pixel footprint (m per px). */
  shore: F;
  footprint: F;
  /** Reference depth per pixel, for the band edges. */
  depthWidth: F;
  /** Reference depth (m) of the water here: lake depth in lakes, sea depth elsewhere. */
  depth: F;
}

export interface MapWater {
  /** Water color (linear). */
  color: V3;
  /** 0 on land, 1 on water, antialiased at the shore. */
  wet: F;
  /** Coastline and lake-outline coverage. */
  outline: F;
  /** The outline color (linear). */
  outlineColor: V3;
}

/** The map's water at a fragment (see the header). Takes no derivatives itself. */
export function mapWaterNode(i: MapWaterInputs): MapWater {
  const shorePx = i.shore.div(i.footprint);
  const lakePx = i.lake.div(i.lakeWidth);
  const sea = clamp(shorePx.add(0.5), 0, 1);
  const lakeCover = clamp(lakePx.add(0.5), 0, 1);
  const wet = max(sea, lakeCover) as F;
  const step = (edge: number) =>
    clamp(i.depth.sub(edge).div(max(i.depthWidth, 1e-6)).add(0.5), 0, 1);
  const color = mix(
    mix(rgb(SHELF_WATER), rgb(MID_WATER), step(SHELF_DEPTH)),
    rgb(DEEP_WATER),
    step(DEEP_DEPTH),
  ) as V3;
  const dist = min(abs(shorePx), abs(lakePx));
  const outline = clamp(float(COASTLINE_PX / 2 + 0.5).sub(dist), 0, 1) as F;
  return { color, wet, outline, outlineColor: rgb(COASTLINE) };
}
