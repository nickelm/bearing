/**
 * Relief at a point, at two scales, to judge the shape of the terrain:
 *
 *   npx vitest run --config vitest.tools.config.ts tools/relief.preview.ts
 *   env: SEED (1983), LAT, LON (deg; default the main continent), EX exaggeration for the
 *        shading (10), GLOBAL_KM half-width of the global view (150), TILE_KM half-width of
 *        the tile view (20), LEVEL tile level (7), GRES global grid resolution (1024; 512 is
 *        about four times faster for tuning)
 *        What-if gains, for proposals: GAIN multiplies the global grid's wavelengths below
 *        BAND_KM (30) about a Gaussian blur, DETAIL_GAIN the tiles' detail over the global
 *        grid (both 1); files then get a -g<GAIN>-d<DETAIL_GAIN>-ex<EX> suffix.
 *
 * Output in tools/out/:
 *   relief-<seed>-global.png  the eroded global grid (about 1.5 km cells), bilinear
 *   relief-<seed>-tiles.png   synthesized tiles at LEVEL (about 48 m at 7): what the
 *                             simulation view draws
 * Both: hypsometric tint with a hillshade from the northwest, north up.
 *
 * It also prints, for both, the height range and the structure function: the RMS
 * height difference between points a given distance apart. Its growth with distance
 * shows where the relief lives: in long wavelengths (valleys and ranges) or short
 * ones (noise).
 */
import { it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { TileSynthesizer } from '../src/worldgen/gpu/tileSynth';
import type { TileData } from '../src/worldgen/gpu/tileSynth';
import { RiverIndex } from '../src/worldgen/riverIndex';
import { LANDFORM } from '../src/worldgen/gpu/erosion';
import { directionToCubeFace, latLonToDirection } from '../src/core/coords';
import type { CubeFaceUv } from '../src/core/coords';
import {
  tileForDirection,
  tileKeyString,
  TILE_BORDER,
  TILE_STRIDE,
  TILE_TEXELS,
} from '../src/core/tiles';
import { DEG, KM } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { testGpu } from '../tests/gpu/device';
import { previewWorld } from './previewWorld';
import { encodePng } from './png';

const S = 768;

type Sampler = (d: Readonly<Vec3d>) => number;

/** Directions of an S × S orthographic grid, `halfKm` either side of the center, north up. */
function grid(center: Vec3d, halfKm: number, R: number): Vec3d[] {
  const east = new Vec3d(0, 1, 0).cross(center).normalize();
  const north = center.clone().cross(east);
  const out: Vec3d[] = [];
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const x = ((i + 0.5) / S - 0.5) * 2 * halfKm * KM;
      const y = (0.5 - (j + 0.5) / S) * 2 * halfKm * KM;
      out.push(
        center
          .clone()
          .addScaled(east, x / R)
          .addScaled(north, y / R)
          .normalize(),
      );
    }
  }
  return out;
}

function tint(r: number): [number, number, number] {
  if (r <= 0) return [0.2, 0.4, 0.65];
  const stops: [number, [number, number, number]][] = [
    [0, [0.3, 0.5, 0.28]],
    [400, [0.45, 0.6, 0.32]],
    [1200, [0.72, 0.68, 0.42]],
    [2500, [0.6, 0.45, 0.3]],
    [4000, [0.75, 0.72, 0.7]],
    [6000, [1, 1, 1]],
  ];
  for (let k = 1; k < stops.length; k++) {
    const [h1, c1] = stops[k]!;
    if (r <= h1 || k === stops.length - 1) {
      const [h0, c0] = stops[k - 1]!;
      const t = Math.min(1, Math.max(0, (r - h0) / (h1 - h0)));
      return [0, 1, 2].map((c) => c0[c]! + (c1[c]! - c0[c]!) * t) as [number, number, number];
    }
  }
  return [1, 1, 1];
}

