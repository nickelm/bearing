/**
 * Points of interest and composition (Proposal 0010, decisions 302 and 303) on a coarse
 * world: deterministic, the caller's kit only, spaced, named, power lines with a path;
 * viewsheds and the landmark pass that gives every viewpoint a landmark in view.
 */
import { describe, expect, it } from 'vitest';
import { Vec3d } from '../src/core/vec3d';
import { computeDrainage } from '../src/worldgen/drainage';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { generateWorld } from '../src/worldgen/pipeline';
import { cellCenterDirection } from '../src/worldgen/rivers';
import {
  composeLandmarks,
  LANDMARK_HEIGHT,
  placePointsOfInterest,
  POI_KINDS,
  POI_TYPES,
} from '../src/worldgen/poi/poi';
import type { PoiWorld } from '../src/worldgen/poi/poi';
import { landmarkCoverage, lineOfSight, viewshedScore } from '../src/worldgen/viewshed';

const N = 128;
const R = DEFAULT_PLANET_PARAMS.radius;
const params = { ...DEFAULT_PLANET_PARAMS, seed: '4' };
const maps = generateWorld(params, { resolution: N }).maps;
const drainage = computeDrainage(N, maps.height, maps.runoff, R, {
  temperature: maps.temperature,
  precipitation: maps.precipitation,
});
const world: PoiWorld = {
  n: N,
  radius: R,
  height: maps.height,
  biome: maps.biome,
  province: maps.province,
  lithology: maps.lithology,
  discharge: drainage.discharge,
};
// Places: the lowest land cell of every 400th land cell, as stand-in towns.
const places: { dir: [number, number, number]; size: number }[] = [];
for (let c = 0, k = 0; c < maps.height.length; c++) {
  if (maps.height[c]! <= 0 || maps.height[c]! > 300) continue;
  if (k++ % 400) continue;
  const d = cellCenterDirection(N, c, new Vec3d());
  places.push({ dir: [d.x, d.y, d.z], size: 1 });
}

describe('points of interest', () => {
  const pois = placePointsOfInterest(world, params.seed, { places });

  it('places the kit deterministically, spaced, each named', () => {
    expect(pois.length).toBeGreaterThan(10);
    expect(placePointsOfInterest(world, params.seed, { places })).toEqual(pois);
    for (const p of pois) {
      expect(p.name.length).toBeGreaterThan(3);
      expect(POI_KINDS).toContain(p.kind);
      for (const q of pois) {
        if (q === p || q.kind !== p.kind) continue;
        const d = new Vec3d(...p.dir).distanceTo(new Vec3d(...q.dir)) * R;
        expect(d).toBeGreaterThanOrEqual(POI_TYPES[p.kind].spacing - 1);
      }
    }
    const kinds = new Set(pois.map((p) => p.kind));
    if (kinds.size < 6) console.log([...kinds].join(', '));
    expect(kinds.size).toBeGreaterThanOrEqual(6);
  });

  it('places only the kit the caller asks for', () => {
    const only = placePointsOfInterest(world, params.seed, {
      places,
      kinds: ['lighthouse', 'observatory'],
    });
    expect(only.length).toBeGreaterThan(0);
    for (const p of only) expect(['lighthouse', 'observatory']).toContain(p.kind);
  });

  it('runs power lines from a site to a place', () => {
    for (const p of pois.filter((q) => q.kind === 'power-line')) {
      expect(p.path!.length).toBeGreaterThan(2);
    }
  });
});

describe('viewsheds and composition', () => {
  it('sees across flat ground and not through a ridge', () => {
    const flat: PoiWorld = { ...world, height: new Float32Array(6 * N * N).fill(100) };
    const a = cellCenterDirection(N, (4 * N + 64) * N + 62, new Vec3d());
    const b = cellCenterDirection(N, (4 * N + 64) * N + 64, new Vec3d());
    expect(lineOfSight(flat, a, 400, b, 400)).toBe(true);
    const ridge = new Float32Array(flat.height);
    for (let j = 0; j < N; j++) ridge[(4 * N + j) * N + 63] = 2000;
    expect(lineOfSight({ ...flat, height: ridge }, a, 400, b, 400)).toBe(false);
  });

  it('gives every viewpoint a landmark in view, where one can stand', () => {
    const viewpoints = places.slice(0, 25).map((p) => ({ dir: p.dir, above: 300 }));
    const score = viewshedScore(world, viewpoints);
    expect(score.some((v) => v > 0)).toBe(true);
    const pois = placePointsOfInterest(world, params.seed, { places, viewshed: score });
    const marks = (list: typeof pois) =>
      list
        .filter((p) => LANDMARK_HEIGHT[p.kind] !== undefined)
        .map((p) => ({ dir: p.dir, height: LANDMARK_HEIGHT[p.kind]! }));
    const before = landmarkCoverage(world, viewpoints, marks(pois)).share;
    const added = composeLandmarks(world, pois, viewpoints, params.seed);
    const after = landmarkCoverage(world, viewpoints, marks([...pois, ...added])).share;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after).toBeGreaterThanOrEqual(0.7);
  });
});
