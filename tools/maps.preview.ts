/**
 * Offline world preview: generates a world in Node and writes PNG maps,
 * so a world can be inspected without a browser (useful for Claude Code
 * sessions, which cannot see the WebGPU view).
 *
 * Each PNG is 1024 × 1024: an equirectangular map on top (longitude −180°
 * to 180° left to right, north at the top), and orthographic views of the
 * north pole (bottom left) and south pole (bottom right) below. Land is
 * hillshaded.
 *
 *   npm run maps                                      # seed 1983, 256, biome
 *   $env:SEED="7"; $env:MODES="biome,plates"; npm run maps   (PowerShell)
 *   SEED=7 MODES=biome,temperature RES=128 npm run maps       (POSIX)
 *
 * Output goes to tools/out/<seed>-<res>-<mode>.png (gitignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { Vec3d } from '../src/core/vec3d';
import { cellColor, VIEW_MODES } from '../src/render/cellColors';
import type { ViewMode } from '../src/render/cellColors';
import { faceColors } from '../src/render/palette';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { generateWorld } from '../src/worldgen/pipeline';
import type { World } from '../src/worldgen/pipeline';
import { encodePng } from './png';

const SIZE = 1024;
/** Light from the northwest, in each pixel's local east/north/up frame. */
const LIGHT_EAST = -0.6;
const LIGHT_NORTH = 0.6;
const SHADE_EXAGGERATION = 25;

function render(world: World, grid: CubeGrid, mode: ViewMode): Uint8Array {
  const img = new Uint8Array(SIZE * SIZE * 3);
  const faces = faceColors(DEFAULT_PLANET_PARAMS.seed);
  const d = new Vec3d();
  const east = new Vec3d();
  const north = new Vec3d();
  const probe = new Vec3d();
  const up = new Vec3d(0, 1, 0);
  const R = DEFAULT_PLANET_PARAMS.radius;
  const step = (Math.PI / 2 / grid.n) * 1.5;

  const put = (px: number, py: number, dir: Vec3d) => {
    const c = grid.cellOfDirection(dir);
    const rgb = cellColor(mode, world, c, faces[grid.faceOf(c)]!);
    let shade = 1;
    const h = world.maps.height[c];
    if (h > 0) {
      east.copy(up).cross(dir);
      if (east.lengthSq() < 1e-12) east.set(1, 0, 0);
      east.normalize();
      north.copy(dir).cross(east);
      probe
        .copy(dir)
        .addScaled(east, LIGHT_EAST * step)
        .addScaled(north, LIGHT_NORTH * step)
        .normalize();
      const h2 = Math.max(0, world.maps.height[grid.cellOfDirection(probe)]);
      const slope = ((h2 - h) * SHADE_EXAGGERATION) / (step * R);
      shade = Math.min(1.5, Math.max(0.45, 1 + slope * 2));
    }
    const o = (py * SIZE + px) * 3;
    img[o] = Math.round(Math.min(1, rgb[0] * shade) * 255);
    img[o + 1] = Math.round(Math.min(1, rgb[1] * shade) * 255);
    img[o + 2] = Math.round(Math.min(1, rgb[2] * shade) * 255);
  };

  // Top half: equirectangular, longitude 0 (+Z) at the center.
  const H = SIZE / 2;
  for (let py = 0; py < H; py++) {
    const lat = Math.PI / 2 - ((py + 0.5) / H) * Math.PI;
    for (let px = 0; px < SIZE; px++) {
      const lon = ((px + 0.5) / SIZE) * 2 * Math.PI - Math.PI;
      d.set(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
      put(px, py, d);
    }
  }
  // Bottom half: orthographic polar caps (north left, south right), +Z toward the bottom.
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < SIZE; px++) {
      const south = px >= H;
      const x = (((px % H) + 0.5) / H) * 2 - 1;
      const z = ((py + 0.5) / H) * 2 - 1;
      const r2 = x * x + z * z;
      if (r2 > 1) continue; // black outside the disk
      const y = Math.sqrt(1 - r2) * (south ? -1 : 1);
      d.set(south ? -x : x, y, z);
      put(px, py + H, d);
    }
  }
  return img;
}

it('render world maps', () => {
  const seed = process.env.SEED ?? String(DEFAULT_PLANET_PARAMS.seed);
  const res = Number(process.env.RES ?? 256);
  const modes = (process.env.MODES ?? 'biome')
    .split(',')
    .map((m) => m.trim())
    .filter((m): m is ViewMode => (VIEW_MODES as readonly string[]).includes(m));
  const outDir = process.env.OUT ?? join(import.meta.dirname, 'out');
  mkdirSync(outDir, { recursive: true });

  const grid = new CubeGrid(res);
  const world = generateWorld({ ...DEFAULT_PLANET_PARAMS, seed }, { resolution: res, grid });
  for (const mode of modes) {
    const file = join(outDir, `${seed}-${res}-${mode}.png`);
    writeFileSync(file, encodePng(SIZE, SIZE, render(world, grid, mode)));
    console.info(`wrote ${file}`);
  }
});
