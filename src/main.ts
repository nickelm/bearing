import './style.css';
import { WebGPURenderer } from 'three/webgpu';
import { rng } from './core/rng';
import { DEG, KM, PLANET_RADIUS } from './core/units';
import { DEFAULT_PLANET_PARAMS } from './worldgen';
import { GlobeScene } from './render/globeScene';
import { runComputeSmokeTest } from './render/computeSmokeTest';
import {
  isOnWebGpuBackend,
  probeWebGpu,
  showFatalError,
  showWebGpuRequired,
} from './render/webgpuSupport';
import { DebugGui } from './ui/debugGui';
import { FrameTimeOverlay } from './ui/frameTimeOverlay';
import { PING_STREAM } from './workers/protocol';
import type { FromSimWorker, ToSimWorker } from './workers/protocol';

async function main(): Promise<void> {
  const problem = await probeWebGpu();
  if (problem) {
    showWebGpuRequired(problem);
    return;
  }

  const container = document.getElementById('app')!;
  const renderer = new WebGPURenderer({ antialias: true });
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

  const params = {
    // ?seed=<integer or any string> selects a world; otherwise use the default.
    seed: new URLSearchParams(location.search).get('seed') ?? String(DEFAULT_PLANET_PARAMS.seed),
    subdivisions: 64,
    wireframe: true,
  };

  const globe = new GlobeScene(renderer, {
    radius: PLANET_RADIUS,
    subdivisions: params.subdivisions,
    seed: params.seed,
  });
  globe.globe.wireframe = params.wireframe;

  const gui = new DebugGui(params, {
    regenerate: (p) => {
      globe.globe.recolor(p.seed);
      pingWorker(p.seed);
    },
    setSubdivisions: (n) => globe.globe.setSubdivisions(n, params.seed),
    setWireframe: (on) => (globe.globe.wireframe = on),
  });
  gui.status.backend = 'WebGPU';

  const overlay = new FrameTimeOverlay();

  // Sim worker stub: confirm bundling and cross-context determinism.
  const worker = new Worker(new URL('./workers/sim.worker.ts', import.meta.url), {
    type: 'module',
  });
  let expected = 0;
  const pingWorker = (seed: string) => {
    expected = rng(seed, PING_STREAM).nextUint32();
    gui.status.worker = 'pending';
    worker.postMessage({ type: 'ping', seed } satisfies ToSimWorker);
  };
  worker.onmessage = (e: MessageEvent<FromSimWorker>) => {
    const ok = e.data.value === expected;
    gui.status.worker = ok ? 'ok (deterministic)' : 'MISMATCH';
    if (!ok) console.error('Sim worker RNG mismatch', e.data.value, expected);
  };
  worker.onerror = (e) => {
    gui.status.worker = 'error';
    console.error('Sim worker error', e);
  };
  pingWorker(params.seed);

  runComputeSmokeTest(renderer)
    .then((ok) => (gui.status.compute = ok ? 'ok' : 'WRONG RESULT'))
    .catch((err: unknown) => {
      gui.status.compute = 'error';
      console.error('GPU compute smoke test failed', err);
    });

  const onResize = () => globe.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', onResize);
  onResize();

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
