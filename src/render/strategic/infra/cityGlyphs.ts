/**
 * Settlement glyphs (visual-style Part II, Settlements and Infrastructure; decision
 * 104): an oversized low-poly building cluster at each settlement's center, its model
 * and size set by class (village, town, city, capital). Pure TypeScript; the glyph
 * layer draws the sets.
 *
 * Cities and capitals show from the Theater band, every settlement in the Region band.
 * Sizes are per band, like the geographic glyphs, so a glyph keeps roughly its size
 * in pixels within its band. Each glyph turns by a heading hashed from its index.
 */
import { settlementKind } from '../../../worldgen/strategic/graph';
import type { SettlementList } from '../../../worldgen/strategic/graph';
import type { GlyphBand, GlyphSet, SettlementGlyph } from '../glyphLayout';
import { SETTLEMENT_GLYPHS } from '../glyphLayout';

/** Base width (m) of each class's glyph per band; missing classes do not show. */
export const CITY_GLYPH_WIDTH: Record<GlyphBand, Partial<Record<SettlementGlyph, number>>> = {
  theater: { city: 20e3, capital: 26e3 },
  region: { village: 2.6e3, town: 4.8e3, city: 8e3, capital: 10.5e3 },
};

/** A heading in [0, 2π) from an index (a 32-bit integer hash). */
function hashHeading(i: number): number {
  let h = (i + 1) * 0x9e3779b1;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (((h ^ (h >>> 16)) >>> 0) / 2 ** 32) * Math.PI * 2;
}

export function settlementGlyph(population: number, capital: boolean): SettlementGlyph {
  return capital ? 'capital' : settlementKind(population);
}

export function layoutCityGlyphs(
  s: SettlementList,
  capitals: readonly number[],
  heightAt: (x: number, y: number, z: number) => number,
): GlyphSet[] {
  const caps = new Set(capitals.filter((c) => c >= 0));
  const out: GlyphSet[] = [];
  for (const band of ['theater', 'region'] as const) {
    for (const kind of SETTLEMENT_GLYPHS) {
      const width = CITY_GLYPH_WIDTH[band][kind];
      if (!width) continue;
      const members: number[] = [];
      for (let i = 0; i < s.cells.length; i++) {
        if (settlementGlyph(s.population[i]!, caps.has(i)) === kind) members.push(i);
      }
      const position = new Float32Array(members.length * 4);
      const shape = new Float32Array(members.length * 4);
      members.forEach((i, k) => {
        const x = s.points[i * 3]!;
        const y = s.points[i * 3 + 1]!;
        const z = s.points[i * 3 + 2]!;
        position.set([x, y, z, Math.max(0, heightAt(x, y, z))], k * 4);
        shape.set([width, hashHeading(i), 0, 0], k * 4);
      });
      out.push({ kind, band, count: members.length, position, shape });
    }
  }
  return out;
}
