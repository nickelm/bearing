/**
 * The simulation view's post-processing pipeline on Dawn (post/simPipeline.ts):
 * a wall in front of a sky, drawn directly and through the pipeline. Checks
 * that the bare pipeline reproduces the direct path, that the test fog
 * changes the image where it should without a halo at the silhouette, that
 * the overlay hides behind geometry, that bloom spreads only very bright
 * pixels, and that all of it also runs with MSAA.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AgXToneMapping,
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
  NoToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { float, floor, screenCoordinate, select, uniform, vec3, vec4, wgslFn } from 'three/tsl';
import { marchOffset } from '../../src/render/sim/clouds/volumetrics';
import { heightFogTestSource } from '../../src/render/sim/post/heightFog';
import { CubeGrid } from '../../src/core/cubeGrid';
import { DEG } from '../../src/core/units';
import { gradeAt } from '../../src/render/sim/post/grade';
import { GlobeScene } from '../../src/render/sim/globeScene';
import { overlayAdditive, SimPipeline } from '../../src/render/sim/post/simPipeline';
import type { VolumetricSource } from '../../src/render/sim/post/simPipeline';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';
import type { HeadlessRenderer } from './renderer';

const gpu = await testGpu();

const W = 128;
const H = 64;
const RADIUS = 1_000_000;

/** A red wall 100 m ahead over the left half of the view, in front of a dark blue sky. */
function wallScene(): { scene: Scene; camera: PerspectiveCamera } {
  const scene = new Scene();
  scene.backgroundNode = vec3(0.02, 0.05, 0.2);
  const material = new MeshBasicNodeMaterial({ side: DoubleSide });
  material.colorNode = vec3(0.5, 0.1, 0.1);
  const wall = new Mesh(new PlaneGeometry(1000, 1000), material);
  wall.position.set(-500, 0, -100);
  scene.add(wall);
  // The app's planes: a meter to hundreds of kilometers.
  const camera = new PerspectiveCamera(45, W / H, 1, 500_000);
  camera.updateProjectionMatrix();
  return { scene, camera };
}

const pixel = (rgb: Uint8Array, x: number, y: number) =>
  [rgb[(y * W + x) * 3]!, rgb[(y * W + x) * 3 + 1]!, rgb[(y * W + x) * 3 + 2]!] as const;

const distance = (a: readonly number[], b: readonly number[]) =>
  Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));

/** A pipeline with only the stages a test turns on. */
function barePipeline(head: HeadlessRenderer): SimPipeline {
  const pipeline = new SimPipeline(head.renderer);
  pipeline.bloom = pipeline.grading = pipeline.grain = pipeline.dither = false;
  pipeline.animateNoise = false;
  return pipeline;
}

/**
 * Draws a frame and checks the pipeline's pass count against the render calls the renderer
 * really made (a hidden intermediate target and output pass would show here).
 */
function drawCounted(
  pipeline: SimPipeline,
  head: HeadlessRenderer,
  scene: Scene,
  camera: PerspectiveCamera,
): void {
  const before = head.renderer.info.render.calls;
  pipeline.render(scene, camera);
  expect(head.renderer.info.render.calls - before).toBe(pipeline.stats.passes);
}

