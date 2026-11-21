/**
 * Stage: relief exaggeration (Proposal 0010, decision 297).
 *
 * Multiplies the terrain's height above the sea by a world parameter E (default
 * 1.3, range 1.0–1.5), after erosion, climate, drainage, rivers, biomes, forest and
 * zones, and before anything is built on the terrain (airfield siting, road and rail
 * alignments, settlement plans, props, structures). Climate and biomes therefore
 * never see it, and everything built afterwards is built on the one scaled surface.
 *
 * The map is h ↦ E·h for h > 0 and h ↦ h at sea. It is strictly increasing, so
 * every ordering survives it: rivers still never rise downstream, lakes stay level
 * (a lake's level and its bed scale alike, so its depth scales too), a treeline or
 * a basin's crust keeps the same ground above or below it. Slopes on land grow by E,
 * so the networks and the props, built later, see the steeper ground.
 *
 * What is scaled, in place, on the global grid:
 *   - the height (land only);
 *   - lake depth on land (lake level − bed scales with both);
 *   - closed basins' levels;
 *   - the treeline (physical m), so forests reach as far up the same slopes;
 *   - the migrated channels' water surfaces;
 *   - the display maps' height, lake depth and valley floor.
 *
 * The strategic graph (coarse pass) is not: the campaign plans on unscaled heights,
 * so the war is the same at every exaggeration; heights it shows (spot heights)
 * are multiplied where they are drawn (`exaggeratedHeight`).
 */
import type { FinishResult } from './finishWorld';

/** The proposal's range and default (decision 297). */
export const RELIEF_EXAGGERATION = { min: 1, max: 1.5, default: 1.3 } as const;

/** Clamps an exaggeration into the proposal's range; NaN and undefined give 1. */
export function clampExaggeration(e: number | undefined): number {
  if (e === undefined || !Number.isFinite(e)) return 1;
  return Math.min(RELIEF_EXAGGERATION.max, Math.max(RELIEF_EXAGGERATION.min, e));
}

/** A height at exaggeration `e`: land multiplied, the sea floor as it is. */
export function exaggeratedHeight(h: number, e: number): number {
  return h > 0 ? h * e : h;
}

/** The inverse: an exaggerated height back to the climate's height. */
export function unexaggeratedHeight(h: number, e: number): number {
  return h > 0 ? h / e : h;
}

function scaleLand(a: Float32Array, e: number): void {
  for (let c = 0; c < a.length; c++) if (a[c]! > 0) a[c] = a[c]! * e;
}

/**
 * Heights and lake depths together: a lake's level (bed + depth) and its bed each
 * map through `exaggeratedHeight`, so the lake stays level over a bed below the sea too.
 */
function scaleWithLakes(height: Float32Array, lakeDepth: Float32Array, e: number): void {
  for (let c = 0; c < height.length; c++) {
    const h = height[c]!;
    const depth = lakeDepth[c]!;
    const bed = exaggeratedHeight(h, e);
    if (depth > 0) lakeDepth[c] = exaggeratedHeight(h + depth, e) - bed;
    height[c] = bed;
  }
}

/**
 * Applies exaggeration `e` in place to the global height and the height-valued
 * fields of `finish`. A no-op at e = 1. Run once per world, before the world is
 * stored: stored worlds hold exaggerated data and are not scaled again.
 */
export function exaggerateRelief(height: Float32Array, finish: FinishResult, e: number): void {
  if (e === 1) return;
  const { lakeDepth, basinLevel } = finish.drainage;
  scaleWithLakes(height, lakeDepth, e);
  if (basinLevel) scaleLand(basinLevel, e);
  scaleLand(finish.treeline, e);
  const ch = finish.channels;
  if (ch) {
    for (let p = 4; p < ch.points.length; p += 5) {
      if (ch.points[p]! > 0) ch.points[p] = ch.points[p]! * e;
    }
  }
  const d = finish.display;
  scaleWithLakes(d.height, d.lakeDepth, e);
  if (d.valleyFloor) scaleLand(d.valleyFloor, e);
}