function writeShaded(
  file: string,
  h: Float64Array,
  cellM: number,
  relief: number,
  ex: number,
): void {
  const img = new Uint8Array(S * S * 3);
  const at = (i: number, j: number) =>
    h[Math.min(S - 1, Math.max(0, j)) * S + Math.min(S - 1, Math.max(0, i))]!;
  const L = new Vec3d(-1, 1, 1.2).normalize(); // from the northwest, 45° up
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const dx = ((at(i + 1, j) - at(i - 1, j)) * ex) / (2 * cellM);
      const dy = ((at(i, j - 1) - at(i, j + 1)) * ex) / (2 * cellM);
      const n = new Vec3d(-dx, -dy, 1).normalize();
      const shade = Math.max(0, n.dot(L)) / L.z;
      // Tinted by height ÷ (reliefScale × the landform gain), so colors keep their old meaning.
      const c = tint(at(i, j) / (relief * LANDFORM.gain));
      for (let k = 0; k < 3; k++) {
        img[(j * S + i) * 3 + k] = Math.round(255 * Math.min(1, c[k]! * (0.35 + 0.65 * shade)));
      }
    }
  }
  writeFileSync(file, encodePng(S, S, img));
}

/** Separable Gaussian blur of an S × S array (σ in cells), clamped at the edges. */
function blur(h: Float64Array, sigma: number): Float64Array {
  const r = Math.ceil(3 * sigma);
  const w = Array.from({ length: 2 * r + 1 }, (_, k) =>
    Math.exp(-((k - r) ** 2) / (2 * sigma * sigma)),
  );
  const sum = w.reduce((a, b) => a + b, 0);
  const pass = (src: Float64Array, horizontal: boolean) => {
    const out = new Float64Array(S * S);
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) {
          const ii = horizontal ? Math.min(S - 1, Math.max(0, i + k)) : i;
          const jj = horizontal ? j : Math.min(S - 1, Math.max(0, j + k));
          acc += src[jj * S + ii]! * w[k + r]!;
        }
        out[j * S + i] = acc / sum;
      }
    }
    return out;
  };
  return pass(pass(h, true), false);
}

/** Bilinear sample of an S × S array at fractional cell coordinates. */
function bilinear(h: Float64Array, x: number, y: number): number {
  const fx = Math.min(S - 1.001, Math.max(0, x));
  const fy = Math.min(S - 1.001, Math.max(0, y));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const tx = fx - i;
  const ty = fy - j;
  return (
    (h[j * S + i]! * (1 - tx) + h[j * S + i + 1]! * tx) * (1 - ty) +
    (h[(j + 1) * S + i]! * (1 - tx) + h[(j + 1) * S + i + 1]! * tx) * ty
  );
}

/** RMS height difference at each lag (m), along rows and columns of the S × S grid. */
function structure(h: Float64Array, cellM: number, lagsM: number[]): string {
  return lagsM
    .map((lag) => {
      const k = Math.round(lag / cellM);
      if (k < 1 || k >= S) return null;
      let sum = 0;
      let n = 0;
      for (let j = 0; j < S; j += 2) {
        for (let i = 0; i + k < S; i += 2) {
          sum += (h[j * S + i + k]! - h[j * S + i]!) ** 2;
          sum += (h[i * S + j]! - h[(i + k) * S + j]!) ** 2; // columns: (row i, col j) to (row i+k)
          n += 2;
        }
      }
      return `${lag >= KM ? `${lag / KM} km` : `${lag} m`}: ${Math.sqrt(sum / n).toFixed(0)} m`;
    })
    .filter(Boolean)
    .join(', ');
}

function summary(
  label: string,
  h: Float64Array,
  cellM: number,
  relief: number,
  lags: number[],
): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of h) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  console.log(
    `${label}: heights ${lo.toFixed(0)}..${hi.toFixed(0)} m physical ` +
      `(${(lo / relief).toFixed(0)}..${(hi / relief).toFixed(0)} m reference)\n` +
      `  RMS difference at a distance: ${structure(h, cellM, lags)}`,
  );
}

