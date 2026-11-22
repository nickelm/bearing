/**
 * The effects sandbox page (`effects.html`, Proposal 0011, decision 327): the sandbox scene
 * in the browser with a debug panel to spawn every preset and explosion size, run the
 * scripted actors, set the wind, the sun and the air, move between camera stations, orbit
 * with the mouse, and run the proposal's stress scene. With `?gputime` (and a GPU that can
 * time passes) it shows the compute pass's time and, under "Measure", the puffs' share of
 * the render time from frames drawn with and without them.
 *
 * `window.bearingEffects` is the sandbox, for tools that drive the page.
 */
import GUI from 'lil-gui';
import { WebGPURenderer } from 'three/webgpu';
import {
  isOnWebGpuBackend,
  probeWebGpu,
  requestRendererDevice,
  showWebGpuRequired,
} from '../render/common/webgpuSupport';
import type { PresetId } from '../render/sim/effects/presets';
import type { ExplosionKind } from '../sim/effects/events';
import { EffectsSandbox, EXPLOSION_SIZES, VIEWS } from './sandboxScene';
import type { ExplosionSize } from './sandboxScene';
import { Vec3d } from '../core/vec3d';

async function start(): Promise<void> {
  const probe = await probeWebGpu();
  if ('problem' in probe) return showWebGpuRequired(probe.problem);
  const device = await requestRendererDevice(probe.adapter, probe.limits);
  const query = new URLSearchParams(location.search);
  const renderer = new WebGPURenderer({
    antialias: true,
    device,
    reversedDepthBuffer: true,
    trackTimestamp: query.has('gputime'),
  });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  document.body.appendChild(renderer.domElement);
  await renderer.init();
  if (!isOnWebGpuBackend(renderer))
    return showWebGpuRequired(
      'The renderer could not start a WebGPU device and fell back to WebGL 2.',
    );

  const sandbox = new EffectsSandbox(renderer, { post: !query.has('nopost') });
  (window as unknown as { bearingEffects: EffectsSandbox }).bearingEffects = sandbox;
  const resize = () => sandbox.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', resize);
  resize();

  const state = {
    view: 'overview',
    paused: false,
    speed: 1,
    windSpeed: 5,
    windFrom: 270,
    sunElevation: 35,
    sunAzimuth: 220,
    temperature: 15,
    humidity: 0.5,
    kind: 'ground' as ExplosionKind,
    effects: true,
  };
  const gui = new GUI({ title: 'Effects sandbox' });
  const views = gui.addFolder('Camera');
  views
    .add(state, 'view', Object.keys(VIEWS))
    .name('station')
    .onChange((v: string) => {
      state.view = v;
      orbitFrom(v);
    });
  views.add(state, 'paused');
  views.add(state, 'speed', 0.1, 4, 0.1).name('time scale');
  views.add(state, 'effects').onChange((v: boolean) => (sandbox.effects.group.visible = v));

  const presets = gui.addFolder('Presets');
  for (const p of EffectsSandbox.presets()) {
    presets.add({ [p.label]: () => sandbox.spawn(p.id as PresetId) }, p.label);
  }
  const blasts = gui.addFolder('Explosions');
  blasts.add(state, 'kind', ['ground', 'air', 'water', 'fuel']);
  for (const size of Object.keys(EXPLOSION_SIZES) as ExplosionSize[]) {
    blasts.add({ [size]: () => sandbox.explosion(size, state.kind) }, size);
  }
  const actors = gui.addFolder('Actors');
  actors.add({ 'missile (solid)': () => sandbox.missile('solid') }, 'missile (solid)');
  actors.add(
    { 'missile (reduced smoke)': () => sandbox.missile('reduced-smoke') },
    'missile (reduced smoke)',
  );
  actors.add({ 'SAM launch': () => sandbox.sam() }, 'SAM launch');
  actors.add({ 'contrail pass': () => sandbox.contrail() }, 'contrail pass');
  actors.add({ 'hard turn (7 g)': () => sandbox.hardTurn(7) }, 'hard turn (7 g)');
  actors.add({ 'hover (snow)': () => sandbox.hover(30, 'snow-dust') }, 'hover (snow)');
  actors.add({ 'hover (spray)': () => sandbox.hover(30, 'spray') }, 'hover (spray)');
  const air = gui.addFolder('Wind, sun and air');
  const wind = () => sandbox.setWind(state.windSpeed, state.windFrom);
  const sun = () => sandbox.setSun(state.sunElevation, state.sunAzimuth);
  air.add(state, 'windSpeed', 0, 30, 0.5).name('wind (m/s)').onChange(wind);
  air.add(state, 'windFrom', 0, 360, 5).name('wind from (°)').onChange(wind);
  air.add(state, 'sunElevation', -20, 90, 1).name('sun elevation (°)').onChange(sun);
  air.add(state, 'sunAzimuth', 0, 360, 5).name('sun azimuth (°)').onChange(sun);
  air
    .add(state, 'temperature', -40, 40, 1)
    .name('surface (°C)')
    .onChange((v: number) => (sandbox.temperature = v));
  air.add(state, 'humidity', 0, 1, 0.05).onChange((v: number) => (sandbox.humidity = v));
  gui.add({ 'stress test': () => sandbox.stress() }, 'stress test');
  gui.add({ measure: () => measure() }, 'measure').name('measure (?gputime)');
  gui.add({ reset: () => sandbox.reset() }, 'reset');

  // Orbit with the mouse around the station's target; the wheel moves in and out.
  let yaw = 0;
  let pitch = 10;
  let distance = 1000;
  let target = sandbox.site('range');
  function orbitFrom(name: string): void {
    const v = VIEWS[name]!;
    target = sandbox.local(v.at[0], v.at[1], v.at[2]);
    const eye = sandbox.local(v.eye[0], v.eye[1], v.eye[2]);
    const d = eye.clone().sub(target);
    distance = d.length();
    const up = target.clone().normalize();
    pitch = (Math.asin(d.dot(up) / distance) * 180) / Math.PI;
    const east = new Vec3d(0, 1, 0).cross(up).normalize();
    const north = up.clone().cross(east);
    yaw = (Math.atan2(-d.dot(east), -d.dot(north)) * 180) / Math.PI;
    sandbox.setView(name);
  }
  orbitFrom(state.view);
  let drag: { x: number; y: number } | null = null;
  renderer.domElement.addEventListener(
    'pointerdown',
    (e) => (drag = { x: e.clientX, y: e.clientY }),
  );
  window.addEventListener('pointerup', () => (drag = null));
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    yaw += (e.clientX - drag.x) * 0.3;
    pitch = Math.max(-5, Math.min(85, pitch + (e.clientY - drag.y) * 0.3));
    drag = { x: e.clientX, y: e.clientY };
    sandbox.orbit(target, yaw, pitch, distance);
  });
  renderer.domElement.addEventListener('wheel', (e) => {
    distance = Math.max(20, Math.min(40_000, distance * Math.exp(e.deltaY * 0.001)));
    sandbox.orbit(target, yaw, pitch, distance);
  });

  // GPU time: the compute pass every frame; the puffs' share of the render under "measure".
  const timing = {
    compute: 0,
    render: 0,
    with: [] as number[],
    without: [] as number[],
    measuring: 0,
  };
  let resolving = false;
  function measure(): void {
    timing.with = [];
    timing.without = [];
    timing.measuring = 240;
  }
  const statsEl = document.getElementById('effects-stats')!;
  let last = performance.now();
  let frames = 0;
  let fps = 0;
  let fpsAt = last;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = state.paused ? 0 : Math.min(0.1, (now - last) / 1000) * state.speed;
    last = now;
    let measuringOn: boolean | null = null;
    if (timing.measuring > 0) {
      measuringOn = timing.measuring % 2 === 0;
      sandbox.effects.group.visible = measuringOn;
      timing.measuring--;
      if (timing.measuring === 0) sandbox.effects.group.visible = state.effects;
    }
    sandbox.frame(dt);
    frames++;
    if (now - fpsAt > 1000) {
      fps = (frames * 1000) / (now - fpsAt);
      frames = 0;
      fpsAt = now;
    }
    if (query.has('gputime') && !resolving) {
      resolving = true;
      const on = measuringOn;
      void Promise.all([
        renderer.resolveTimestampsAsync('render'),
        renderer.resolveTimestampsAsync('compute'),
      ])
        .then(([r, c]) => {
          timing.render = r ?? 0;
          timing.compute = c ?? 0;
          if (on === true) timing.with.push(timing.render);
          if (on === false) timing.without.push(timing.render);
        })
        .finally(() => (resolving = false));
    }
    const s = sandbox.effects.stats;
    const med = (xs: number[]) =>
      xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1]! : NaN;
    statsEl.textContent =
      `${fps.toFixed(0)} fps   puffs ${s.live} (drawn ${s.drawn})   spawned ${s.spawned}/frame\n` +
      `emitters ${s.emitters}   columns ${s.columns}   debris ${s.debris}   marks ${s.marks}   lights ${s.lights}   ribbon points ${s.ribbons}\n` +
      `governor ${s.rateScale.toFixed(2)}   overwritten ${s.overwritten}` +
      (query.has('gputime')
        ? `\nGPU compute ${timing.compute.toFixed(3)} ms   render ${timing.render.toFixed(2)} ms` +
          (timing.with.length
            ? `   puffs' share ${(med(timing.with) - med(timing.without)).toFixed(2)} ms (of ${timing.with.length} frame pairs)`
            : '')
        : '');
  });
}

void start();
