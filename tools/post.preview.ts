/**
 * Times the stages of the simulation view's post-processing pipeline
 * (src/render/sim/post/) on a scene that costs almost nothing to draw, so the
 * pipeline's own passes are what is measured. `tools/render.preview.ts`
 * (`PERF_POST=n`) times it on the real scene, where the scene pass dominates.
 *
 *   npx vitest run --disable-console-intercept --config vitest.tools.config.ts tools/post.preview.ts
 *   env: W × H (640 × 360), ROUNDS (40), SAMPLES MSAA samples (0),
 *        SCALE the volumetric pass's divisor: 2, 3 or 4 (3)
 *
 * Every round draws each configuration once, in turn, so other load on the
 * machine falls on all of them alike; the medians are printed, with each
 * configuration's cost over the direct path. On a software adapter only the
 * ratios mean anything.
 */
import { it } from 'vitest';
import {
  AgXToneMapping,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
} from 'three/webgpu';
import { float, select, uniform, vec3, vec4 } from 'three/tsl';
import { heightFogTestSource } from '../src/render/sim/post/heightFog';
import { SimPipeline } from '../src/render/sim/post/simPipeline';
import { testGpu } from '../tests/gpu/device';
import { headlessRenderer } from '../tests/gpu/renderer';

it('times the post-processing pipeline', async () => {
  const gpu = await testGpu();
  if (!gpu) return;
  const width = Number(process.env.W ?? 640);
  const height = Number(process.env.H ?? 360);
  const rounds = Number(process.env.ROUNDS ?? 40);
  const head = await headlessRenderer(gpu.device, width, height, Number(process.env.SAMPLES ?? 0));
  const renderer = head.renderer;
  renderer.toneMapping = AgXToneMapping;

  // A ground plane to the horizon, a wall, a lamp, under a sky gradient.
  const scene = new Scene();
  scene.backgroundNode = vec3(0.2, 0.35, 0.7);
  const ground = new MeshBasicNodeMaterial();
  ground.colorNode = vec3(0.25, 0.3, 0.12);
  const plane = new Mesh(new PlaneGeometry(400_000, 400_000), ground);
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -30;
  const wallMaterial = new MeshBasicNodeMaterial();
  wallMaterial.colorNode = vec3(0.5, 0.1, 0.1);
  const wall = new Mesh(new PlaneGeometry(200, 120), wallMaterial);
  wall.position.set(-150, 30, -400);
  const lampMaterial = new MeshBasicNodeMaterial();
  lampMaterial.colorNode = vec3(60, 50, 30);
  const lamp = new Mesh(new PlaneGeometry(2, 2), lampMaterial);
  lamp.position.set(60, 10, -300);
  scene.add(plane, wall, lamp);
  const camera = new PerspectiveCamera(45, width / height, 1, 500_000);

  const pipeline = new SimPipeline(renderer);
  const fog = heightFogTestSource({
    eye: uniform(new Vector3(0, 1_000_030, 0)),
    radius: 1_000_000,
  });
  // A translucent sheet in the overlay, fading behind geometry.
  const sheetMaterial = new MeshBasicNodeMaterial({ transparent: true, depthTest: false });
  sheetMaterial.colorNode = vec4(
    vec3(0.6, 0.7, 0.8),
    select(pipeline.sceneDistance.greaterThan(200), float(0.2), float(0)),
  );
  const sheet = new Mesh(new PlaneGeometry(100, 100), sheetMaterial);
  sheet.position.set(0, 0, -200);
  sheet.visible = false;
  pipeline.overlay.add(sheet);

  interface Config {
    post?: boolean;
    final?: boolean;
    bloom?: boolean;
    overlay?: boolean;
    volumetric?: boolean;
    filter?: boolean;
    /** A source that returns a constant: the pipeline's own share of the volumetric stage. */
    empty?: boolean;
  }
  const configs: [string, Config][] = [
    ['direct', { post: false }],
    ['bare pipeline', {}],
    ['grade, grain, dither', { final: true }],
    ['bloom', { bloom: true }],
    ['overlay', { overlay: true }],
    ['volumetric, no march', { volumetric: true, empty: true }],
    ['volumetric', { volumetric: true }],
    ['volumetric, unfiltered', { volumetric: true, filter: false }],
    // Pairs: a stage's cost can depend on the others (the bloom's prefilter composites them).
    ['volumetric + bloom', { bloom: true, volumetric: true }],
    ['overlay + bloom', { bloom: true, overlay: true }],
    ['volumetric + overlay', { overlay: true, volumetric: true }],
    ['all', { final: true, bloom: true, overlay: true, volumetric: true }],
  ];
  const draw = (c: Config) => {
    pipeline.grading = pipeline.grain = pipeline.dither = c.final === true;
    pipeline.bloom = c.bloom === true;
    sheet.visible = c.overlay === true;
    pipeline.volumetricsEnabled = c.volumetric === true;
    pipeline.volumetricFilter = c.filter !== false;
    if (c.post === false) renderer.render(scene, camera);
    else if (c.empty) machinery.render(scene, camera);
    else pipeline.render(scene, camera);
  };
  pipeline.volumetrics = fog;
  // A second pipeline whose source does no work.
  const machinery = new SimPipeline(renderer);
  machinery.bloom = machinery.grading = machinery.grain = machinery.dither = false;
  machinery.volumetrics = { build: () => vec4(0.1, 0.1, 0.1, 0.8) };
  machinery.volumetricScale = 1 / Number(process.env.SCALE ?? 3);
  // One scale per run: changing it reallocates the low-resolution targets.
  pipeline.volumetricScale = 1 / Number(process.env.SCALE ?? 3);
  const times: number[][] = configs.map(() => []);
  const passes: string[] = [];
  for (let round = -2; round < rounds; round++) {
    for (let k = 0; k < configs.length; k++) {
      const t0 = performance.now();
      draw(configs[k]![1]);
      await gpu.finish();
      // The first rounds compile shaders and allocate targets.
      if (round >= 0) times[k]!.push(performance.now() - t0);
      passes[k] =
        configs[k]![1].post === false
          ? '2 passes'
          : `${(configs[k]![1].empty ? machinery : pipeline).stats.passes} passes, ${(configs[k]![1].empty ? machinery : pipeline).stats.targets} targets`;
    }
  }
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;
  const direct = median(times[0]!);
  console.log(
    `post-processing at ${width} × ${height}, volumetrics at 1/${Math.round(1 / pipeline.volumetricScale)}, median of ${rounds} frames (errors: ${gpu.errors.length})`,
  );
  for (let k = 0; k < configs.length; k++) {
    const ms = median(times[k]!);
    console.log(
      `  ${configs[k]![0].padEnd(22)} ${ms.toFixed(2).padStart(7)} ms  ${(ms - direct >= 0 ? '+' : '') + (ms - direct).toFixed(2)} ms  (${passes[k]})`,
    );
  }
  pipeline.dispose();
  machinery.dispose();
  head.dispose();
});