describe.skipIf(!gpu)('SimPipeline on Dawn', () => {
  it('reproduces the direct path when every stage is off', async () => {
    const head = await headlessRenderer(gpu!.device, W, H);
    head.renderer.toneMapping = AgXToneMapping;
    head.renderer.toneMappingExposure = 1.3;
    const { scene, camera } = wallScene();
    head.renderer.render(scene, camera);
    await gpu!.finish();
    const direct = await head.readRgb();

    const pipeline = barePipeline(head);
    drawCounted(pipeline, head, scene, camera);
    await gpu!.finish();
    const piped = await head.readRgb();
    expect(gpu!.errors).toEqual([]);
    expect(pipeline.stats).toEqual({ passes: 2, fullResolutionPasses: 2, targets: 1 });
    // The renderer is left as it was found.
    expect(head.renderer.toneMapping).toBe(AgXToneMapping);
    let worst = 0;
    for (let i = 0; i < direct.length; i++)
      worst = Math.max(worst, Math.abs(direct[i]! - piped[i]!));
    expect(worst).toBeLessThanOrEqual(1);
    expect(pixel(piped, 20, 32)[0]).toBeGreaterThan(pixel(piped, 100, 32)[0]);

    // Released (a view that is not drawn for a while), the targets come back on the next frame.
    pipeline.release();
    pipeline.render(scene, camera);
    await gpu!.finish();
    expect(gpu!.errors).toEqual([]);
    expect(distance(pixel(await head.readRgb(), 20, 32), pixel(piped, 20, 32))).toBeLessThanOrEqual(
      1,
    );

    // A smaller drawing buffer: the targets follow without GPU errors.
    head.renderer.setPixelRatio(0.5);
    pipeline.render(scene, camera);
    head.renderer.setPixelRatio(1);
    pipeline.render(scene, camera);
    await gpu!.finish();
    expect(gpu!.errors).toEqual([]);
    expect(distance(pixel(await head.readRgb(), 20, 32), pixel(piped, 20, 32))).toBeLessThanOrEqual(
      1,
    );

    pipeline.dispose();
    head.dispose();
  }, 120_000);

  for (const samples of [0, 4]) {
    it(`fogs the sky more than the wall, without a halo (${samples} samples)`, async () => {
      const head = await headlessRenderer(gpu!.device, W, H, samples);
      const { scene, camera } = wallScene();
      const pipeline = barePipeline(head);
      pipeline.render(scene, camera);
      await gpu!.finish();
      const clear = await head.readRgb();

      // Thick fog: the wall at 100 m keeps about half its color, the sky none.
      pipeline.volumetrics = heightFogTestSource({
        eye: uniform(new Vector3(0, RADIUS + 50, 0)),
        radius: RADIUS,
        density: 7e-3,
        scaleHeight: 5000,
        color: [0.6, 0.6, 0.6],
      });
      for (const scale of [1 / 3, 1 / 2, 1 / 4, 1]) {
        pipeline.volumetricScale = scale;
        drawCounted(pipeline, head, scene, camera);
        await gpu!.finish();
        const fog = await head.readRgb();
        expect(gpu!.errors).toEqual([]);
        expect(pipeline.stats).toEqual({ passes: 5, fullResolutionPasses: 2, targets: 4 });

        const wall = pixel(fog, 20, 32);
        const sky = pixel(fog, 108, 32);
        // Sky: the fog's gray. Wall: between its own red and the gray.
        expect(distance(sky, [203, 203, 203])).toBeLessThanOrEqual(3);
        expect(wall[0]).toBeGreaterThan(wall[1] + 20);
        expect(wall[1]).toBeGreaterThan(pixel(clear, 20, 32)[1] + 40);
        expect(distance(pixel(clear, 108, 32), sky)).toBeGreaterThan(100);
        // Every pixel of a row is the wall's color or the sky's (or, with MSAA, the one
        // resolved pixel between them): the low-resolution fog does not bleed across.
        for (const y of [3, 17, 32, 46, 61]) {
          let between = 0;
          for (let x = 0; x < W; x++) {
            const p = pixel(fog, x, y);
            if (distance(p, wall) > 6 && distance(p, sky) > 6) between++;
          }
          expect(between).toBeLessThanOrEqual(samples > 0 ? 1 : 0);
        }
        for (const v of fog) expect(Number.isFinite(v)).toBe(true);
      }

      // The march's jitter moves from frame to frame; the filter keeps it off the screen.
      pipeline.animateNoise = true;
      pipeline.render(scene, camera);
      await gpu!.finish();
      const first = await head.readRgb();
      pipeline.render(scene, camera);
      await gpu!.finish();
      const second = await head.readRgb();
      let flicker = 0;
      for (let i = 0; i < first.length; i++) {
        flicker = Math.max(flicker, Math.abs(first[i]! - second[i]!));
      }
      expect(flicker).toBeLessThanOrEqual(3);
      pipeline.animateNoise = false;

      // Disabled, the stage leaves the frame and the image is the clear one again.
      pipeline.volumetricsEnabled = false;
      pipeline.render(scene, camera);
      await gpu!.finish();
      expect(pipeline.stats.passes).toBe(2);
      const off = await head.readRgb();
      expect(distance(pixel(off, 108, 32), pixel(clear, 108, 32))).toBeLessThanOrEqual(1);

      // A source that cannot be built is dropped with a warning; the frame is drawn without it.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      pipeline.volumetricsEnabled = true;
      pipeline.volumetrics = {
        build: () => {
          throw new Error('broken source');
        },
      };
      pipeline.render(scene, camera);
      await gpu!.finish();
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
      expect(pipeline.volumetrics).toBeNull();
      expect(pipeline.stats.passes).toBe(2);
      expect(gpu!.errors).toEqual([]);
      const dropped = await head.readRgb();
      expect(distance(pixel(dropped, 108, 32), pixel(clear, 108, 32))).toBeLessThanOrEqual(1);

      pipeline.dispose();
      head.dispose();
    }, 120_000);
  }

  for (const samples of [0, 4]) {
    it(`gives sources and overlay materials the ray and the distance of each pixel (${samples} samples)`, async () => {
      const head = await headlessRenderer(gpu!.device, W, H, samples);
      const { scene, camera } = wallScene();
      const pipeline = barePipeline(head);
      const encode = (c: number) =>
        Math.round(
          255 *
            Math.min(
              1,
              c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055,
            ),
        );
      // The camera looks down −Z from the origin with +Y up: the ray through a pixel's center.
      const tanY = Math.tan((22.5 * Math.PI) / 180);
      const rayAt = (x: number, y: number) =>
        new Vector3(
          (((x + 0.5) / W) * 2 - 1) * tanY * (W / H),
          (1 - ((y + 0.5) / H) * 2) * tanY,
          -1,
        );
      const wallPixels: [number, number][] = [
        [20, 32],
        [5, 5],
        [40, 58],
      ];
      const skyPixels: [number, number][] = [
        [100, 8],
        [100, 56],
        [72, 32],
        [122, 30],
      ];

      // The unit ray as a color: left and right, up and down must not be mirrored.
      pipeline.volumetrics = { build: (ctx) => vec4(ctx.rayDirection.mul(0.5).add(0.5), 0) };
      for (const scale of [1, 1 / 3]) {
        pipeline.volumetricScale = scale;
        pipeline.render(scene, camera);
        await gpu!.finish();
        const rays = await head.readRgb();
        expect(gpu!.errors).toEqual([]);
        for (const [x, y] of [...wallPixels, ...skyPixels]) {
          const ray = rayAt(x, y).normalize();
          const expected = [ray.x, ray.y, ray.z].map((c) => encode(c * 0.5 + 0.5));
          expect(distance(pixel(rays, x, y), expected)).toBeLessThanOrEqual(scale === 1 ? 2 : 4);
        }
        // Up is up: the top of the frame looks above the horizon.
        expect(pixel(rays, 100, 8)[1]).toBeGreaterThan(pixel(rays, 100, 56)[1] + 40);
        expect(pixel(rays, 122, 30)[0]).toBeGreaterThan(pixel(rays, 72, 32)[0] + 20);
      }

      // The distance along the ray: 100 m of view depth to the wall, stretched off the axis;
      // the sky is at least 1e7 m away.
      const shade = (d: Node<'float'>) =>
        vec3(d.div(400).min(1), select(d.greaterThanEqual(1e7), float(1), float(0)), 0);
      pipeline.volumetrics = { build: (ctx) => vec4(shade(ctx.sceneDistance), 0) };
      for (const scale of [1, 1 / 3]) {
        pipeline.volumetricScale = scale;
        pipeline.render(scene, camera);
        await gpu!.finish();
        const depths = await head.readRgb();
        expect(gpu!.errors).toEqual([]);
        for (const [x, y] of wallPixels) {
          const expected = [encode((100 * rayAt(x, y).length()) / 400), 0, 0];
          expect(distance(pixel(depths, x, y), expected)).toBeLessThanOrEqual(2);
        }
        for (const [x, y] of skyPixels) {
          expect(distance(pixel(depths, x, y), [255, 255, 0])).toBeLessThanOrEqual(1);
        }
      }

      // The same distance through `sceneDistance`, read by an overlay material in front of everything.
      pipeline.volumetrics = null;
      const material = new MeshBasicNodeMaterial({ transparent: true, depthTest: false });
      material.colorNode = vec4(shade(pipeline.sceneDistance), 1);
      const sheet = new Mesh(new PlaneGeometry(2000, 2000), material);
      sheet.position.set(0, 0, -50);
      pipeline.overlay.add(sheet);
      pipeline.render(scene, camera);
      await gpu!.finish();
      const over = await head.readRgb();
      expect(gpu!.errors).toEqual([]);
      for (const [x, y] of wallPixels) {
        const expected = [encode((100 * rayAt(x, y).length()) / 400), 0, 0];
        expect(distance(pixel(over, x, y), expected)).toBeLessThanOrEqual(2);
      }
      for (const [x, y] of skyPixels) {
        expect(distance(pixel(over, x, y), [255, 255, 0])).toBeLessThanOrEqual(1);
      }
      pipeline.dispose();
      head.dispose();
    }, 120_000);
  }

  it('keeps antialiased silhouettes antialiased under the fog (4 samples)', async () => {
    const head = await headlessRenderer(gpu!.device, W, H, 4);
    const { scene, camera } = wallScene();
    // The wall's edge slanted across the pixel grid, so that pixels along it are partly covered.
    scene.children[0]!.rotation.z = 0.3;
    const pipeline = barePipeline(head);
    const linear = (byte: number) =>
      byte <= 10 ? byte / 255 / 12.92 : Math.pow((byte / 255 + 0.055) / 1.055, 2.4);
    const linearPixel = (rgb: Uint8Array, x: number, y: number) => pixel(rgb, x, y).map(linear);
    pipeline.render(scene, camera);
    await gpu!.finish();
    const clear = await head.readRgb();
    pipeline.volumetrics = heightFogTestSource({
      eye: uniform(new Vector3(0, RADIUS + 50, 0)),
      radius: RADIUS,
      density: 7e-3,
      scaleHeight: 5000,
      color: [0.6, 0.6, 0.6],
    });
    const wallColor = [0.5, 0.1, 0.1];
    const skyColor = [0.02, 0.05, 0.2];
    const close = (a: readonly number[], b: readonly number[]) =>
      a.every((v, i) => Math.abs(v - b[i]!) < 0.02);
    for (const scale of [1 / 3, 1 / 2, 1]) {
      pipeline.volumetricScale = scale;
      pipeline.render(scene, camera);
      await gpu!.finish();
      const fog = await head.readRgb();
      expect(gpu!.errors).toEqual([]);
      let edges = 0;
      let worst = 0;
      for (let y = 4; y < H - 4; y++) {
        for (let x = 8; x < W - 8; x++) {
          const c = linearPixel(clear, x, y);
          if (close(c, wallColor) || close(c, skyColor)) continue;
          // Pure wall to the left and pure sky to the right of this pixel of the edge.
          if (!close(linearPixel(clear, x - 4, y), wallColor)) continue;
          if (!close(linearPixel(clear, x + 4, y), skyColor)) continue;
          // The share of the pixel the wall covers, from the image without fog.
          const w = (c[0]! - skyColor[0]!) / (wallColor[0]! - skyColor[0]!);
          const wall = linearPixel(fog, x - 4, y);
          const sky = linearPixel(fog, x + 4, y);
          const actual = linearPixel(fog, x, y);
          for (let i = 0; i < 3; i++) {
            // What the pixel would be had each surface been fogged before the resolve.
            const exact = w * wall[i]! + (1 - w) * sky[i]!;
            worst = Math.max(worst, Math.abs(actual[i]! - exact));
          }
          edges++;
        }
      }
      expect(edges).toBeGreaterThan(40);
      // The resolved color takes one transmittance for both surfaces: at most a quarter of
      // their difference is left (0.054 here). One sample's depth leaves up to 0.22.
      expect(worst).toBeLessThan(0.075);
    }
    pipeline.dispose();
    head.dispose();
  }, 120_000);

  it('jitters the march per pixel and per frame, and filters the jitter out', async () => {
    const head = await headlessRenderer(gpu!.device, W, H);
    const { scene, camera } = wallScene();
    const pipeline = barePipeline(head);
    // The jitter itself as the image: any pattern left on screen shows directly.
    pipeline.volumetrics = { build: (ctx) => vec4(vec3(ctx.jitter), 0) };
    const linear = (byte: number) =>
      byte <= 10 ? byte / 255 / 12.92 : Math.pow((byte / 255 + 0.055) / 1.055, 2.4);
    /** The red channel over the sky, away from the wall and the frame's edge, as linear values. */
    const sky = async () => {
      pipeline.render(scene, camera);
      await gpu!.finish();
      const rgb = await head.readRgb();
      const values: number[] = [];
      for (let y = 6; y < H - 6; y++) {
        for (let x = 76; x < W - 6; x++) values.push(linear(pixel(rgb, x, y)[0]));
      }
      return values;
    };
    const stats = (v: number[]) => {
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
      return { mean, sd, min: Math.min(...v), max: Math.max(...v) };
    };

    // As marched, at full resolution: spread evenly over 0..1, and different on the next frame.
    pipeline.volumetricScale = 1;
    pipeline.volumetricFilter = false;
    pipeline.animateNoise = true;
    const raw = await sky();
    const rawStats = stats(raw);
    expect(Math.abs(rawStats.mean - 0.5)).toBeLessThan(0.03);
    expect(rawStats.sd).toBeGreaterThan(0.25);
    expect(rawStats.min).toBeLessThan(0.05);
    expect(rawStats.max).toBeGreaterThan(0.95);
    const next = await sky();
    let moved = 0;
    for (let i = 0; i < raw.length; i++) if (Math.abs(raw[i]! - next[i]!) > 0.05) moved++;
    expect(moved).toBeGreaterThan(raw.length * 0.7);
    // Frozen for stills, the pattern stays.
    pipeline.animateNoise = false;
    const still = await sky();
    const again = await sky();
    expect(again).toEqual(still);

    // Filtered, at each resolution: nearly flat, and steady from frame to frame.
    pipeline.volumetricFilter = true;
    pipeline.animateNoise = true;
    for (const scale of [1, 1 / 2, 1 / 3, 1 / 4]) {
      pipeline.volumetricScale = scale;
      const a = await sky();
      const b = await sky();
      const flat = stats(a);
      expect(Math.abs(flat.mean - 0.5)).toBeLessThan(0.02);
      // A tenth of the spread as marched (0.29).
      expect(flat.sd).toBeLessThan(0.045);
      expect(flat.min).toBeGreaterThan(0.38);
      expect(flat.max).toBeLessThan(0.62);
      expect(Math.max(...a.map((v, i) => Math.abs(v - b[i]!)))).toBeLessThan(0.11);
      expect(gpu!.errors).toEqual([]);
    }
    pipeline.dispose();
    head.dispose();
  }, 120_000);

  it('averages the sample pattern of a march out over receding ground and across the horizon', async () => {
    // The other half of the upsample's contract (the first is "without a halo" above): cloud
    // and fog in front of ground that recedes to the horizon must not show the march's
    // 3 × 3 sample pattern, although the ground's depth differs from texel to texel and the
    // sky's from the ground's. The march's offset itself is the image, as half-transparent
    // air in front of everything.
    const w = 384;
    const h = 192;
    const head = await headlessRenderer(gpu!.device, w, h);
    const scene = new Scene();
    scene.backgroundNode = vec3(0.02, 0.05, 0.2);
    const material = new MeshBasicNodeMaterial({ side: DoubleSide });
    material.colorNode = vec3(0.1, 0.3, 0.1);
    const ground = new Mesh(new PlaneGeometry(2, 2), material);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    // A narrow view: a low-resolution texel spans about a quarter of a degree, as in the app.
    const camera = new PerspectiveCamera(15, w / h, 1, 500_000);
    camera.updateProjectionMatrix();
    const pipeline = barePipeline(head);
    const linear = (byte: number) =>
      byte <= 10 ? byte / 255 / 12.92 : Math.pow((byte / 255 + 0.055) / 1.055, 2.4);
    const red = (rgb: Uint8Array, x: number, y: number) => linear(rgb[(y * w + x) * 3]!);
    const isGround = (rgb: Uint8Array, x: number, y: number) => red(rgb, x, y) > 0.05;
    const cases: {
      altitude: number;
      reach: number;
      roll: number;
      beside: number;
      rows?: number;
    }[] = [
      // From 10 km the ground's edge is hundreds of kilometers away: it and the sky above it
      // are one surface to the filter, in level flight and in a banked turn.
      { altitude: 10_000, reach: 300_000, roll: 0, beside: 0 },
      { altitude: 10_000, reach: 300_000, roll: 0.5, beside: 0 },
      // From 1,500 m the horizon is 55 km away and stays a silhouette, as a ridge does: the
      // texels next to it average the part of the pattern on their side (out of 5 × 5
      // there). `beside` is the most that may leave.
      { altitude: 1500, reach: 55_000, roll: 0, beside: 0.02 },
      { altitude: 1500, reach: 55_000, roll: 0.5, beside: 0.15 },
      // From 20 m (a tower, an aircraft on the runway) the ground's depth changes by a third
      // and more from one row of texels to the next under the horizon, and within each
      // block: the filter takes a block's own range of depths off the difference, and where
      // rows still stand apart a texel averages its own row. Two rows of texels keep an
      // eighth of the pattern in level flight; in a bank the rows cross the pattern at an
      // angle and a strip along the horizon keeps up to all of it (`rows`, `beside`).
      { altitude: 20, reach: 55_000, roll: 0, beside: 0.25, rows: 0.08 },
      { altitude: 20, reach: 55_000, roll: 0.5, beside: 0.45, rows: 0.2 },
    ];
    for (const view of cases) {
      ground.scale.setScalar(view.reach);
      ground.position.y = -view.altitude;
      camera.rotation.set(-4 * DEG, 0, view.roll, 'YXZ');
      pipeline.volumetrics = null;
      pipeline.render(scene, camera);
      await gpu!.finish();
      const clear = await head.readRgb();
      pipeline.volumetrics = {
        build: () => vec4(vec3(marchOffset(floor(screenCoordinate.xy) as Node<'vec2'>)), 0.5),
      };
      for (const scale of [1 / 3, 1 / 2, 1 / 4]) {
        pipeline.volumetricScale = scale;
        pipeline.render(scene, camera);
        await gpu!.finish();
        const air = await head.readRgb();
        expect(gpu!.errors).toEqual([]);
        // Every pixel is its surface behind the air's mean: the nine offsets average to 0.5.
        // (As marched they spread over ±0.44.)
        const margin = Math.round(2 / scale);
        let worst = 0;
        let worstBeside = 0;
        // Pixels that keep more than a ninth of the pattern.
        let over = 0;
        let groundPixels = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const on = isGround(clear, x, y);
            if (on) groundPixels++;
            const error = Math.abs(red(air, x, y) - (0.5 * red(clear, x, y) + 0.5));
            // Beside the silhouette: within two low-resolution texels of the other surface.
            let beside = false;
            if (view.beside > 0) {
              for (const [i, j] of [
                [-1, -1],
                [1, -1],
                [-1, 1],
                [1, 1],
              ] as const) {
                const xx = Math.min(w - 1, Math.max(0, x + i * margin));
                const yy = Math.min(h - 1, Math.max(0, y + j * margin));
                if (isGround(clear, xx, yy) !== on) beside = true;
              }
            }
            if (error > 0.05) over++;
            if (beside) worstBeside = Math.max(worstBeside, error);
            else worst = Math.max(worst, error);
          }
        }
        expect(groundPixels).toBeGreaterThan(w * h * 0.4);
        expect(groundPixels).toBeLessThan(w * h * 0.85);
        expect(worst).toBeLessThan(view.rows ?? 0.03);
        expect(worstBeside).toBeLessThanOrEqual(view.beside);
        // Whatever is left is left in few pixels.
        expect(over / (w * h)).toBeLessThan(0.03);
      }
    }
    // All but opaque air hides the silhouette behind it: the banked horizon of the last view
    // leaves nothing of the pattern, at the horizon either.
    pipeline.volumetrics = {
      build: () => vec4(vec3(marchOffset(floor(screenCoordinate.xy) as Node<'vec2'>)), 0.02),
    };
    for (const scale of [1 / 3, 1 / 2, 1 / 4]) {
      pipeline.volumetricScale = scale;
      pipeline.render(scene, camera);
      await gpu!.finish();
      const air = await head.readRgb();
      let worst = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) worst = Math.max(worst, Math.abs(red(air, x, y) - 0.5));
      }
      expect(worst).toBeLessThan(0.03);
    }
    pipeline.dispose();
    head.dispose();
  }, 120_000);

  it('draws the overlay over the sky and hides it behind the wall', async () => {
    const head = await headlessRenderer(gpu!.device, W, H);
    const { scene, camera } = wallScene();
    const pipeline = barePipeline(head);
    pipeline.render(scene, camera);
    await gpu!.finish();
    const clear = await head.readRgb();
    expect(pipeline.stats.passes).toBe(2);

    // A green sheet 150 m ahead across the whole view: behind the wall, in front of the sky.
    const material = new MeshBasicNodeMaterial({ transparent: true, depthTest: false });
    material.colorNode = vec4(
      vec3(0, 1, 0),
      select(pipeline.sceneDistance.greaterThan(150), float(0.5), float(0)),
    );
    const sheet = new Mesh(new PlaneGeometry(2000, 2000), material);
    sheet.position.set(0, 0, -150);
    pipeline.overlay.add(sheet);
    drawCounted(pipeline, head, scene, camera);
    await gpu!.finish();
    const over = await head.readRgb();
    expect(gpu!.errors).toEqual([]);
    expect(pipeline.stats).toEqual({ passes: 3, fullResolutionPasses: 2, targets: 2 });
    expect(distance(pixel(over, 20, 32), pixel(clear, 20, 32))).toBeLessThanOrEqual(1);
    const sky = pixel(over, 108, 32);
    expect(sky[1]).toBeGreaterThan(pixel(clear, 108, 32)[1] + 80);
    expect(sky[2]).toBeLessThan(pixel(clear, 108, 32)[2]);

    // An additive glow in front of the wall adds light and hides nothing.
    const glow = overlayAdditive(new MeshBasicNodeMaterial());
    glow.colorNode = vec4(0, 0, 0.5, 0.5);
    const flare = new Mesh(new PlaneGeometry(2000, 2000), glow);
    flare.position.set(0, 0, -50);
    pipeline.overlay.add(flare);
    pipeline.render(scene, camera);
    await gpu!.finish();
    const glowing = await head.readRgb();
    expect(gpu!.errors).toEqual([]);
    const lit = pixel(glowing, 20, 32);
    expect(Math.abs(lit[0] - pixel(over, 20, 32)[0])).toBeLessThanOrEqual(1);
    expect(lit[2]).toBeGreaterThan(pixel(over, 20, 32)[2] + 60);
    flare.visible = false;

    // Hidden, the overlay costs no pass.
    sheet.visible = false;
    pipeline.render(scene, camera);
    expect(pipeline.stats.passes).toBe(2);
    pipeline.dispose();
    head.dispose();
  }, 120_000);

  it('blooms a very bright spot and nothing else, grades and dithers', async () => {
    const head = await headlessRenderer(gpu!.device, W, H);
    head.renderer.toneMapping = AgXToneMapping;
    const { scene, camera } = wallScene();
    const pipeline = barePipeline(head);
    const draw = async (bloom: boolean) => {
      pipeline.bloom = bloom;
      drawCounted(pipeline, head, scene, camera);
      await gpu!.finish();
      return head.readRgb();
    };
    // Nothing in the scene is above the threshold: bloom changes nothing.
    const dull = await draw(false);
    const dullBloomed = await draw(true);
    let worstDull = 0;
    for (let i = 0; i < dull.length; i++) {
      worstDull = Math.max(worstDull, Math.abs(dull[i]! - dullBloomed[i]!));
    }
    expect(worstDull).toBeLessThanOrEqual(1);

    // A lamp far brighter than white, two pixels across, over the sky.
    const lamp = new MeshBasicNodeMaterial();
    lamp.colorNode = vec3(60, 50, 30);
    const spot = new Mesh(new PlaneGeometry(2.6, 2.6), lamp);
    spot.position.set(40, 0, -100);
    scene.add(spot);
    const plain = await draw(false);
    const bloomed = await draw(true);
    expect(gpu!.errors).toEqual([]);
    expect(pipeline.stats).toEqual({ passes: 7, fullResolutionPasses: 2, targets: 4 });
    const lampX = Math.round(W / 2 + (40 / 100 / Math.tan((22.5 * Math.PI) / 180)) * (H / 2));
    const red = (rgb: Uint8Array, x: number) => pixel(rgb, x, 32)[0];
    // A glow beside the lamp that falls off with the distance; the coarser levels carry
    // it beyond the prefilter's reach of eight pixels.
    expect(red(bloomed, lampX + 5)).toBeGreaterThan(red(plain, lampX + 5) + 8);
    expect(red(bloomed, lampX + 14)).toBeGreaterThan(red(plain, lampX + 14) + 1);
    expect(red(bloomed, lampX + 5) - red(plain, lampX + 5)).toBeGreaterThan(
      red(bloomed, lampX + 14) - red(plain, lampX + 14),
    );
    expect(distance(pixel(bloomed, 4, 32), pixel(plain, 4, 32))).toBeLessThanOrEqual(3);

    // The grade at night turns the image bluer; grain and dither change pixels by a few steps.
    pipeline.bloom = false;
    pipeline.grading = true;
    pipeline.sunElevation.value = -0.5;
    pipeline.render(scene, camera);
    await gpu!.finish();
    const night = await head.readRgb();
    const ratio = (p: readonly number[]) => p[2]! / Math.max(1, p[0]!);
    expect(ratio(pixel(night, 20, 32))).toBeGreaterThan(ratio(pixel(plain, 20, 32)));

    // The grade's arithmetic on the wall's color, without a tone curve: gain and saturation on
    // the linear color, gamma and lift on the encoded one.
    head.renderer.toneMapping = NoToneMapping;
    pipeline.sunElevation.value = 4 * DEG;
    pipeline.morning.value = 0;
    pipeline.render(scene, camera);
    await gpu!.finish();
    const golden = pixel(await head.readRgb(), 20, 32);
    const band = gradeAt(4 * DEG, 0);
    const tinted = [0.5, 0.1, 0.1].map((c, i) => c * band.gain[i]!);
    const gray = 0.2126 * tinted[0]! + 0.7152 * tinted[1]! + 0.0722 * tinted[2]!;
    const expected = tinted.map((c, i) => {
      const saturated = Math.max(0, gray + (c - gray) * band.saturation);
      const encoded =
        saturated <= 0.0031308 ? 12.92 * saturated : 1.055 * saturated ** (1 / 2.4) - 0.055;
      const curved = encoded ** band.gamma;
      return Math.round(255 * (curved + band.lift[i]! * (1 - curved)));
    });
    expect(distance(golden, expected)).toBeLessThanOrEqual(1);
    head.renderer.toneMapping = AgXToneMapping;
    pipeline.sunElevation.value = -0.5;

    pipeline.grain = pipeline.dither = true;
    pipeline.render(scene, camera);
    await gpu!.finish();
    const grainy = await head.readRgb();
    expect(gpu!.errors).toEqual([]);
    let changed = 0;
    let worst = 0;
    for (let i = 0; i < night.length; i++) {
      const d = Math.abs(night[i]! - grainy[i]!);
      if (d > 0) changed++;
      worst = Math.max(worst, d);
    }
    expect(changed).toBeGreaterThan(night.length / 10);
    expect(worst).toBeLessThanOrEqual(4);

    pipeline.dispose();
    head.dispose();
  }, 120_000);

  // Error scopes crash Dawn's Node bindings on Windows once a buffer has been mapped (CLAUDE.md).
  describe.skipIf(process.platform === 'win32')('guard', () => {
    /** A source whose shader does not compile. */
    const broken = { build: () => wgslFn('fn broken() -> vec4<f32> { return nothing; }')() };
    const settle = async () => {
      await gpu!.finish();
      await new Promise((r) => setTimeout(r, 20));
    };

    it('throws on the frame after a pass raised a GPU validation error', async () => {
      const head = await headlessRenderer(gpu!.device, W, H);
      const { scene, camera } = wallScene();
      const pipeline = new SimPipeline(head.renderer, { guard: true });
      // A healthy pipeline passes the guard.
      for (let f = 0; f < 5; f++) {
        pipeline.render(scene, camera);
        await settle();
      }
      expect(gpu!.errors).toEqual([]);

      pipeline.volumetrics = broken as unknown as VolumetricSource;
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      pipeline.render(scene, camera);
      await settle();
      expect(() => pipeline.render(scene, camera)).toThrow(/Post-processing/);
      error.mockRestore();
      gpu!.errors.length = 0;
      pipeline.dispose();
      head.dispose();
    }, 120_000);

    it('makes the scene fall back to drawing directly, with one warning', async () => {
      const head = await headlessRenderer(gpu!.device, W, H);
      const scene = new GlobeScene(head.renderer, {
        radius: RADIUS,
        grid: new CubeGrid(8),
        input: false,
      });
      scene.resize(W, H);
      scene.orbit.altitude = scene.orbit.targetAltitude = 3 * RADIUS;
      scene.render(0);
      await settle();
      expect(gpu!.errors).toEqual([]);
      expect(scene.pipeline).not.toBeNull();
      const piped = await head.readRgb();

      // Off, the frame is drawn directly; the grade, grain and bloom aside, it is the same image.
      scene.postEnabled = false;
      scene.render(0);
      await settle();
      const direct = await head.readRgb();
      let lit = 0;
      let far = 0;
      for (let i = 0; i < direct.length; i++) {
        if (direct[i]! > 40) lit++;
        if (Math.abs(direct[i]! - piped[i]!) > 40) far++;
      }
      expect(lit).toBeGreaterThan(direct.length / 50);
      expect(far).toBeLessThan(direct.length / 100);
      scene.postEnabled = true;

      scene.pipeline!.dispose();
      scene.pipeline = new SimPipeline(head.renderer, { guard: true });
      scene.pipeline.volumetrics = broken as unknown as VolumetricSource;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      for (let f = 0; f < 4; f++) {
        scene.render(0);
        await settle();
      }
      expect(scene.pipeline).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
      error.mockRestore();
      // The direct path draws the same frame as before.
      gpu!.errors.length = 0;
      scene.render(0);
      await settle();
      expect(gpu!.errors).toEqual([]);
      const after = await head.readRgb();
      let worst = 0;
      for (let i = 0; i < direct.length; i++)
        worst = Math.max(worst, Math.abs(direct[i]! - after[i]!));
      expect(worst).toBeLessThanOrEqual(1);
      scene.dispose();
      head.dispose();
    }, 120_000);
  });
});
