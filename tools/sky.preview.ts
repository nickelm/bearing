/**
 * Contact sheets of the sky alone (decision 140): the simulation view's sky
 * node under the app's post-processing pipeline, without a world, so a tile
 * takes a second where a view of `tools/render.preview.ts` takes a minute.
 * For judging the sky's gradients, twilight, the sun, the moon and the stars;
 * terrain, water and clouds need the full preview.
 *
 *   npx vitest run --disable-console-intercept --config vitest.tools.config.ts tools/sky.preview.ts
 *   env: OUT (tools/out), ALT camera height above sea level in m (30),
 *        ELEVATIONS sun elevations in degrees for the twilight sheet,
 *        PITCH degrees above the horizon (10), FOV vertical degrees (50),
 *        POST=0 draws without the pipeline, LAT camera latitude in degrees (40),
 *        OZONE multiplies the ozone absorption (1), VIBRANCE sets the sky's saturation
 *        around sunset (PlanetLighting.sunsetVibrance; 1 = as computed),
 *        PERF=n times n rounds of the LUT sky against the march, interleaved
 *
 * Writes `sky-day.png` (rows: sun elevations; columns: toward the sun, 90°
 * to its side, away from it) and `sky-night.png` (the moon at four phases,
 * then the stars under a new moon looking up, toward the horizon, and at the
 * galaxy's band, and dusk; then the moon and the setting sun close up). Below
 * the horizon the tiles show the air in front of a black ground.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { AgXToneMapping, PerspectiveCamera, Scene } from 'three/webgpu';
import { EARTH_ORBIT } from '../src/core/calendar';
import { celestialRotation, moonIlluminatedFraction } from '../src/core/moon';
import { DEG, PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { PlanetLighting } from '../src/render/sim/lighting/planetLighting';
import { SimPipeline } from '../src/render/sim/post/simPipeline';
import { testGpu } from '../tests/gpu/device';
import { headlessRenderer } from '../tests/gpu/renderer';
import { encodePng } from './png';

const TILE_W = 320;
const TILE_H = 192;

it('renders sky contact sheets', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No WebGPU adapter (Dawn) available');
  const outDir = process.env.OUT ?? join(import.meta.dirname, 'out');
  mkdirSync(outDir, { recursive: true });
  const altitude = Number(process.env.ALT ?? 30);
  const pitch = Number(process.env.PITCH ?? 10) * DEG;
  const latitude = Number(process.env.LAT ?? 40) * DEG;
  const elevations = (process.env.ELEVATIONS ?? '60,20,8,3,0,-2,-4,-6,-9,-12,-18')
    .split(',')
    .map(Number);

  const head = await headlessRenderer(gpu.device, TILE_W, TILE_H);
  head.renderer.toneMapping = AgXToneMapping;
  const lighting = new PlanetLighting();
  if (process.env.OZONE) {
    const air = lighting.atmosphere;
    air.params.ozoneAbsorption = air.params.ozoneAbsorption.map(
      (x) => x * Number(process.env.OZONE),
    ) as [number, number, number];
    air.rebuild();
  }
  if (process.env.VIBRANCE) lighting.sunsetVibrance = Number(process.env.VIBRANCE);
  const sky = lighting.atmosphere.sky;
  const scene = new Scene();
  scene.backgroundNode = lighting.atmosphere.skyNode();
  const camera = new PerspectiveCamera(Number(process.env.FOV ?? 50), TILE_W / TILE_H, 0.1, 10);
  const pipeline = process.env.POST === '0' ? null : new SimPipeline(head.renderer);

  // The camera stands at a latitude on the prime meridian; east, north and up there.
  const up = new Vec3d(0, Math.sin(latitude), Math.cos(latitude));
  const east = new Vec3d(1, 0, 0);
  const north = up.clone().cross(east);
  const eye = up.clone().scale(PLANET_RADIUS + altitude);
  /** A direction at an elevation and a compass azimuth (rad). */
  const toward = (elevation: number, azimuth: number) =>
    new Vec3d()
      .addScaled(up, Math.sin(elevation))
      .addScaled(north, Math.cos(elevation) * Math.cos(azimuth))
      .addScaled(east, Math.cos(elevation) * Math.sin(azimuth));

  interface Tile {
    sun: Vec3d;
    moon: Vec3d;
    /** Where the camera looks: elevation and azimuth (rad). */
    look: [number, number];
    /** Rotation of the celestial sphere (rad). */
    rotation?: number;
    morning?: boolean;
    /** Vertical field of view in degrees, instead of FOV. */
    fov?: number;
  }
  const draw = async (tile: Tile): Promise<Uint8Array> => {
    const forward = toward(tile.look[0], tile.look[1]);
    const top = up.clone().addScaled(forward, -forward.dot(up)).normalize();
    camera.fov = tile.fov ?? Number(process.env.FOV ?? 50);
    camera.updateProjectionMatrix();
    camera.position.set(0, 0, 0);
    camera.up.set(top.x, top.y, top.z);
    camera.lookAt(forward.x, forward.y, forward.z);
    camera.updateMatrixWorld();
    lighting.update(eye, tile.sun, tile.moon);
    sky.setCelestial(
      lighting.sunElevation,
      lighting.night,
      moonIlluminatedFraction(tile.sun, tile.moon),
      tile.rotation ?? celestialRotation(0, EARTH_ORBIT, { startDay: 226, startTimeOfDay: 0 }),
      7.3,
    );
    lighting.atmosphere.bakeSky(head.renderer);
    if (pipeline) {
      pipeline.sunElevation.value = lighting.sunElevation;
      pipeline.morning.value = tile.morning ? 1 : -1;
      pipeline.render(scene, camera);
    } else {
      head.renderer.render(scene, camera);
    }
    await gpu.finish();
    return head.readRgb();
  };

  const sheet = async (name: string, rows: Tile[][]) => {
    const columns = Math.max(...rows.map((r) => r.length));
    const w = columns * TILE_W;
    const h = rows.length * TILE_H;
    const rgb = new Uint8Array(w * h * 3);
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r]!.length; c++) {
        const tile = await draw(rows[r]![c]!);
        for (let y = 0; y < TILE_H; y++) {
          rgb.set(
            tile.subarray(y * TILE_W * 3, (y + 1) * TILE_W * 3),
            ((r * TILE_H + y) * w + c * TILE_W) * 3,
          );
        }
      }
    }
    const file = join(outDir, `${name}.png`);
    writeFileSync(file, encodePng(w, h, rgb));
    console.log(`${name}: ${columns} × ${rows.length} tiles → ${file}`);
  };

  // The sun sets in the west; the moon stays out of the day sheet.
  const west = -Math.PI / 2;
  const hidden = toward(-70 * DEG, 0);
  await sheet(
    'sky-day',
    elevations.map((e) => {
      const sun = toward(e * DEG, west);
      return [0, Math.PI / 2, Math.PI].map((turn): Tile => ({
        sun,
        moon: hidden,
        look: [pitch, west + turn],
      }));
    }),
  );

  // Night: the sun 40° down in the north-west.
  const nightSun = toward(-40 * DEG, west + 0.6);
  const moonAt = toward(16 * DEG, 2.4);
  /** A moon at `moonAt` as lit by a sun `elongation` degrees from it, below the horizon. */
  const phase = (elongation: number): Tile => {
    // Turn the direction to the moon about the vertical until the angle is the elongation.
    let sun = nightSun;
    for (let k = 0; k < 720; k++) {
      const candidate = toward(-38 * DEG, 2.4 + (k * Math.PI) / 360);
      if (
        Math.abs(Math.acos(candidate.dot(moonAt)) - elongation * DEG) <
        Math.abs(Math.acos(sun.dot(moonAt)) - elongation * DEG)
      ) {
        sun = candidate;
      }
    }
    return { sun, moon: moonAt, look: [pitch + 6 * DEG, 2.4] };
  };
  await sheet('sky-night', [
    [phase(176), phase(125), phase(90), phase(58)],
    [
      { sun: nightSun, moon: hidden, look: [70 * DEG, 1] },
      { sun: nightSun, moon: hidden, look: [pitch, 1.9] },
      { sun: nightSun, moon: hidden, look: [35 * DEG, 0.6], rotation: 2.2 },
      { sun: toward(-9 * DEG, west), moon: hidden, look: [pitch + 8 * DEG, west + 0.5] },
    ],
    // Close up (a 5° view): the moon at three phases, and the sun on the horizon.
    [
      { ...phase(176), look: [16 * DEG, 2.4], fov: 5 },
      { ...phase(110), look: [16 * DEG, 2.4], fov: 5 },
      { ...phase(50), look: [16 * DEG, 2.4], fov: 5 },
      { sun: toward(0.5 * DEG, west), moon: hidden, look: [0.9 * DEG, west], fov: 5 },
    ],
  ]);

  // PERF=n: the sky by its LUT against the march it replaced, n rounds, interleaved.
  const rounds = Number(process.env.PERF ?? 0);
  if (rounds > 0) {
    const tile: Tile = { sun: toward(25 * DEG, west), moon: hidden, look: [pitch, west + 0.8] };
    const times: Record<string, number[]> = { lut: [], march: [], bake: [] };
    for (let round = -1; round < rounds; round++) {
      for (const mode of ['lut', 'march', 'bake'] as const) {
        await draw(tile);
        sky.marchBlend.value = mode === 'march' ? 1 : 0;
        const t0 = performance.now();
        if (mode === 'bake') {
          // A bake alone: nudge the sun so the LUT is stale.
          tile.sun = toward((25 + 0.01 * (round + 2)) * DEG, west);
          lighting.update(eye, tile.sun, tile.moon);
          lighting.atmosphere.bakeSky(head.renderer);
        } else if (pipeline) pipeline.render(scene, camera);
        else head.renderer.render(scene, camera);
        await gpu.finish();
        if (round >= 0) times[mode]!.push(performance.now() - t0);
      }
    }
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;
    console.log(
      `sky ${TILE_W} × ${TILE_H}: LUT ${median(times.lut!).toFixed(2)} ms/frame, march ${median(times.march!).toFixed(2)} ms/frame, one bake ${median(times.bake!).toFixed(2)} ms (medians of ${rounds})`,
    );
  }
  head.dispose();
}, 600_000);
