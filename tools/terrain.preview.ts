/**
 * Offline terrain preview for the GPU global grid (milestone 2). Runs the
 * CPU tectonic stages, then the GPU stages on Dawn (the `webgpu` package),
 * and writes PNGs, so terrain can be inspected without a browser.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/terrain.preview.ts
 *   env: SEED (1983), TRES tectonic resolution (256), GRES global resolution (1024),
 *        VIEWS comma list of global,region (both), REGION_KM half-width (400)
 *
 * Output: tools/out/terrain-<seed>-<gres>-<view>.png (gitignored).
 *   global: equirectangular, 2048 × 1024, hypsometric tint with hillshade.
 *   region: 1024 × 1024 orthographic close-up centered on the main continent.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { directionToCubeFace } from '../src/core/coords';
import type { CubeFaceUv } from '../src/core/coords';
import { Vec3d } from '../src/core/vec3d';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { generateWorld } from '../src/worldgen/pipeline';
import { testGpu } from '../tests/gpu/device';
import { BIOME_COLORS } from '../src/render/common/palette';
import { finishWorld } from '../src/worldgen/finishWorld';
import { buildGlobalWorld } from '../src/worldgen/globalPipeline';
import { encodePng } from './png';

export interface TerrainView {
  n: number;
  height: Float32Array;
  /** Optional overlay: 0..1 per cell, drawn in blue (e.g. rivers). */
  water?: Float32Array;
  /** Optional biome per cell; colors the land with the biome palette instead of height. */
  biome?: Uint8Array;
}

const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
function cellAt(n: number, d: Readonly<Vec3d>): number {
  directionToCubeFace(d, uv);
  const i = Math.min(n - 1, Math.max(0, Math.floor(uv.u * n)));
  const j = Math.min(n - 1, Math.max(0, Math.floor(uv.v * n)));
  return (uv.face * n + j) * n + i;
}

/** Hypsometric tint for a physical height, given the relief scale. */
function tint(h: number, relief: number): [number, number, number] {
  const r = h / relief; // reference meters
  if (r <= 0) {
    const t = Math.min(1, -r / 5000);
    return [0.16 - 0.1 * t, 0.36 - 0.2 * t, 0.62 - 0.25 * t];
  }
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
    const [h0, c0] = stops[k - 1]!;
    if (r <= h1) {
      const t = (r - h0) / (h1 - h0);
      return [
        c0[0] + (c1[0] - c0[0]) * t,
        c0[1] + (c1[1] - c0[1]) * t,
        c0[2] + (c1[2] - c0[2]) * t,
      ];
    }
  }
  return [1, 1, 1];
}

/**
 * Renders `width × height` pixels; `dirAt(px, py, out)` gives each pixel's direction and
 * `pixelAngle` its approximate angular size (for hillshade differences).
 */
export function renderTerrain(
  view: TerrainView,
  width: number,
  height: number,
  dirAt: (px: number, py: number, out: Vec3d) => boolean,
  pixelAngle: number,
  relief: number,
  radius: number,
  shadeExaggeration: number,
): Uint8Array {
  const img = new Uint8Array(width * height * 3);
  const d = new Vec3d();
  const e = new Vec3d();
  const nn = new Vec3d();
  const p = new Vec3d();
  const up = new Vec3d(0, 1, 0);
  const step = Math.max(pixelAngle, (Math.PI / 2 / view.n) * 1.2);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      if (!dirAt(px, py, d)) continue;
      const c = cellAt(view.n, d);
      const h = view.height[c]!;
      let [r, g, b] = view.biome ? BIOME_COLORS[view.biome[c]!]! : tint(h, relief);
      if (h > 0) {
        e.copy(up).cross(d);
        if (e.lengthSq() < 1e-12) e.set(1, 0, 0);
        e.normalize();
        nn.copy(d).cross(e);
        p.copy(d)
          .addScaled(e, -0.6 * step)
          .addScaled(nn, 0.6 * step)
          .normalize();
        const h2 = Math.max(0, view.height[cellAt(view.n, p)]!);
        const slope = ((h2 - h) * shadeExaggeration) / (step * radius);
        const shade = Math.min(1.5, Math.max(0.35, 1 + slope * 2));
        r *= shade;
        g *= shade;
        b *= shade;
      }
      if (view.water) {
        const w = Math.min(1, view.water[c]!);
        r = r * (1 - w) + 0.1 * w;
        g = g * (1 - w) + 0.3 * w;
        b = b * (1 - w) + 0.85 * w;
      }
      const o = (py * width + px) * 3;
      img[o] = Math.round(Math.min(1, r) * 255);
      img[o + 1] = Math.round(Math.min(1, g) * 255);
      img[o + 2] = Math.round(Math.min(1, b) * 255);
    }
  }
  return img;
}

