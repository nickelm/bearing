/**
 * Burning columns from the campaign's target damage (decision 329): every target damaged
 * past `SMOKE_FROM` burns, a fuel depot or refinery as a fuel fire, the rest as a burning
 * target, harder the more it is damaged. Targets in a town burn through its plan instead
 * (the city layer's damaged buildings, decision 269), and bridges do not burn.
 */
import type { FireColumn, FireKind } from '../../../sim/effects/events';

/** The least damage that smokes (the map's amber mark, decision 301). */
export const SMOKE_FROM = 0.15;

/** What `fireColumns` reads of a target site (`TargetSite` in worldgen/strategic). */
export interface ColumnSite {
  id: number;
  kind: string;
  /** Unit direction from the planet's center. */
  point: readonly [number, number, number];
  /** The settlement it stands in, or −1. */
  settlement: number;
}

export function fireColumns(
  sites: readonly ColumnSite[],
  damage: ReadonlyMap<number, number>,
  radius: number,
): FireColumn[] {
  const out: FireColumn[] = [];
  for (const [id, d] of damage) {
    const s = sites[id];
    if (!s || s.id !== id || d < SMOKE_FROM || s.kind === 'bridge' || s.settlement >= 0) continue;
    const kind: FireKind = s.kind === 'fuel-depot' || s.kind === 'refinery' ? 'fuel' : 'target';
    out.push({
      key: `site:${id}`,
      at: [s.point[0] * radius, s.point[1] * radius, s.point[2] * radius],
      kind,
      intensity: Math.min(1, d),
    });
  }
  return out;
}
