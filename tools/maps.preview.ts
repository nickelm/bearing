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
 *   SEED=7 MODES=graph,barrier npm run maps   strategic graph overlay, barrier map
 *
 * Output goes to tools/out/<seed>-<res>-<mode>.png (gitignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { Vec3d } from '../src/core/vec3d';
import { cellColor, VIEW_MODES } from '../src/render/sim/cellColors';
import type { ViewMode } from '../src/render/sim/cellColors';
import { faceColors } from '../src/render/common/palette';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { generateWorld } from '../src/worldgen/pipeline';
import type { World } from '../src/worldgen/pipeline';
import { strategicContext } from '../src/worldgen/strategic/builder';
import { barrierMap } from '../src/worldgen/strategic/fronts';
import type { StrategicGraph } from '../src/worldgen/strategic/graph';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import type { Cast } from '../src/campaign/cast';
import { buildTerritory } from '../src/worldgen/strategic/territory';
import type { Territory } from '../src/worldgen/strategic/territory';
import type { Infrastructure } from '../src/worldgen/strategic/infrastructure';
import { barrierColor, drawGraph, drawInfrastructure } from './graphOverlay';
import { MapCanvas } from './mapCanvas';
import { encodePng } from './png';

/** Extra modes beyond the globe's view modes: the strategic graph overlay and the barrier map. */
const EXTRA_MODES = ['graph', 'barrier'] as const;
type MapMode = ViewMode | (typeof EXTRA_MODES)[number];

const SIZE = 1024;
/** Light from the northwest, in each pixel's local east/north/up frame. */
const LIGHT_EAST = -0.6;
const LIGHT_NORTH = 0.6;
const SHADE_EXAGGERATION = 25;

function render(
  world: World,
  grid: CubeGrid,
  mode: ViewMode,
  colorOverride?: (cell: number) => [number, number, number] | null,
): Uint8Array {
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
    const rgb = colorOverride?.(c) ?? cellColor(mode, world, c, faces[grid.faceOf(c)]!);
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

const ALLIANCE_TINT = [0.2, 0.4, 1] as const;
const PACT_TINT = [1, 0.15, 0.1] as const;

it('render world maps', () => {
  const seed = process.env.SEED ?? String(DEFAULT_PLANET_PARAMS.seed);
  const res = Number(process.env.RES ?? 256);
  const all: readonly string[] = [...VIEW_MODES, ...EXTRA_MODES];
  const modes = (process.env.MODES ?? 'biome')
    .split(',')
    .map((m) => m.trim())
    .filter((m): m is MapMode => all.includes(m));
  const outDir = process.env.OUT ?? join(import.meta.dirname, 'out');
  mkdirSync(outDir, { recursive: true });

  const grid = new CubeGrid(res);
  const params = { ...DEFAULT_PLANET_PARAMS, seed };
  // The graph modes need the coarse pass (drainage and the strategic graph).
  const needsGraph = modes.some((m) => (EXTRA_MODES as readonly string[]).includes(m));
  let world: World;
  let graph: StrategicGraph | null = null;
  let cast: Cast | null = null;
  let territory: Territory | null = null;
  let infra: Infrastructure | null = null;
  if (needsGraph) {
    // The campaign world, so the map shows the seed that passed the validity check.
    const coarse = generateCampaignWorld(params, { grid });
    world = coarse.world;
    graph = coarse.graph;
    cast = coarse.campaign.cast;
    territory = buildTerritory(coarse.build, cast);
    infra = coarse.infrastructure;
    if (coarse.retries > 0)
      console.info(`seed ${seed}: retry ${coarse.retries} (${String(coarse.seed)})`);
    console.info(
      `graph: ${graph.nodes.length} nodes, ${graph.lanes.length} lanes, ` +
        `${graph.chokepoints.length} chokepoints, ${graph.barrierLines.length} barrier lines`,
    );
  } else {
    world = generateWorld(params, { resolution: res, grid });
  }
  for (const mode of modes) {
    const file = join(outDir, `${seed}-${res}-${mode}.png`);
    let img: Uint8Array;
    if (mode === 'graph') {
      const tint = territory!.owner;
      const faces = faceColors(DEFAULT_PLANET_PARAMS.seed);
      img = render(world, grid, 'biome', (c) => {
        const t = tint[c];
        if (t! <= 0) return null;
        const b = cellColor('biome', world, c, faces[grid.faceOf(c)]!);
        const k = t === 1 ? ALLIANCE_TINT : PACT_TINT;
        return [0.4 * b[0] + 0.6 * k[0], 0.4 * b[1] + 0.6 * k[1], 0.4 * b[2] + 0.6 * k[2]];
      });
      const canvas = new MapCanvas(img, SIZE);
      drawGraph(canvas, graph!, { sites: process.env.SITES === '1' });
      drawInfrastructure(canvas, infra!);
      const count = (side: string) => infra!.airbases.filter((x) => x.side === side).length;
      console.info(
        `${graph!.settlements.cells.length} settlements, ${graph!.roads.count} roads, ` +
          `${graph!.bridges.cells.length} bridges; airbases ${count('alliance')} / ${count('pact')}, ` +
          `${infra!.ports.length} ports, ${infra!.targets.length} targets`,
      );
      console.info(cast!.briefing);
    } else if (mode === 'barrier') {
      const m = world.maps;
      const barrier = barrierMap(
        strategicContext({
          grid,
          height: m.height,
          biome: m.biome,
          discharge: m.discharge,
          lakeDepth: m.lakeDepth,
          reliefScale: params.reliefScale,
          radius: params.radius,
        }),
      );
      img = render(world, grid, 'biome', (c) =>
        m.height[c]! > 0 ? barrierColor(barrier[c]!) : [0.15, 0.2, 0.3],
      );
    } else {
      img = render(world, grid, mode);
    }
    writeFileSync(file, encodePng(SIZE, SIZE, img));
    console.info(`wrote ${file}`);
  }
});