it('relief at a point', { timeout: 1_800_000 }, async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No GPU adapter (Dawn)');
  const env = process.env;
  const seed = env.SEED ?? '1983';
  const campaign = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed });
  const params = { ...DEFAULT_PLANET_PARAMS, seed: campaign.seed };
  const { world, global } = await previewWorld(gpu, params, 256, Number(env.GRES ?? 1024));
  const R = params.radius;
  const relief = params.reliefScale;
  const ex = Number(env.EX ?? 10);
  const center =
    env.LAT && env.LON
      ? latLonToDirection(Number(env.LAT) * DEG, Number(env.LON) * DEG)
      : new Vec3d(...world.info.mainContinent).normalize();
  const out = join(import.meta.dirname, 'out');
  mkdirSync(out, { recursive: true });

  // The global grid, bilinear.
  const n = global.n;
  const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  const globalAt: Sampler = (d) => {
    directionToCubeFace(d, uv);
    const fx = Math.min(n - 1.001, Math.max(0, uv.u * n - 0.5));
    const fy = Math.min(n - 1.001, Math.max(0, uv.v * n - 0.5));
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    const tx = fx - x;
    const ty = fy - y;
    const c = (xx: number, yy: number) => global.height[(uv.face * n + yy) * n + xx]!;
    return (
      (c(x, y) * (1 - tx) + c(x + 1, y) * tx) * (1 - ty) +
      (c(x, y + 1) * (1 - tx) + c(x + 1, y + 1) * tx) * ty
    );
  };
  {
    directionToCubeFace(center, uv);
    const c =
      (uv.face * n + Math.min(n - 1, Math.floor(uv.v * n))) * n +
      Math.min(n - 1, Math.floor(uv.u * n));
    console.log(
      `center: height ${global.height[c]!.toFixed(0)} m (${(global.height[c]! / relief).toFixed(0)} m reference), ` +
        `uplift ${global.uplift[c]!.toFixed(0)} m reference`,
    );
  }
  {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of global.height) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    console.log(`planet: heights ${lo.toFixed(0)}..${hi.toFixed(0)} m physical`);
  }
  const gKm = Number(env.GLOBAL_KM ?? 150);
  const gDirs = grid(center, gKm, R);
  const gRaw = new Float64Array(gDirs.map(globalAt));
  const gCell = (2 * gKm * KM) / S;
  const gain = Number(env.GAIN ?? 1);
  const detailGain = Number(env.DETAIL_GAIN ?? 1);
  const suffix = gain !== 1 || detailGain !== 1 ? `-g${gain}-d${detailGain}-ex${ex}` : '';
  // The long wavelengths, kept as they are; shorter ones scaled by GAIN.
  const bandKm = Number(env.BAND_KM ?? 30);
  const gBlur = gain !== 1 ? blur(gRaw, (bandKm * KM) / 4 / gCell) : gRaw;
  const gH = gRaw.map((v, k) => gBlur[k]! + gain * (v - gBlur[k]!));
  writeShaded(join(out, `relief-${seed}-global${suffix}.png`), gH, gCell, relief, ex);
  summary(`global grid, ${2 * gKm} km across`, gH, gCell, relief, [
    1 * KM,
    3 * KM,
    10 * KM,
    30 * KM,
    100 * KM,
  ]);

  // Synthesized tiles at LEVEL.
  const level = Number(env.LEVEL ?? 7);
  const tKm = Number(env.TILE_KM ?? 20);
  const tDirs = grid(center, tKm, R);
  const keys = new Map<string, ReturnType<typeof tileForDirection>>();
  for (const d of tDirs) {
    const k = tileForDirection(d, level);
    keys.set(tileKeyString(k), k);
  }
  const synth = new TileSynthesizer(global.grid, {
    seed: params.seed,
    reliefScale: relief,
    radius: R,
    biome: global.finish.biome,
    lakeDepth: global.finish.drainage.lakeDepth,
    height: global.height,
    forest: global.finish.forest,
    treeline: global.finish.treeline,
    index: new RiverIndex(global.finish.rivers, { height: global.height, radius: R }),
    // TUNING='{"gullies":0.2}' overrides tile-synthesis tuning, for experiments.
    tuning: env.TUNING ? (JSON.parse(env.TUNING) as Record<string, number>) : undefined,
  });
  console.log(`tuning gullies ${synth.tuning.gullies}, octaves ${synth.octavesAt(level)}`);
  const tiles = new Map<string, TileData>();
  for (const d of await synth.generate([...keys.values()])) tiles.set(tileKeyString(d.key), d);
  const tileAt: Sampler = (d) => {
    const k = tileForDirection(d, level);
    const t = tiles.get(tileKeyString(k))!;
    directionToCubeFace(d, uv);
    const size = TILE_TEXELS * (1 << level);
    const sx = Math.min(TILE_TEXELS, Math.max(0, Math.round(uv.u * size - k.x * TILE_TEXELS)));
    const sy = Math.min(TILE_TEXELS, Math.max(0, Math.round(uv.v * size - k.y * TILE_TEXELS)));
    return t.height[(sy + TILE_BORDER) * TILE_STRIDE + sx + TILE_BORDER]!;
  };
  // MASKS=1: also a map of the landform masks (red aridity, blue glaciation; decision 126).
  if (env.MASKS === '1') {
    const img = new Uint8Array(S * S * 3);
    tDirs.forEach((d, k) => {
      const kk = tileForDirection(d, level);
      const t = tiles.get(tileKeyString(kk))!;
      directionToCubeFace(d, uv);
      const size = TILE_TEXELS * (1 << level);
      const sx = Math.min(TILE_TEXELS, Math.max(0, Math.round(uv.u * size - kk.x * TILE_TEXELS)));
      const sy = Math.min(TILE_TEXELS, Math.max(0, Math.round(uv.v * size - kk.y * TILE_TEXELS)));
      const m = t.material[(sy + TILE_BORDER) * TILE_STRIDE + sx + TILE_BORDER]!;
      const h = t.height[(sy + TILE_BORDER) * TILE_STRIDE + sx + TILE_BORDER]!;
      img[k * 3] = Math.round((((m >>> 17) & 15) / 15) * 255);
      img[k * 3 + 1] = h > 0 ? 60 : 0;
      img[k * 3 + 2] = Math.round((((m >>> 21) & 7) / 7) * 255);
    });
    writeFileSync(join(out, `relief-${seed}-masks.png`), encodePng(S, S, img));
  }
  const tCell = (2 * tKm * KM) / S;
  // Tile = global + detail; the what-if scales the global's short wavelengths and the detail.
  const toGlobalCell = (i: number) => ((((i + 0.5) / S - 0.5) * tKm) / gKm) * S + S / 2 - 0.5;
  const tH = new Float64Array(S * S);
  tDirs.forEach((d, k) => {
    const tile = tileAt(d);
    const g = globalAt(d);
    const b = bilinear(gBlur, toGlobalCell(k % S), toGlobalCell(Math.floor(k / S)));
    tH[k] = b + gain * (g - b) + detailGain * (tile - g);
  });
  writeShaded(join(out, `relief-${seed}-tiles${suffix}.png`), tH, tCell, relief, ex);
  summary(`level-${level} tiles, ${2 * tKm} km across`, tH, tCell, relief, [
    100,
    300,
    1 * KM,
    3 * KM,
    10 * KM,
  ]);
  // The global grid over the same window, for comparison.
  summary(
    `global grid over the same ${2 * tKm} km`,
    new Float64Array(tDirs.map(globalAt)),
    tCell,
    relief,
    [100, 300, 1 * KM, 3 * KM, 10 * KM],
  );
  global.grid.dispose();
});
