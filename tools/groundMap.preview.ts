/**
 * The air-to-ground radar's ground map over a real world (decision 226): finds a coast
 * near the main continent (or takes LAT and LON), puts the aircraft ALT m up (default
 * 3,000) KM km inland (default 30) heading toward the sea, and writes, for each range in
 * RANGES (nm, default 10,20,40), the B-scope as the format draws it beside a height map of
 * the same sector, to tools/out/groundmap-<nm>.png, and the map as JSON for the displays
 * page (`&gmr=groundmap-<nm>.json`). Heights are the eroded global grid,
 * about 1.5 km a cell, so the picture is coarser than in flight over level-7 tiles.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/groundMap.preview.ts
 */
import { it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { directionToCubeFace, latLonToDirection } from '../src/core/coords';
import type { CubeFaceUv } from '../src/core/coords';
import { DEG, KM } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { groundMap } from '../src/sim/sensors/groundMap';
import { testGpu } from '../tests/gpu/device';
import { previewWorld } from './previewWorld';
import { encodePng } from './png';

it('ground map', { timeout: 3_600_000 }, async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No GPU adapter (Dawn)');
  const env = process.env;
  const params = { ...DEFAULT_PLANET_PARAMS, ...(env.SEED ? { seed: env.SEED } : {}) };
  const { world, global } = await previewWorld(gpu, params, 256, Number(env.GRES ?? 1024));
  const R = params.radius;
  const n = global.n;
  const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  const height = (d: Readonly<Vec3d>) => {
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
  const along = (from: Vec3d, dir: Vec3d, m: number) =>
    from
      .clone()
      .scale(Math.cos(m / R))
      .addScaled(dir, Math.sin(m / R))
      .normalize();
  const tangent = (at: Vec3d, toward: Vec3d) =>
    toward.clone().addScaled(at, -toward.dot(at)).normalize();
  // The start: LAT/LON, else the main continent's center; then out along headings for the
  // first sea, and back inland.
  const center =
    env.LAT && env.LON
      ? latLonToDirection(Number(env.LAT) * DEG, Number(env.LON) * DEG)
      : new Vec3d(...world.info.mainContinent).normalize();
  const east = new Vec3d(0, 1, 0).cross(center).normalize();
  const north = center.clone().cross(east);
  let coast: { at: Vec3d; heading: Vec3d } | null = null;
  for (let k = 0; k < 16 && !coast; k++) {
    const a = (k / 16) * 2 * Math.PI;
    const dir = north.clone().scale(Math.cos(a)).addScaled(east, Math.sin(a));
    for (let m = 0; m < 2000 * KM; m += 2 * KM) {
      if (height(along(center, dir, m)) <= 0) {
        const inland = Number(env.KM ?? 30) * KM;
        const at = along(center, dir, Math.max(0, m - inland));
        coast = { at, heading: tangent(at, along(center, dir, m)) };
        break;
      }
    }
  }
  if (!coast) throw new Error('no coast found');
  const alt = Number(env.ALT ?? 3000);
  const pos = coast.at.clone().scale(R + Math.max(0, height(coast.at)) + alt);
  const out = join(import.meta.dirname, 'out');
  mkdirSync(out, { recursive: true });
  for (const nm of (env.RANGES ?? '10,20,40').split(',').map(Number)) {
    const range = nm * 1852;
    const t0 = performance.now();
    const img = groundMap(pos, coast.heading, range, Math.PI / 3, R, {
      height,
      water: (d) => height(d) <= 0,
    });
    const ms = performance.now() - t0;
    // The scope (scaled 6×, smoothed by nearest) beside a height map of the same sector.
    const S = 6;
    const W = img.cols * S;
    const H = img.rows * S;
    const rgb = new Uint8Array(2 * W * H * 3);
    const right = coast.heading.clone().cross(coast.at).normalize();
    let hiH = 1;
    const hs: number[] = [];
    for (let j = 0; j < img.rows; j++)
      for (let i = 0; i < img.cols; i++) {
        const az = -img.azimuth + ((i + 0.5) / img.cols) * 2 * img.azimuth;
        const g = ((j + 0.5) / img.rows) * range;
        const h = coast.heading.clone().scale(Math.cos(az)).addScaled(right, Math.sin(az));
        const v = height(along(coast.at, h, g));
        hs.push(v);
        hiH = Math.max(hiH, v);
      }
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = Math.floor(x / S);
        const j = img.rows - 1 - Math.floor(y / S);
        const v = img.values[j * img.cols + i]! / 255;
        const o = (y * 2 * W + x) * 3;
        rgb[o] = Math.round(0x6c * v);
        rgb[o + 1] = Math.round(0xff * v);
        rgb[o + 2] = Math.round(0x8a * v);
        const h = hs[j * img.cols + i]!;
        const p = (y * 2 * W + W + x) * 3;
        if (h <= 0) [rgb[p], rgb[p + 1], rgb[p + 2]] = [40, 70, 120];
        else {
          const k = Math.round(60 + 195 * (h / hiH));
          [rgb[p], rgb[p + 1], rgb[p + 2]] = [k, k, k];
        }
      }
    writeFileSync(join(out, `groundmap-${nm}.png`), encodePng(2 * W, H, rgb));
    // For the displays page: `composite.html?…&gmr=groundmap-<nm>.json`.
    writeFileSync(join(out, `groundmap-${nm}.json`), JSON.stringify(img));
    console.log(
      `groundmap-${nm}.png: ${img.cols}×${img.rows} in ${ms.toFixed(1)} ms; heights up to ${hiH.toFixed(0)} m`,
    );
  }
});
