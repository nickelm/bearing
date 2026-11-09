import './style.css';
import { WebGPURenderer } from 'three/webgpu';
import { CubeGrid } from './core/cubeGrid';
import { rng } from './core/rng';
import { DEG, KM } from './core/units';
import { DEFAULT_PLANET_PARAMS } from './worldgen/params';
import type { PlanetParams } from './worldgen/params';
import { GlobeScene } from './render/globeScene';
import { VIEW_MODES } from './render/globeMesh';
import type { ViewMode } from './render/globeMesh';
import { runComputeSmokeTest } from './render/computeSmokeTest';
import {
  isOnWebGpuBackend,
  probeWebGpu,
  rendererDevice,
  showFatalError,
  showWebGpuRequired,
} from './render/webgpuSupport';
import {
  DEFAULT_GLOBAL_RESOLUTION,
  DebugGui,
  GLOBAL_RESOLUTIONS,
  RESOLUTIONS,
} from './ui/debugGui';
import { GpuContext } from './worldgen/gpu/gpuContext';
import { buildGlobalWorld, GlobalPassCancelled } from './worldgen/globalPipeline';
import type { GlobalWorld } from './worldgen/globalPipeline';
import { GPU_SELF_TESTS, runSelfTest } from './worldgen/gpu/selfTests';
import type { ViewGuiParams, WorldGuiParams } from './ui/debugGui';
import { FrameTimeOverlay } from './ui/frameTimeOverlay';
import { PING_STREAM } from './workers/protocol';
import type { FromSimWorker, ToSimWorker } from './workers/protocol';
import { GenerationCancelled, WorldgenClient } from './workers/worldgenClient';