export function writeViews(
  name: string,
  view: TerrainView,
  center: Vec3d,
  relief: number,
  radius: number,
  views: string[],
  regionKm: number,
): void {
  const outDir = join(import.meta.dirname, 'out');
  mkdirSync(outDir, { recursive: true });
  if (views.includes('global')) {
    const W = 2048;
    const H = 1024;
    const img = renderTerrain(
      view,
      W,
      H,
      (px, py, out) => {
        const lat = Math.PI / 2 - ((py + 0.5) / H) * Math.PI;
        const lon = ((px + 0.5) / W) * 2 * Math.PI - Math.PI;
        out.set(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
        return true;
      },
      Math.PI / H,
      relief,
      radius,
      20,
    );
    const file = join(outDir, `${name}-global.png`);
    writeFileSync(file, encodePng(W, H, img));
    console.info(`wrote ${file}`);
  }
  if (views.includes('region')) {
    const S = 1024;
    const half = (regionKm * 1000) / radius;
    const c = center.clone().normalize();
    const east = new Vec3d(0, 1, 0).cross(c).normalize();
    const north = c.clone().cross(east);
    const img = renderTerrain(
      view,
      S,
      S,
      (px, py, out) => {
        const x = (((px + 0.5) / S) * 2 - 1) * half;
        const y = (1 - ((py + 0.5) / S) * 2) * half;
        out.copy(c).addScaled(east, x).addScaled(north, y).normalize();
        return true;
      },
      (2 * half) / S,
      relief,
      radius,
      6,
    );
    const file = join(outDir, `${name}-region.png`);
    writeFileSync(file, encodePng(S, S, img));
    console.info(`wrote ${file}`);
  }
}

it('render terrain previews', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No GPU adapter (Dawn)');
  const seed = process.env.SEED ?? String(DEFAULT_PLANET_PARAMS.seed);
  const tres = Number(process.env.TRES ?? 256);
  const gres = Number(process.env.GRES ?? 1024);
  const views = (process.env.VIEWS ?? 'global,region').split(',');
  const regionKm = Number(process.env.REGION_KM ?? 400);
  const params = { ...DEFAULT_PLANET_PARAMS, seed };

  let t0 = performance.now();
  const world = generateWorld(params, { resolution: tres });
  console.info(`tectonic ${tres}: ${(performance.now() - t0).toFixed(0)} ms`);
  const strength = Number(process.env.EROSION ?? 1);
  t0 = performance.now();
  const g = await buildGlobalWorld(gpu, { ...params, erosionStrength: strength }, world, {
    n: gres,
    finish: async (input) => finishWorld(input),
  });
  console.info(`global pass ${gres}: ${(performance.now() - t0).toFixed(0)} ms`);
  if (gpu.errors.length) throw new Error(`GPU errors: ${gpu.errors.join(' | ')}`);
  const timings = [...g.timings, ...g.finish.timings];
  const lines = timings.map((t) => `  ${t.stage}: ${t.ms.toFixed(0)} ms`);
  lines.push(`  rivers: ${g.finish.rivers.count} polylines`);
  console.info(lines.join('\n'));
  // Rivers (log of discharge above 20 m³/s) and lakes.
  const { discharge, lakeDepth } = g.finish.drainage;
  const water = new Float32Array(discharge.length);
  for (let c = 0; c < water.length; c++) {
    const q = discharge[c]!;
    water[c] = lakeDepth[c]! > 0 ? 0.8 : q >= 20 ? Math.min(0.9, 0.35 + Math.log10(q / 20) / 2) : 0;
  }
  const [x, y, z] = world.info.mainContinent;
  const name = `terrain-${seed}-${gres}-e${strength}`;
  const center = new Vec3d(x, y, z);
  writeViews(
    name,
    { n: gres, height: g.height, water },
    center,
    params.reliefScale,
    params.radius,
    views,
    regionKm,
  );
  writeViews(
    `${name}-biome`,
    { n: gres, height: g.height, water, biome: g.finish.biome },
    center,
    params.reliefScale,
    params.radius,
    views,
    regionKm,
  );
  writeFileSync(join(import.meta.dirname, 'out', `${name}-timings.txt`), lines.join('\n'));
  g.grid.dispose();
});
