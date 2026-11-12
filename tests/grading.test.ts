import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { cubeFaceUvToDirection } from '../src/core/coords';
import { Noise3 } from '../src/core/noise';
import { rng } from '../src/core/rng';
import {
  childTiles,
  neighborTile,
  parentTile,
  tileKey,
  tileSampleDirection,
  TILE_BORDER,
  TILE_STRIDE,
  TILE_TEXELS,
} from '../src/core/tiles';
import type { TileKey } from '../src/core/tiles';
import { DEG, PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { gradeBlend, SurfaceGrading } from '../src/render/common/terrain/grading';
import type { GradePad } from '../src/render/common/terrain/grading';
import { TILE_SEGMENTS } from '../src/render/common/terrain/quadtree';
import {
  buildTileMesh,
  dataTileFor,
  displacedPosition,
} from '../src/render/common/terrain/tileMesh';
import type { MeshOptions, TileMeshData } from '../src/render/common/terrain/tileMesh';
import {
  AIRFIELD_MARGIN,
  airfieldGrading,
  airfieldPads,
  globalMapSampler,
} from '../src/render/sim/infra/airfieldGrading';
import { InfraScene, offsetPoint } from '../src/render/sim/infra/infraScene';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { NO_LAKE } from '../src/worldgen/gpu/tileSynth';
import type { TileData } from '../src/worldgen/gpu/tileSynth';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';

const R = PLANET_RADIUS;
const V = TILE_SEGMENTS + 1;
const GRID_VERTEX_COUNT = V * V;

describe('gradeBlend', () => {
  it('is 0 inside, 1 beyond the margin, and rises smoothly between', () => {
    expect(gradeBlend(-5, 100)).toBe(0);
    expect(gradeBlend(0, 100)).toBe(0);
    expect(gradeBlend(100, 100)).toBe(1);
    expect(gradeBlend(150, 100)).toBe(1);
    expect(gradeBlend(50, 100)).toBeCloseTo(0.5, 12);
    let last = 0;
    for (let d = 1; d <= 100; d++) {
      const w = gradeBlend(d, 100);
      expect(w).toBeGreaterThanOrEqual(last);
      last = w;
    }
    // C¹: flat at both ends.
    expect(gradeBlend(1, 100) - gradeBlend(0, 100)).toBeLessThan(1e-4);
    expect(gradeBlend(100, 100) - gradeBlend(99, 100)).toBeLessThan(1e-4);
  });
});

/** A 3 km × 0.8 km pad heading 60° at 230 m, centered in tile t (level 8). */
function padIn(t: TileKey): GradePad {
  const n = 1 << t.level;
  return {
    center: cubeFaceUvToDirection(t.face, (t.x + 0.5) / n, (t.y + 0.5) / n),
    heading: 60 * DEG,
    along0: -1500,
    along1: 1500,
    across0: -100,
    across1: 700,
    elevation: 230,
    margin: 400,
  };
}

describe('SurfaceGrading', () => {
  const pad = padIn(tileKey(4, 8, 101, 77));
  const g = new SurfaceGrading([pad], R);
  const at = (along: number, across: number) =>
    offsetPoint(pad.center, pad.heading, along, across, R);

  it('levels the pad and leaves the terrain beyond the margin alone', () => {
    expect(g.apply(at(0, 0), 290)).toBeCloseTo(230, 9);
    expect(g.apply(at(1490, 690), 180)).toBeCloseTo(230, 9);
    expect(g.apply(at(-1490, -90), 400)).toBeCloseTo(230, 9);
    expect(g.apply(at(1500 + 401, 0), 290)).toBe(290);
    expect(g.apply(at(0, 700 + 401), 290)).toBe(290);
    expect(g.apply(at(0, -100 - 401), 290)).toBe(290);
    // Halfway through the margin: halfway between field and terrain.
    expect(g.apply(at(0, 900), 330)).toBeCloseTo(280, 0);
  });

  it('reports how much of the ground a pad covers', () => {
    expect(g.cover(at(0, 0))).toBe(1);
    expect(g.cover(at(0, 900))).toBeCloseTo(0.5, 4);
    expect(g.cover(at(0, 1200))).toBe(0);
  });

  it('never grades the sea', () => {
    expect(g.apply(at(0, 0), -3)).toBe(-3);
    expect(g.apply(at(0, 0), 0)).toBe(0);
  });

  it('is continuous across the pad edge and the margin', () => {
    for (const [a0, c0, da, dc] of [
      [0, 700, 0, 1],
      [1500, 0, 1, 0],
      [0, 1100, 0, 1],
    ] as const) {
      const h0 = g.apply(at(a0 - da * 0.5, c0 - dc * 0.5), 400);
      const h1 = g.apply(at(a0 + da * 0.5, c0 + dc * 0.5), 400);
      expect(Math.abs(h1 - h0)).toBeLessThan(0.5);
    }
  });

  it('restricts itself to tiles the pad reaches', () => {
    expect(g.forTile(tileKey(4, 8, 101, 77))).not.toBeNull();
    expect(g.forTile(tileKey(4, 3, 3, 2))).not.toBeNull();
    expect(g.forTile(tileKey(4, 8, 120, 77))).toBeNull();
    expect(g.forTile(tileKey(1, 8, 101, 77))).toBeNull();
    const f = g.forTile(tileKey(4, 9, 202, 154))!;
    expect(f(at(10, 10), 300)).toBe(g.apply(at(10, 10), 300));
  });
});

/** Synthetic rolling terrain around 300 m (the same function at every level). */
function fakeData(k: TileKey): TileData {
  const height = new Float32Array(TILE_STRIDE * TILE_STRIDE);
  const d = new Vec3d();
  for (let sy = -TILE_BORDER; sy <= TILE_TEXELS + TILE_BORDER; sy++) {
    for (let sx = -TILE_BORDER; sx <= TILE_TEXELS + TILE_BORDER; sx++) {
      tileSampleDirection(k, sx, sy, d);
      height[(sy + TILE_BORDER) * TILE_STRIDE + sx + TILE_BORDER] =
        300 + 60 * Math.sin(d.x * 3000) * Math.cos(d.z * 2500);
    }
  }
  return {
    key: k,
    height,
    material: new Uint32Array(TILE_STRIDE * TILE_STRIDE).fill((200 << 24) | 8),
    lake: new Float32Array(TILE_STRIDE * TILE_STRIDE).fill(NO_LAKE),
    minHeight: 0,
    maxHeight: 500,
  };
}

describe('graded tile meshes', () => {
  const home = tileKey(4, 8, 101, 77);
  const pad = padIn(home);
  const grading = new SurfaceGrading([pad], R);
  const base: MeshOptions = {
    radius: R,
    reliefScale: 0.157,
    mode: 'biome',
    detail: new Noise3(rng(1, 'test-detail')),
  };
  const graded: MeshOptions = { ...base, grading };
  const build = (t: TileKey, o: MeshOptions) =>
    buildTileMesh(
      t,
      {
        data: fakeData(dataTileFor(t)),
        parentData: t.level > 0 && t.level <= 7 ? fakeData(parentTile(t)!) : null,
      },
      o,
    );
  const up = (m: TileMeshData, v: number) =>
    new Vec3d(m.up[v * 3]!, m.up[v * 3 + 1]!, m.up[v * 3 + 2]!);
  for (const level of [8, 9, 10]) {
    it(`draws the pad flat at the field elevation (level ${level})`, () => {
      const t =
        level === 8
          ? home
          : level === 9
            ? childTiles(home)[0]!
            : childTiles(childTiles(home)[3]!)[0]!;
      const m = build(t, graded);
      let inside = 0;
      for (let v = 0; v < GRID_VERTEX_COUNT; v++) {
        if (grading.apply(up(m, v), 9e3) !== pad.elevation) continue;
        inside++;
        expect(m.height[v]).toBeCloseTo(pad.elevation, 3);
        // No forest canopy on the field.
        expect(m.forest[v]).toBe(0);
      }
      expect(inside).toBeGreaterThan(10);
      // Normals are radial well inside the pad (slopes from samples one apart).
      const slope = (mm: TileMeshData, v: number) =>
        Math.hypot(mm.slope[v * 3]!, mm.slope[v * 3 + 1]!, mm.slope[v * 3 + 2]!);
      const ungraded = build(t, base);
      const deep = offsetPoint(pad.center, pad.heading, 0, 300, R);
      let flattened = 0;
      for (let v = 0; v < GRID_VERTEX_COUNT; v++) {
        if (up(m, v).normalize().distanceTo(deep) * R > 350) continue;
        expect(slope(m, v)).toBeLessThan(1e-6);
        if (slope(ungraded, v) > 1e-3) flattened++;
      }
      if (level === 8) expect(flattened).toBeGreaterThan(10);
    });
  }

  it('leaves tiles the pad does not reach byte-identical', () => {
    const far = tileKey(4, 8, 120, 77);
    const a = build(far, base);
    const b = build(far, graded);
    expect(b.height).toEqual(a.height);
    expect(b.slope).toEqual(a.slope);
    expect(b.forest).toEqual(a.forest);
    expect(Math.max(...a.forest)).toBeGreaterThan(0.7);
  });

  it('keeps graded neighbors sealed and the morph exact', () => {
    const a = childTiles(home)[3]!;
    const b = neighborTile(a, 1, 0);
    const ma = build(a, graded);
    const mb = build(b, graded);
    for (let j = 0; j < V; j++) {
      const pa = displacedPosition(ma, j * V + TILE_SEGMENTS, 3).add(ma.origin);
      const pb = displacedPosition(mb, j * V, 3).add(mb.origin);
      expect(pa.distanceTo(pb)).toBeLessThan(0.01);
    }
    const mp = build(home, graded);
    const half = TILE_SEGMENTS / 2;
    for (let j = 0; j < V; j += 2) {
      for (let i = 0; i < V; i += 2) {
        const pc = displacedPosition(ma, j * V + i, 3, 0).add(ma.origin);
        const pp = displacedPosition(mp, (half + j / 2) * V + half + i / 2, 3).add(mp.origin);
        expect(pc.distanceTo(pp)).toBeLessThan(0.01);
      }
    }
  });
});

describe('airfield pads', () => {
  it('samples a global map bilinearly', () => {
    const n = 16;
    const map = new Float32Array(6 * n * n);
    for (let f = 0; f < 6; f++)
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) map[(f * n + j) * n + i] = f * 1000 + i * 10 + j;
    const s = globalMapSampler(map, n);
    // Face 4 (+Z), u = v = 0.5: halfway between cells 7 and 8 on both axes.
    expect(s(cubeFaceUvToDirection(4, 0.5, 0.5))).toBeCloseTo(4000 + 75 + 7.5, 3);
    expect(s(cubeFaceUvToDirection(2, (3 + 0.5) / n, (5 + 0.5) / n))).toBeCloseTo(2035, 3);
  });

  const w = generateCampaignWorld(
    { ...DEFAULT_PLANET_PARAMS, seed: 7 },
    { grid: new CubeGrid(64) },
  );
  const scene = new InfraScene(w.graph, w.infrastructure, DEFAULT_PLANET_PARAMS.radius);

  it('grades one pad per airbase at the mean height over it', () => {
    const tilt = (d: Readonly<Vec3d>) => 5000 + 1000 * d.y;
    const pads = airfieldPads(scene, tilt);
    expect(pads.length).toBe(w.infrastructure.airbases.length);
    for (const [k, p] of pads.entries()) {
      const base = w.infrastructure.airbases[k]!;
      expect(p.center.x).toBeCloseTo(base.point[0], 12);
      expect(p.along1 - p.along0).toBeGreaterThan(base.runwayLength);
      expect(p.margin).toBe(AIRFIELD_MARGIN);
      // A linear field: the pad's mean is the field at its middle.
      const mid = offsetPoint(p.center, p.heading, 0, (p.across0 + p.across1) / 2, scene.radius);
      expect(p.elevation).toBeCloseTo(tilt(mid), 1);
    }
    // Lowland fields stay above the sea.
    for (const p of airfieldPads(scene, () => -20)) expect(p.elevation).toBeGreaterThan(0);
  });

  it('builds the grading from the global height map', () => {
    const n = 32;
    const g = airfieldGrading(scene, new Float32Array(6 * n * n).fill(150), n);
    expect(g.count).toBe(w.infrastructure.airbases.length);
    const p = new Vec3d(...w.infrastructure.airbases[0]!.point);
    expect(g.apply(p, 175)).toBeCloseTo(150, 6);
  });
});