async function main(): Promise<void> {
  const probe = await probeWebGpu();
  if ('problem' in probe) {
    showWebGpuRequired(probe.problem);
    return;
  }

  const container = document.getElementById('app')!;
  const renderer = new WebGPURenderer({ antialias: true, requiredLimits: probe.limits });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);
  await renderer.init();

  if (!isOnWebGpuBackend(renderer)) {
    // WebGPURenderer fell back to WebGL 2. Bearing does not support that.
    renderer.dispose();
    renderer.domElement.remove();
    showWebGpuRequired('The renderer could not start a WebGPU device and fell back to WebGL 2.');
    return;
  }

  // URL parameters: ?seed=<integer or text>&res=<tectonic cells per face edge>&gres=<global grid>
  const query = new URLSearchParams(location.search);
  const queryRes = Number(query.get('res'));
  const queryGres = Number(query.get('gres'));
  const worldParams: WorldGuiParams = {
    seed: query.get('seed') ?? String(DEFAULT_PLANET_PARAMS.seed),
    resolution: (RESOLUTIONS as readonly number[]).includes(queryRes) ? queryRes : 256,
    globalResolution: (GLOBAL_RESOLUTIONS as readonly number[]).includes(queryGres)
      ? queryGres
      : DEFAULT_GLOBAL_RESOLUTION,
    plateCount: DEFAULT_PLANET_PARAMS.plateCount,
    oceanFraction: DEFAULT_PLANET_PARAMS.oceanFraction,
    reliefScale: Number(DEFAULT_PLANET_PARAMS.reliefScale.toFixed(3)),
    temperatureOffset: DEFAULT_PLANET_PARAMS.temperatureOffset,
    moistureScale: DEFAULT_PLANET_PARAMS.moistureScale,
    erosionStrength: DEFAULT_PLANET_PARAMS.erosionStrength,
  };
  const viewParams: ViewGuiParams = { mode: 'biome', exaggeration: 10, wireframe: false };

  let grid = new CubeGrid(worldParams.resolution);
  const globe = new GlobeScene(renderer, { radius: DEFAULT_PLANET_PARAMS.radius, grid });
  globe.globe.setFaceSeed(worldParams.seed);
  globe.globe.setExaggeration(viewParams.exaggeration);

  const worldgen = new WorldgenClient();
  let generation = 0;
  /** The current world's global pass (eroded grid on the GPU, rivers...), once finished. */
  let globalWorld: GlobalWorld | null = null;

  const regenerate = async () => {
    const token = ++generation;
    const params: PlanetParams = {
      ...DEFAULT_PLANET_PARAMS,
      seed: worldParams.seed,
      plateCount: worldParams.plateCount,
      oceanFraction: worldParams.oceanFraction,
      reliefScale: worldParams.reliefScale,
      temperatureOffset: worldParams.temperatureOffset,
      moistureScale: worldParams.moistureScale,
      erosionStrength: worldParams.erosionStrength,
    };
    const resolution = worldParams.resolution;
    const globalN = Math.max(worldParams.globalResolution, resolution);
    gui.status.generation = 'starting';
    pingWorker(worldParams.seed);
    const url = new URL(location.href);
    url.searchParams.set('seed', worldParams.seed);
    url.searchParams.set('res', String(resolution));
    url.searchParams.set('gres', String(globalN));
    history.replaceState(null, '', url);
    const t0 = performance.now();
    const status = (stage: string, f: number) => {
      if (token === generation) gui.status.generation = `${stage} (${Math.round(f * 100)}%)`;
    };
    try {
      // 1. Tectonic pass in the worker, shown at once as a preview.
      const world = await worldgen.generate(params, resolution, status);
      if (token !== generation) return;
      if (grid.n !== resolution) {
        grid = new CubeGrid(resolution);
        globe.globe.setGrid(grid);
      }
      globe.globe.setFaceSeed(worldParams.seed);
      globe.globe.setWorld(world);
      console.info(
        `World ${worldParams.seed} @ ${resolution}: land ${(world.info.landFraction * 100).toFixed(1)}%, ` +
          `heights ${world.info.minHeight.toFixed(0)}..${world.info.maxHeight.toFixed(0)} m, ` +
          `continents ${((world.info.continentSeparation / Math.PI) * 180).toFixed(1)}° apart`,
      );
      console.table(world.info.timings.map((t) => ({ stage: t.stage, ms: Math.round(t.ms) })));

      // 2. Global pass: GPU detail and erosion here, drainage and rivers in the worker.
      const global = await buildGlobalWorld(gpu, params, world, {
        n: globalN,
        finish: (input) => worldgen.finish(input),
        onProgress: (stage, f) => status(`global ${globalN}: ${stage}`, f),
        cancelled: () => token !== generation,
      });
      if (token !== generation) {
        global.grid.dispose();
        return;
      }
      globalWorld?.grid.dispose();
      globalWorld = global;
      const d = global.finish.display;
      let maxHeight = -Infinity;
      for (const h of d.height) maxHeight = Math.max(maxHeight, h);
      globe.globe.setWorld({
        maps: {
          ...world.maps,
          height: d.height,
          biome: d.biome,
          discharge: d.discharge,
          lakeDepth: d.lakeDepth,
        },
        info: { ...world.info, maxHeight },
      });
      const total = performance.now() - t0;
      gui.status.generation = `done in ${(total / 1000).toFixed(1)} s`;
      console.info(
        `Global ${globalN}: ${global.finish.rivers.count} river polylines, ` +
          `GPU maps ${(global.grid.peakBytes / 2 ** 20).toFixed(0)} MiB`,
      );
      console.table(
        [...global.timings, ...global.finish.timings].map((t) => ({
          stage: t.stage,
          ms: Math.round(t.ms),
        })),
      );
    } catch (err) {
      if (token !== generation) return;
      if (err instanceof GenerationCancelled || err instanceof GlobalPassCancelled) {
        gui.status.generation = 'cancelled';
      } else {
        gui.status.generation = 'error (see console)';
        console.error(err);
      }
    }
  };

  const gui = new DebugGui(worldParams, viewParams, VIEW_MODES, {
    regenerate: () => void regenerate(),
    cancel: () => {
      generation++;
      worldgen.cancel();
      gui.status.generation = 'cancelled';
    },
    viewChanged: (v) => {
      globe.globe.setViewMode(v.mode as ViewMode);
      globe.globe.wireframe = v.wireframe;
    },
    shapeChanged: (v) => globe.globe.setExaggeration(v.exaggeration),
  });
  gui.status.backend = 'WebGPU';

  // World-generation compute shares three's device (decision 22).
  const gpu = new GpuContext(rendererDevice(renderer));
  gui.addSelfTests(
    GPU_SELF_TESTS.map((t) => t.name),
    async (report) => {
      for (const t of GPU_SELF_TESTS) {
        report(t.name, 'running');
        const failure = await runSelfTest(gpu, t);
        report(t.name, failure ?? 'ok');
        if (failure) console.error(`GPU self-test "${t.name}" failed: ${failure}`);
      }
    },
  );

  const overlay = new FrameTimeOverlay();

  // Sim worker stub: confirms bundling and cross-context determinism.
  const simWorker = new Worker(new URL('./workers/sim.worker.ts', import.meta.url), {
    type: 'module',
  });
  let expected = 0;
  const pingWorker = (seed: string) => {
    expected = rng(seed, PING_STREAM).nextUint32();
    gui.status.worker = 'pending';
    simWorker.postMessage({ type: 'ping', seed } satisfies ToSimWorker);
  };
  simWorker.onmessage = (e: MessageEvent<FromSimWorker>) => {
    const ok = e.data.value === expected;
    gui.status.worker = ok ? 'ok (deterministic)' : 'MISMATCH';
    if (!ok) console.error('Sim worker RNG mismatch', e.data.value, expected);
  };
  simWorker.onerror = (e) => {
    gui.status.worker = 'error';
    console.error('Sim worker error', e);
  };

  runComputeSmokeTest(renderer)
    .then((ok) => (gui.status.compute = ok ? 'ok' : 'WRONG RESULT'))
    .catch((err: unknown) => {
      gui.status.compute = 'error';
      console.error('GPU compute smoke test failed', err);
    });

  const onResize = () => globe.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', onResize);
  onResize();

  void regenerate();

  let last = performance.now();
  await renderer.setAnimationLoop((now) => {
    const frameMs = now - last;
    last = now;
    overlay.record(frameMs, now);
    globe.render(Math.min(frameMs, 100) / 1000);

    const o = globe.orbit;
    gui.status.altitudeKm = o.altitude / KM;
    gui.status.latDeg = o.lat / DEG;
    gui.status.lonDeg = o.lon / DEG;
    gui.status.tiltDeg = o.tilt / DEG;
  });
}

main().catch((err: unknown) => {
  console.error(err);
  showFatalError(String(err));
});
