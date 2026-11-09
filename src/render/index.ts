/**
 * render: terrain, atmosphere, ocean, units and cameras. Reads world and
 * simulation state; never writes it. All world-space objects are placed
 * camera-relative (see globeScene.ts).
 */
export { GlobeScene } from './globeScene';
export type { GlobeSceneOptions } from './globeScene';
export { GlobeMesh, VIEW_MODES } from './globeMesh';
export type { ViewMode } from './globeMesh';
export { OrbitCamera, attachOrbitInput, DEFAULT_ORBIT_LIMITS } from './orbitCamera';
export { buildCubeSphereArrays } from './cubeSphereGeometry';
export {
  probeWebGpu,
  isOnWebGpuBackend,
  showWebGpuRequired,
  showFatalError,
} from './webgpuSupport';
export { runComputeSmokeTest } from './computeSmokeTest';
