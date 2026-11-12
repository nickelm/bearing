/**
 * The model viewer (decision 106; visual-style Part I, Procedural Model Builders): a
 * second page, viewer.html, that renders any model spec from the library on a
 * turntable.
 *
 * - **Controls** (lil-gui): model, camouflage scheme override, turntable speed, view
 *   pitch and distance, time of day (the sun's elevation and color follow it, golden
 *   near the horizon), sun azimuth, sky light, exposure, ambient occlusion on or off,
 *   wireframe, emissive lights, ink outlines with their width (decision 107), and
 *   silhouette mode: solid black on a pale sky (Part I acceptance check 6).
 * - **Shading.** Flat, from the builder's face normals: the spec colors × baked
 *   occlusion × (sky light from above + a sun term), no tone curve.
 * - **Hot reload.** In dev, editing a spec reloads the page through Vite; the chosen
 *   model and settings live in the URL hash, so the view comes back as it was.
 */
import '../style.css';
import {
  BackSide,
  Color,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  NoToneMapping,
  OctahedronGeometry,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  dot,
  float,
  length,
  max,
  mix,
  modelWorldMatrix,
  positionLocal,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import GUI from 'lil-gui';
import { buildModel } from '../render/common/models/builder';
import type { BuiltModel } from '../render/common/models/builder';
import { MODEL_SPECS } from '../render/common/models/library';
import { SCHEMES } from '../render/common/models/palettes';
import { MODEL_BUDGETS } from '../render/common/models/spec';
import { INK_LINEAR, modelGeometry } from '../render/common/models/threeModel';
import {
  isOnWebGpuBackend,
  probeWebGpu,
  requestRendererDevice,
  showFatalError,
  showWebGpuRequired,
} from '../render/common/webgpuSupport';

const PALE_SKY = '#C9D8E3';

interface ViewerState {
  model: string;
  scheme: string;
  spin: number;
  pitch: number;
  distance: number;
  hour: number;
  azimuth: number;
  sky: number;
  exposure: number;
  ao: boolean;
  wireframe: boolean;
  lights: boolean;
  silhouette: boolean;
  ink: boolean;
  inkWidth: number;
}

function readHash(defaults: ViewerState): ViewerState {
  try {
    const parsed = JSON.parse(
      decodeURIComponent(location.hash.slice(1)) || '{}',
    ) as Partial<ViewerState>;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

/** Sun elevation (rad) and colors at an hour of the day: up at 6, highest at 12. */
export function sunAt(hour: number): { elevation: number; sun: Color; sky: Color } {
  const elevation = ((65 * Math.PI) / 180) * Math.sin((Math.PI * (hour - 6)) / 12);
  const low = Math.min(1, Math.max(0, 1 - elevation / ((20 * Math.PI) / 180)));
  const sun = new Color(1, 1, 1).lerp(new Color('#FF9A4D'), low * 0.85);
  const sky = new Color(PALE_SKY).lerp(new Color('#F6B07A'), low * 0.6);
  if (elevation < 0) sun.multiplyScalar(Math.max(0, 1 + elevation * 6));
  return { elevation, sun, sky };
}

async function start(): Promise<void> {
  const probe = await probeWebGpu();
  if ('problem' in probe) return showWebGpuRequired(probe.problem);
  const device = await requestRendererDevice(probe.adapter, probe.limits);
  const renderer = new WebGPURenderer({ antialias: true, device });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = NoToneMapping;
  document.body.appendChild(renderer.domElement);
  await renderer.init();
  if (!isOnWebGpuBackend(renderer))
    return showWebGpuRequired(
      'The renderer could not start a WebGPU device and fell back to WebGL 2.',
    );

  const ids = Object.keys(MODEL_SPECS);
  const state = readHash({
    model: ids.includes('alliance-fighter') ? 'alliance-fighter' : ids[0]!,
    scheme: '',
    spin: 0.3,
    pitch: 20,
    distance: 2.2,
    hour: 11,
    azimuth: 135,
    sky: 1,
    exposure: 1,
    ao: true,
    wireframe: false,
    lights: true,
    silhouette: false,
    ink: true,
    inkWidth: 2,
  });

  const scene = new Scene();
  const camera = new PerspectiveCamera(35, 1, 0.1, 5000);
  const turntable = new Group();
  scene.add(turntable);

  // Lighting in the model's own frame (the turntable turns the light the other way).
  const sunDir = uniform(new Vector3(0, 1, 0));
  // Linear rgb (three converts hex colors to its linear working space).
  const sunColor = uniform(new Vector3(1, 1, 1));
  const skyColor = uniform(new Vector3(1, 1, 1));
  const skyStrength = uniform(1);
  const exposure = uniform(1);
  const aoOn = uniform(1);
  const silhouette = uniform(0);
  const material = new MeshBasicNodeMaterial();
  const n = attribute('normal', 'vec3');
  const albedo = attribute('color', 'vec3').mul(mix(float(1), attribute('ao', 'float'), aoOn));
  const sky = skyColor.mul(skyStrength).mul(n.y.mul(0.25).add(0.5));
  const sun = vec3(sunColor)
    .mul(max(dot(n, sunDir), 0))
    .mul(0.9);
  material.colorNode = mix(albedo.mul(sky.add(sun)).mul(exposure), vec3(0, 0, 0), silhouette);

  // Ink outlines (decision 107): the model again, inflated along its outline normals by
  // a width in pixels at each vertex's distance, back faces only, in ink.
  const inkPixel = uniform(0.001); // radians per pixel × width (px)
  const ink = new MeshBasicNodeMaterial({ side: BackSide });
  const world = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz;
  const inkOffset = length(cameraPosition.sub(world)).mul(inkPixel);
  ink.positionNode = positionLocal.add(attribute('outlineNormal', 'vec3').mul(inkOffset));
  ink.colorNode = vec3(...INK_LINEAR);
  let outline: Mesh | null = null;
  let mesh: Mesh | null = null;
  const lights = new Group();
  turntable.add(lights);
  let model: BuiltModel | null = null;
  const info = document.getElementById('viewer-info')!;
  info.style.cssText =
    'position:fixed;left:12px;bottom:12px;font:13px system-ui;color:#22252a;background:#f4efe4cc;padding:6px 10px;border-radius:4px';

  const rebuild = () => {
    const spec = MODEL_SPECS[state.model];
    if (!spec) return;
    if (mesh) {
      turntable.remove(mesh);
      mesh.geometry.dispose();
    }
    lights.clear();
    const t0 = performance.now();
    model = buildModel(spec, { scheme: state.scheme || undefined });
    const ms = performance.now() - t0;
    const geometry = modelGeometry(model);
    mesh = new Mesh(geometry, material);
    turntable.add(mesh);
    if (outline) turntable.remove(outline);
    outline = new Mesh(geometry, ink);
    turntable.add(outline);
    const size = Math.hypot(...model.bounds.max.map((v, i) => v - model!.bounds.min[i]!));
    const dot = new OctahedronGeometry(Math.max(0.15, size * 0.008), 0);
    for (const e of model.emissives) {
      const m = new MeshBasicNodeMaterial();
      m.colorNode = vec3(...e.color).mul(3);
      const light = new Mesh(dot, m);
      light.position.set(...e.position);
      light.userData.kind = e.kind;
      lights.add(light);
    }
    const [lo, hi] = MODEL_BUDGETS[model.class];
    info.textContent =
      `${model.name} (${model.id}, ${model.class}): ${model.triangles} triangles, budget ${lo}–${hi}` +
      `${model.triangles > hi || model.triangles < lo ? ' — OUT OF BUDGET' : ''}; built in ${ms.toFixed(0)} ms`;
    const c = model.bounds.min.map((v, i) => (v + model!.bounds.max[i]!) / 2);
    mesh.position.set(-c[0]!, -c[1]!, -c[2]!);
    outline.position.copy(mesh.position);
    lights.position.copy(mesh.position);
  };

  const save = () =>
    history.replaceState(null, '', `#${encodeURIComponent(JSON.stringify(state))}`);
  const gui = new GUI({ title: 'Model viewer' });
  gui
    .add(state, 'model', ids)
    .name('Model')
    .onChange(() => (rebuild(), save()));
  gui
    .add(state, 'scheme', ['', ...Object.keys(SCHEMES)])
    .name('Scheme override')
    .onChange(() => (rebuild(), save()));
  gui.add(state, 'silhouette').name('Silhouette (check 6)').onChange(save);
  gui.add(state, 'ink').name('Ink outlines').onChange(save);
  gui.add(state, 'inkWidth', 0.5, 4, 0.1).name('Ink width (px)').onChange(save);
  gui.add(state, 'wireframe').name('Wireframe').onChange(save);
  gui.add(state, 'ao').name('Ambient occlusion').onChange(save);
  gui.add(state, 'lights').name('Emissive lights').onChange(save);
  const v = gui.addFolder('View');
  v.add(state, 'spin', -1, 1, 0.05).name('Turntable (rad/s)').onChange(save);
  v.add(state, 'pitch', -89, 89, 1).name('Pitch (°)').onChange(save);
  v.add(state, 'distance', 1, 6, 0.05).name('Distance (× size)').onChange(save);
  const l = gui.addFolder('Light');
  l.add(state, 'hour', 4, 20, 0.1).name('Time of day (h)').onChange(save);
  l.add(state, 'azimuth', 0, 360, 1).name('Sun azimuth (°)').onChange(save);
  l.add(state, 'sky', 0, 2, 0.05).name('Sky light').onChange(save);
  l.add(state, 'exposure', 0.2, 3, 0.05).name('Exposure').onChange(save);
  gui
    .add(
      {
        link: () => {
          location.href = `${import.meta.env.BASE_URL}`;
        },
      },
      'link',
    )
    .name('Back to the game');

  rebuild();
  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  let yaw = 0;
  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    yaw += state.spin * dt;
    turntable.rotation.y = yaw;
    if (!model) return;
    const size = Math.hypot(...model.bounds.max.map((x, i) => x - model!.bounds.min[i]!));
    const p = (state.pitch * Math.PI) / 180;
    const d = size * state.distance;
    camera.position.set(d * Math.cos(p) * 0.8, d * Math.sin(p), d * Math.cos(p) * 0.6);
    camera.lookAt(0, 0, 0);
    camera.near = size * 0.01;
    camera.far = size * 20;
    camera.updateProjectionMatrix();
    const s = sunAt(state.hour);
    const az = (state.azimuth * Math.PI) / 180 - yaw;
    sunDir.value.set(
      Math.cos(s.elevation) * Math.cos(az),
      Math.sin(s.elevation),
      Math.cos(s.elevation) * Math.sin(az),
    );
    sunColor.value.set(s.sun.r, s.sun.g, s.sun.b);
    skyColor.value.set(s.sky.r, s.sky.g, s.sky.b);
    skyStrength.value = state.sky * Math.max(0.15, Math.min(1, 0.3 + s.elevation * 2));
    exposure.value = state.exposure;
    aoOn.value = state.ao ? 1 : 0;
    silhouette.value = state.silhouette ? 1 : 0;
    material.wireframe = state.wireframe;
    if (outline) outline.visible = state.ink && !state.wireframe;
    const fovY = (camera.fov * Math.PI) / 180;
    inkPixel.value = (fovY / window.innerHeight) * state.inkWidth;
    scene.background = new Color(state.silhouette ? PALE_SKY : s.sky.getStyle());
    const night = s.elevation < 0.1;
    const blink = Math.floor(now / 600) % 2 === 0;
    for (const light of lights.children) {
      const k = light.userData.kind as string;
      light.visible =
        state.lights &&
        !state.silhouette &&
        (k === 'beacon' ? blink : true) &&
        (k === 'afterburner' || night || k.startsWith('nav') || k === 'beacon');
    }
    renderer.render(scene, camera);
  });
}

start().catch((err: unknown) => {
  console.error(err);
  showFatalError(err instanceof Error ? err.message : String(err));
});
