import { describe, expect, it } from 'vitest';
import { DEG } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { strategicContext } from '../src/worldgen/strategic/builder';
import { extractFeatures } from '../src/worldgen/geography';
import {
  duneModel,
  forestModel,
  moundModel,
  mountainModel,
} from '../src/render/strategic/glyphGeometry';
import {
  GLYPH_TUNING,
  headingOf,
  layoutGlyphs,
  resample,
} from '../src/render/strategic/glyphLayout';
import type { GlyphSet } from '../src/render/strategic/glyphLayout';
import { FeatureKind, featuresOfKind, pointLatLon } from '../src/worldgen/strategic/graph';
import type { Point } from '../src/worldgen/strategic/graph';
import { boxWorld, RADIUS, RELIEF } from './helpers/syntheticWorld';

describe('glyph models', () => {
  it('are whole triangles with the mountain cap on top and seven trees per token', () => {
    for (const m of [mountainModel(), moundModel(), forestModel(), duneModel()]) {
      expect(m.position.length % 9).toBe(0);
      expect(m.part.length).toBe(m.position.length / 3);
    }
    const mtn = mountainModel();
    for (let v = 0; v < mtn.part.length; v++) {
      const z = mtn.position[v * 3 + 2]!;
      if (mtn.part[v] === 1) expect(z).toBeGreaterThan(0.3);
      else expect(z).toBeLessThan(0.4);
    }
    expect(new Set(forestModel().part)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]));
  });
});

describe('glyph layout', () => {
  // A continent with an east–west ridge (as in the geography tests) and a forest strip.
  const input = boxWorld(96, [{ lat: [-30, 30], lon: [-50, 50] }], (lat, lon) =>
    Math.abs(lat - 10) < 2.5 && Math.abs(lon) < 40
      ? 3000 * RELIEF * (1 - ((lat - 10) / 2.5) ** 2)
      : 0,
  );
  for (let c = 0; c < input.grid.cellCount; c++) {
    const { lat } = pointLatLon([...input.grid.centers.subarray(c * 3, c * 3 + 3)] as Point);
    if (input.height[c]! > 0 && lat < -10 * DEG) input.biome[c] = 8; // temperate forest
  }
  const ctx = strategicContext(input);
  const features = extractFeatures({
    ctx,
    nodes: [],
    nodeOfLandmass: new Int32Array(ctx.labels.landmasses.length).fill(-1),
    members: [],
    chokepoints: [],
  });
  const dir = new Vec3d();
  const glyphInput: Parameters<typeof layoutGlyphs>[0] = {
    features,
    grid: input.grid,
    radius: RADIUS,
    reliefScale: RELIEF,
    heightAt: (x, y, z) => input.height[input.grid.cellOfDirection(dir.set(x, y, z))]!,
    snowAt: () => false,
    sandAt: () => false,
  };
  const sets = layoutGlyphs(glyphInput);
  const get = (kind: string, band: string) => sets.find((s) => s.kind === kind && s.band === band)!;
  const points = (s: GlyphSet) =>
    Array.from({ length: s.count }, (_, i) => [...s.position.subarray(i * 4, i * 4 + 3)] as Point);

  it('chains mountains along the ridge in both bands, denser in the Region band', () => {
    expect(featuresOfKind(features, FeatureKind.Range).length).toBe(1);
    const theater = get('mountain', 'theater');
    const region = get('mountain', 'region');
    expect(theater.count).toBeGreaterThan(3);
    expect(region.count).toBeGreaterThan(theater.count);
    for (const p of points(region)) {
      expect(Math.abs(pointLatLon(p).lat / DEG - 10)).toBeLessThan(4);
    }
  });

  it('puts forest tokens in the Region band only, with 3 to 7 trees each', () => {
    expect(get('forest', 'theater').count).toBe(0);
    const f = get('forest', 'region');
    expect(f.count).toBeGreaterThan(10);
    for (let i = 0; i < f.count; i++) {
      const trees = f.shape[i * 4 + 3]!;
      expect(trees).toBeGreaterThanOrEqual(3);
      expect(trees).toBeLessThanOrEqual(7);
      const w = f.shape[i * 4]!;
      expect(w).toBeGreaterThanOrEqual(GLYPH_TUNING.region.forestWidth[0]);
      expect(w).toBeLessThanOrEqual(GLYPH_TUNING.region.forestWidth[1]);
    }
  });

  it('is deterministic', () => {
    const again = layoutGlyphs(glyphInput);
    for (const s of sets) {
      const t = again.find((x) => x.kind === s.kind && x.band === s.band)!;
      expect(t.count).toBe(s.count);
    }
  });

  it('resamples polylines evenly and measures headings from east', () => {
    const line = Float64Array.from([0, 0, 1, Math.sin(0.1), 0, Math.cos(0.1)]);
    const r = resample(line, 10e3, RADIUS);
    expect(r.length).toBe(10);
    expect(headingOf([0, 0, 1], [1, 0, 0])).toBeCloseTo(0, 9);
    expect(headingOf([0, 0, 1], [0, 1, 0])).toBeCloseTo(Math.PI / 2, 9);
  });
});
