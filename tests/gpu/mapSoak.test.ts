/**
 * The strategic map over a long session (R1.1, the frame rate that falls over a
 * session): cycles of the camera from the ceiling to the floor, game time moving
 * the air war on, new missions, and the world set again, while the renderer's
 * count of live geometries and textures must stay flat once warm.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../../src/core/cubeGrid';
import { HOUR, MINUTE } from '../../src/core/units';
import { Vec3d } from '../../src/core/vec3d';
import { buildFontAtlas, FONT_IDS } from '../../src/render/strategic/labels/fontAtlas';
import type { FontId } from '../../src/render/strategic/labels/fontAtlas';
import { LABEL_FONT_FILES } from '../../src/render/strategic/labels/fontFiles';
import { STRATEGIC_CEILING, STRATEGIC_FLOOR } from '../../src/render/strategic/strategicCamera';
import { StrategicScene } from '../../src/render/strategic/strategicScene';
import { campaignInput } from '../../src/sim/command/campaignInput';
import { createSimWorld } from '../../src/sim/world';
import { generateCampaignWorld } from '../../src/worldgen/campaignWorld';
import { finishWorld } from '../../src/worldgen/finishWorld';
import { buildGlobalWorld } from '../../src/worldgen/globalPipeline';
import { TileSynthesizer } from '../../src/worldgen/gpu/tileSynth';
import { generateWorld } from '../../src/worldgen/pipeline';
import { RiverIndex } from '../../src/worldgen/riverIndex';
import { DEFAULT_PLANET_PARAMS } from '../../src/worldgen/params';
import { syntheticConfig } from '../helpers/weatherWorld';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

describe.skipIf(!gpu)('the strategic map over a session', () => {
  it('keeps its count of geometries and textures flat', async () => {
    const w = generateCampaignWorld(
      { ...DEFAULT_PLANET_PARAMS, seed: 7 },
      { grid: new CubeGrid(64) },
    );
    const sim = createSimWorld({
      ...syntheticConfig(7),
      campaign: campaignInput(w.graph, w.campaign.cast, w.infrastructure),
    });
    const req = createRequire(import.meta.url);
    const fonts = Object.fromEntries(
      FONT_IDS.map((id) => {
        const b = readFileSync(req.resolve(LABEL_FONT_FILES[id]));
        return [id, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)];
      }),
    ) as Record<FontId, ArrayBuffer>;
    const head = await headlessRenderer(gpu!.device, 256, 144);
    const scene = new StrategicScene(head.renderer, {
      radius: DEFAULT_PLANET_PARAMS.radius,
      grid: new CubeGrid(64),
      input: false,
    });
    scene.resize(head.width, head.height);
    scene.setLabelFonts(buildFontAtlas(fonts));
    scene.setWorld(w.world);
    scene.setStrategic(w.graph, w.campaign.cast, w.infrastructure);
    const main = new Vec3d(...w.world.info.mainContinent);
    const o = scene.orbit;
    o.lat = Math.asin(main.y);
    o.lon = Math.atan2(main.x, main.z);

    const memory = () => ({ ...head.renderer.info.memory });
    const counts: { geometries: number; textures: number }[] = [];
    let t = 2 * HOUR;
    for (let cycle = 0; cycle < 20; cycle++) {
      // Every fifth cycle the world comes again, as after a new world or a reload.
      if (cycle % 5 === 4) {
        scene.setWorld(w.world);
        scene.setStrategic(w.graph, w.campaign.cast, w.infrastructure);
      }
      sim.sim.advanceTo(t);
      scene.setMissions(sim.air!.liveMissions());
      for (const altitude of [STRATEGIC_CEILING, 1_500_000, 600_000, 250_000, STRATEGIC_FLOOR]) {
        o.altitude = o.targetAltitude = altitude;
        o.move(altitude * 0.05, altitude * 0.02);
        scene.setAirTime(t);
        scene.render(1 / 60);
        scene.render(1); // still: the labels settle
        t += MINUTE;
      }
      await gpu!.finish();
      counts.push(memory());
      t += 10 * MINUTE;
    }
    expect(gpu!.errors).toEqual([]);
    console.log(
      `map soak, live objects per cycle: ${counts.map((c) => `${c.geometries}/${c.textures}`).join(' ')}`,
    );
    // Warm after the first world reload; from then on nothing accumulates.
    const warm = counts[5]!;
    const last = counts[counts.length - 1]!;
    expect(last.geometries).toBeLessThanOrEqual(warm.geometries + 2);
    expect(last.textures).toBeLessThanOrEqual(warm.textures);
    scene.dispose();
    head.dispose();
  }, 600_000);

  it('keeps the relief tiles within their caches while panning at the floor', async () => {
    const params = { ...DEFAULT_PLANET_PARAMS, erosionStrength: 0.2 };
    const world = generateWorld(params, { resolution: 64 });
    const g = await buildGlobalWorld(gpu!, params, world, {
      n: 256,
      finish: async (input) => finishWorld(input),
    });
    const head = await headlessRenderer(gpu!.device, 256, 144);
    const scene = new StrategicScene(head.renderer, {
      radius: params.radius,
      grid: new CubeGrid(64),
      input: false,
    });
    scene.resize(head.width, head.height);
    scene.setWorld(world);
    const synth = new TileSynthesizer(g.grid, {
      seed: params.seed,
      reliefScale: params.reliefScale,
      radius: params.radius,
      biome: g.finish.biome,
      lakeDepth: g.finish.drainage.lakeDepth,
      height: g.height,
      forest: g.finish.forest,
      treeline: g.finish.treeline,
      index: new RiverIndex(g.finish.rivers),
    });
    scene.setTerrainWorld({
      synth,
      seed: params.seed,
      radius: params.radius,
      reliefScale: params.reliefScale,
      biome: g.finish.biome,
      biomeResolution: g.n,
      height: g.height,
      rivers: new RiverIndex(g.finish.rivers),
    });
    scene.relief.buildBudgetMs = 10_000;
    const main = new Vec3d(...world.info.mainContinent);
    const o = scene.orbit;
    o.lat = Math.asin(main.y);
    o.lon = Math.atan2(main.x, main.z);
    const counts: { geometries: number; textures: number }[] = [];
    for (let cycle = 0; cycle < 16; cycle++) {
      // A floor-to-theater bounce and a long pan: new tiles every cycle.
      for (const altitude of [STRATEGIC_FLOOR, 400_000, STRATEGIC_FLOOR]) {
        o.altitude = o.targetAltitude = altitude;
        for (let f = 0; f < 6; f++) {
          o.move(150_000, 40_000);
          scene.render(1 / 60);
          await gpu!.finish();
          await new Promise((r) => setTimeout(r, 1));
        }
      }
      counts.push({ ...head.renderer.info.memory });
    }
    expect(gpu!.errors).toEqual([]);
    console.log(
      `map soak with tiles, live objects per cycle: ${counts.map((c) => `${c.geometries}/${c.textures}`).join(' ')}`,
    );
    // The caches fill, then evict: the second half never passes the first half's peak.
    const half = counts.length / 2;
    const peak = (xs: typeof counts, k: 'geometries' | 'textures') =>
      Math.max(...xs.map((c) => c[k]));
    for (const k of ['geometries', 'textures'] as const) {
      expect(peak(counts.slice(half), k), k).toBeLessThanOrEqual(peak(counts.slice(0, half), k));
    }
    scene.dispose();
    synth.dispose();
    g.grid.dispose();
    head.dispose();
  }, 900_000);
});
