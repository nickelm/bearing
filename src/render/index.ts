/**
 * render: the two views of one world (decision 72). `common/` holds what both
 * share, `sim/` the low-poly simulation view, `strategic/` the illustrated map.
 * Reads world and simulation state; never writes it. All world-space objects
 * are placed camera-relative (see common/cameraRelative.ts).
 */
export { GlobeScene } from './sim/globeScene';
export { StrategicScene, STRATEGIC_FLOOR, STRATEGIC_CEILING } from './strategic/strategicScene';
export type { GlobeSceneOptions } from './sim/globeScene';
export { GlobeMesh, VIEW_MODES } from './common/globeMesh';
export type { ViewMode } from './common/globeMesh';
export { OrbitCamera, attachOrbitInput, DEFAULT_ORBIT_LIMITS } from './common/orbitCamera';
export { placeCameraRelative, placePlanetCentered } from './common/cameraRelative';
export { buildCubeSphereArrays } from './common/cubeSphereGeometry';
export {
  probeWebGpu,
  isOnWebGpuBackend,
  showWebGpuRequired,
  showFatalError,
} from './common/webgpuSupport';
export { runComputeSmokeTest } from './common/computeSmokeTest';
