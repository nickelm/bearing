/**
 * What the map draws of the ground war (visual-style Part II, Military
 * Overlays; roadmap R2.3): brigades and regiments as NATO-style unit symbols
 * in faction colors, at the Region band, behind the front line where the sim
 * holds them. The front line itself moves in the military overlays
 * (`buildMilitaryOverlays`' live lines). Pure TypeScript from the worker's
 * ground picture.
 *
 * - **Symbols.** A square badge in the side's color with the branch inside:
 *   an oval for armor, the oval with an X for mechanized infantry. The sim's
 *   unit is the battalion; the map shows brigades (Alliance) and regiments
 *   (Pact), three or four battalions each, so a Region view holds tens of
 *   symbols rather than a hundred and more (decision 251).
 * - **Strength.** A unit below WEAK of its strength draws at WEAK_SCALE of its
 *   size; below BROKEN it is gone from the map.
 * - **Side.** As for flights (decision 48): a side's view shows its own units;
 *   'both' is the developer view until the intelligence picture (R3.1).
 */
import type { Side } from '../../../campaign/cast';
import type { GroundPicture } from '../../../sim/ground/war';
import type { ZoomBand } from '../zoomBands';
import { CASING_COLOR, FACTION_COLORS, SYMBOL_SHARE } from './militaryModel';
import type { MilitaryOverlays, OverlayMark } from './militaryModel';

export type GroundLayer = 'units';
export const GROUND_LAYERS: readonly GroundLayer[] = ['units'];

/** Badge size (px). */
export const UNIT_BADGE = 22;
export const WEAK = 0.6;
export const WEAK_SCALE = 0.8;
export const BROKEN = 0.15;
const BANDS: readonly ZoomBand[] = ['region'];

export function buildGroundOverlays(
  picture: GroundPicture | null,
  options: { side: Side | 'both' },
): MilitaryOverlays<GroundLayer> {
  const marks: OverlayMark<GroundLayer>[] = [];
  if (!picture) return { lines: [], marks };
  for (const u of picture.units) {
    if (options.side !== 'both' && u.side !== options.side) continue;
    if (u.strength < BROKEN) continue;
    const size = UNIT_BADGE * (u.strength < WEAK ? WEAK_SCALE : 1);
    marks.push({
      layer: 'units',
      shape: u.kind === 'tank' ? 'unit-armor' : 'unit-mech',
      point: u.point,
      axis: [0, 0, 0],
      length: size * SYMBOL_SHARE.unit,
      width: size * SYMBOL_SHARE.unit,
      color: CASING_COLOR,
      outline: 0,
      casing: 1.5,
      bands: BANDS,
      badge: { shape: 'square', size, fill: FACTION_COLORS[u.side], rim: 0x1e1e1e, rimWidth: 1.5 },
    });
  }
  return { lines: [], marks };
}
