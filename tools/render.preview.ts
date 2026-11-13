/**
 * Offline renders of the real scene (milestone 3): the app's GlobeScene drawn
 * by three's WebGPURenderer on Dawn (tests/gpu/renderer.ts), from fixed
 * camera views, written as PNGs. This is how shading and atmosphere changes
 * are judged without a browser.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/render.preview.ts
 *   env: SEED (1983), TRES tectonic resolution (256), GRES global resolution (1024),
 *        VIEWS comma list of view names (all; `checks` adds the Part I acceptance checks 1–5), W × H image size (1024 × 576),
 *        EX exaggeration (1, the simulation view's true scale), GRADE=0 leaves airfields ungraded (files get -ungraded),
 *        FACETS=0 shades the terrain smoothly instead of in flat facets (files get -smooth),
 *        PERF=n times n more frames per view once loaded: ms per frame until the GPU is
 *          done, CPU in scene.render and its parts, terrain loop lengths, draw statistics
 *          (on a software adapter only the ratios mean anything),
 *        PROF=<file> also writes a V8 CPU profile of those frames (.cpuprofile),
 *        POST=0 draws without the post-processing pipeline; BLOOM=0, GRAIN=0, GRADE_TOD=0 leave
 *          out its bloom, its grain and dither, its time-of-day grade; VOLTEST=1 adds a test
 *          height fog through its volumetric path (VOLSCALE, VOLDENSITY); PERF_POST=n times
 *          the frame drawn directly, through the bare pipeline, with its stages and with the
 *          test fog, interleaved over n rounds; MSAA=4 draws the simulation view with four
 *          samples per pixel, as the app does (default none),
 *        the sky (decision 140): views sunrise, golden, golden-away, twilight6, twilight6-away,
 *          twilight12, moonlit and stars look at it from the tower, and moonlit-range at the
 *          highest range under a full moon; SUN_EL (deg) sets any view's
 *          sun elevation and MORNING=1 takes the morning's, MOON_AGE (days; 0 new, 14.8 full)
 *          moves a view to the day whose moon is that old, OBS_HEADING also takes sun, moon and
 *          antisun, PERF_SKY=n times the frame with the sky from its LUT against the march per
 *          pixel that it replaced, interleaved over n rounds; OUT=dir writes the images there;
 *          HAZE=x sets the clear-air haze over the ground (default 0.32; 1 = all of the
 *          in-scattered light), LOW_SUN_FILL=x the sky light's gain under a low sun (π/2) and
 *          VIBRANCE=x the sky's saturation around sunset (1 = as computed), LIGHTS=0 puts
 *          the settlements' night glow on the ground out (to judge moonlight on its own),
 *        shadows, snow and rain (decision 139): SHADOW=0 leaves the mountain shadows out,
 *          SPARKLE=0 the snow's glints; SKY_LIGHT=x sets the sky light on surfaces (the fill in
 *          the shadows, default 2); WET=x (0..1) wets the ground whatever the weather;
 *          TEMP_OFFSET (°C) shifts every surface temperature (−30 puts snow on most ground);
 *          PERF_SHADOW=n times the frame without the shadow lookup and the glints, with the
 *          lookup, and with both, interleaved over n rounds; SHADOW_LIVE=1 keeps the shadows the
 *          app's per-frame bake made while the view settled, instead of baking them in one go;
 *          LOW_SUN_EXPOSURE=x sets the exposure of lit surfaces over the sky's under a low sun
 *          (default 1.7), SKY_LEAN=x how far the sky's light leans toward the sun (0.5),
 *          DAYLIGHT=x the sun's illuminance by day (1.4),
 *        SCENE=strategic draws the strategic view (StrategicScene, decisions 74, 93) instead,
 *          from STRATEGIC_PREVIEW_VIEWS (globe, night, theater, region, floor, cities, capital, front, winter,
 *          and sharp at 1920 × 1080; front centers on the first front line), with clouds, tile counts and frame times per view;
 *          CVD=1 also writes each image as seen with protanopia, deuteranopia, tritanopia;
 *          OVERLAY=1 adds the graph debug overlay, TINT=x sets the territory tint opacity
 *
 * Output: tools/out/render-<seed>-<view>.png, or render-<seed>-strategic-<view>[-<cvd>].png
 * (gitignored).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { it } from 'vitest';
import {
  defaultCampaignStart,
  seasonPhase,
  sunDirection,
  withLocalTime,
} from '../src/core/calendar';
import { cubeFaceUvToDirection, directionToCubeFace, latLonToDirection } from '../src/core/coords';
import { moonAge, moonDirection, SYNODIC_MONTH_DAYS } from '../src/core/moon';
import {
  tileForDirection,
  tileKeyString,
  TILE_BORDER,
  TILE_STRIDE,
  TILE_TEXELS,
} from '../src/core/tiles';
import type { TileKey } from '../src/core/tiles';
import type { TileData } from '../src/worldgen/gpu/tileSynth';
import type { CubeFace } from '../src/core/coords';
import { CubeGrid } from '../src/core/cubeGrid';
import { DAY, DEG, HOUR, KM } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { FARMABLE_BIOMES } from '../src/render/common/palette';
import { GlobeScene } from '../src/render/sim/globeScene';
import { buildFontAtlas, FONT_IDS } from '../src/render/strategic/labels/fontAtlas';
import type { FontId } from '../src/render/strategic/labels/fontAtlas';
import { LABEL_FONT_FILES } from '../src/render/strategic/labels/fontFiles';
import { StrategicScene } from '../src/render/strategic/strategicScene';
import { CloudLayer } from '../src/render/sim/clouds/cloudLayer';
import { WeatherTexture } from '../src/render/sim/clouds/weatherTexture';
import { PlanetLighting } from '../src/render/sim/lighting/planetLighting';
import { DEFICIENCIES, simulateCvd } from './cvd';
import { TileSynthesizer } from '../src/worldgen/gpu/tileSynth';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { RiverIndex } from '../src/worldgen/riverIndex';
import { testGpu } from '../tests/gpu/device';
import { headlessRenderer } from '../tests/gpu/renderer';
import { heightFogTestSource } from '../src/render/sim/post/heightFog';
import { encodePng } from './png';
import { previewWorld } from './previewWorld';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { settlementPoint } from '../src/worldgen/strategic/graph';
import { InfraScene, offsetPoint } from '../src/render/sim/infra/infraScene';
import { observerStations } from '../src/render/sim/camera/observerStations';
import { airfieldGrading } from '../src/render/sim/infra/airfieldGrading';
import { buildWeatherClimate } from '../src/sim/weather/climate';
import { WeatherGrid } from '../src/sim/weather/grid';
import { createSimWorld } from '../src/sim/world';
import { campaignInput } from '../src/sim/command/campaignInput';
import { findCheckTargets } from './checkViews';
import { findSpots, SPOT_KINDS } from './landscapeSpots';
import type { LandscapeSpot } from './landscapeSpots';

export interface PreviewView {
  name: string;
  /** Offsets from the main continent's center, radians. */
  dLat: number;
  dLon: number;
  altitude: number;
  tilt: number;
  heading: number;
  /** Local solar time at the camera, hours, on the campaign's first day (default 11:00). */
  localTime?: number;
  /** Days after the campaign start (default 0, mid-August local to the main continent). */
  day?: number;
  /**
   * Center on a feature instead of dLat/dLon: the deepest lake below 55°
   * latitude, the densely forested cell nearest the main continent, the
   * largest city, or the first main airbase (milestone 5).
   */
  target?:
    | 'lake'
    | 'forest'
    | 'city'
    | 'airbase'
    | 'front'
    | 'capital'
    | 'peak'
    | 'farmland'
    | 'mixed'
    | 'conifer'
    | 'beach';
  /**
   * With a target: face this far clockwise of the sun's azimuth (rad; 0 looks into
   * the sun, π puts it behind), standing back from the target along that heading.
   */
  sunHeading?: number;
  /** Trees and buildings on for this view (as DETAIL=1; DETAIL=0 still turns them off). */
  detail?: boolean;
  /** The Part I acceptance check this view captures (1–5; VIEWS=checks). */
  check?: number;
  /** With a target: the day of its hemisphere's midwinter instead of `day`. */
  midwinter?: boolean;
  /** With target 'airbase': stand back along the runway and look down it (heading ignored). */
  alongRunway?: boolean;
  /** Instead of localTime: the first evening time the sun at the camera sinks to this elevation (rad). */
  sunElevation?: number;
  /** With sunElevation: the morning time the sun stands at that elevation, not the evening's. */
  morning?: boolean;
  /**
   * The moon's age in days (0 new, 14.8 full): the view moves to the day, from `day` on, whose
   * moon at the view's time comes closest (core/moon.ts).
   */
  moonAge?: number;
  /** With observer: face the sun's or the moon's azimuth, or away from the sun's. */
  face?: 'sun' | 'moon' | 'antisun';
  /** With observer: pitch (rad) and height above the ground (m) instead of the station's. */
  pitch?: number;
  eyeHeight?: number;
  /**
   * Through the observer camera (V1) at the main airbase's tower, at its station's
   * height, facing and pitch (altitude, tilt, heading and target are ignored).
   */
  observer?: boolean;
  /** Through the observer camera at a landscape spot (SPOTS=…, tools/landscapeSpots.ts). */
  spot?: LandscapeSpot;
  /** Image size for this view (strategic previews; default W × H). */
  width?: number;
  height?: number;
}

/** An observer view at the main airbase's tower; the view's own fields aim it. */
const TOWER = { dLat: 0, dLon: 0, altitude: 0, tilt: 0, heading: 0, observer: true } as const;

/**
 * Simulation-view previews, all within its 0–20 km envelope (decision 72). The
 * five named for Part I's acceptance checks 1–5 carry `check` (VIEWS=checks
 * renders them; decision 128); the others look at single features. Views of
 * the globe and the map's scales are in STRATEGIC_PREVIEW_VIEWS.
 */
export const PREVIEW_VIEWS: PreviewView[] = [
  {
    // Part I check 1: 5 km over forest, farmland, a river and a town, sun behind and to the side.
    name: 'mixed',
    dLat: 0,
    dLon: 0,
    altitude: 5 * KM,
    tilt: 68 * DEG,
    heading: 0,
    localTime: 10.5,
    target: 'mixed',
    sunHeading: 140 * DEG,
    detail: true,
    check: 1,
  },
  {
    // Part I check 2: 500 m over a conifer forest edge with a road.
    name: 'conifer',
    dLat: 0,
    dLon: 0,
    altitude: 500,
    tilt: 76 * DEG,
    heading: 0,
    localTime: 14,
    target: 'conifer',
    sunHeading: 150 * DEG,
    detail: true,
    check: 2,
  },
  {
    // Part I check 3: the highest range near the main continent at low sun, lit from the side.
    name: 'range',
    dLat: 0,
    dLon: 0,
    altitude: 12 * KM,
    tilt: 80 * DEG,
    heading: 0,
    sunElevation: 8 * DEG,
    target: 'peak',
    sunHeading: 80 * DEG,
    check: 3,
  },
  {
    // Part I check 4: an airbase at dusk with its runway lit (V3).
    name: 'dusk',
    dLat: 0,
    dLon: 0,
    altitude: 300,
    tilt: 80 * DEG,
    heading: 0,
    sunElevation: -1 * DEG,
    target: 'airbase',
    alongRunway: true,
    detail: true,
    check: 4,
  },
  {
    // Part I check 5: a warm, low coast with a shallow shelf, facing the sun for its glint.
    name: 'beach',
    dLat: 0,
    dLon: 0,
    altitude: 1500,
    tilt: 80 * DEG,
    heading: 0,
    localTime: 16.5,
    target: 'beach',
    sunHeading: 0,
    check: 5,
  },
  {
    name: 'low',
    dLat: 0,
    dLon: 0,
    altitude: 2 * KM,
    tilt: 82 * DEG,
    heading: 200 * DEG,
    localTime: 9,
  },
  {
    // Low over the check-5 coast, looking out to sea into the sun.
    name: 'sea',
    dLat: 0,
    dLon: 0,
    altitude: 600,
    tilt: 84 * DEG,
    heading: 0,
    localTime: 16.8,
    target: 'beach',
    sunHeading: 0,
  },
  {
    // The check-5 coast with the sun behind: shallow water and foam without the glint.
    name: 'shore',
    dLat: 0,
    dLon: 0,
    altitude: 900,
    tilt: 60 * DEG,
    heading: 0,
    localTime: 14,
    target: 'beach',
    sunHeading: 180 * DEG,
  },
  {
    name: 'lake',
    dLat: 0,
    dLon: 0,
    altitude: 8 * KM,
    tilt: 70 * DEG,
    heading: 0,
    localTime: 13,
    target: 'lake',
  },
  {
    name: 'trees',
    dLat: 0,
    dLon: 0,
    altitude: 700,
    tilt: 80 * DEG,
    heading: 0,
    localTime: 15,
    target: 'forest',
  },
  {
    // The check-2 forest edge in its hemisphere's midwinter: snow on open ground, dark conifers.
    name: 'winter',
    dLat: 0,
    dLon: 0,
    altitude: 2 * KM,
    tilt: 72 * DEG,
    heading: 0,
    localTime: 12,
    target: 'conifer',
    sunHeading: 150 * DEG,
    midwinter: true,
    detail: true,
  },
  {
    // The highest summit near the main continent: rock and snow by face (decision 125).
    name: 'alpine',
    dLat: 0,
    dLon: 0,
    altitude: 10 * KM,
    tilt: 72 * DEG,
    heading: 0,
    localTime: 15,
    target: 'peak',
  },
  {
    // Over the most settled farmable lowland near the main continent (decision 127).
    name: 'farmland',
    dLat: 0,
    dLon: 0,
    altitude: 2 * KM,
    tilt: 70 * DEG,
    heading: 0,
    localTime: 11,
    target: 'farmland',
  },
  {
    name: 'sunset',
    dLat: 0,
    dLon: 0,
    altitude: 3 * KM,
    tilt: 84 * DEG,
    heading: 275 * DEG,
    localTime: 18.95,
  },
  {
    name: 'town',
    dLat: 0,
    dLon: 0,
    altitude: 3 * KM,
    tilt: 60 * DEG,
    heading: 0,
    localTime: 10,
    target: 'city',
    detail: true,
  },
  {
    name: 'airbase',
    dLat: 0,
    dLon: 0,
    altitude: 2 * KM,
    tilt: 55 * DEG,
    heading: 0,
    localTime: 10,
    target: 'airbase',
  },
  {
    // Low along the runway: shows the airfield graded flat into the terrain (V3).
    name: 'runway',
    dLat: 0,
    dLon: 0,
    altitude: 150,
    tilt: 78 * DEG,
    heading: 0,
    localTime: 16,
    target: 'airbase',
    alongRunway: true,
  },
  {
    // The observer camera at the main airbase's tower (V1): apron, hangars, runway.
    name: 'tower',
    dLat: 0,
    dLon: 0,
    altitude: 0,
    tilt: 0,
    heading: 0,
    localTime: 10,
    observer: true,
  },
  {
    name: 'tower-dusk',
    dLat: 0,
    dLon: 0,
    altitude: 0,
    tilt: 0,
    heading: 0,
    sunElevation: -1 * DEG,
    observer: true,
  },
  {
    // The simulation view's ceiling: 20 km over the check-1 landscape (frame-time budgets).
    name: 'ceiling',
    dLat: 0,
    dLon: 0,
    altitude: 20 * KM,
    tilt: 75 * DEG,
    heading: 0,
    localTime: 10.5,
    target: 'mixed',
    sunHeading: 140 * DEG,
    detail: true,
  },
  // The sky through the day's edge, from the tower (decision 140): into the sun and away from it.
  {
    name: 'sunrise',
    ...TOWER,
    sunElevation: 1 * DEG,
    morning: true,
    face: 'sun',
    pitch: 9 * DEG,
  },
  { name: 'golden', ...TOWER, sunElevation: 5 * DEG, face: 'sun', pitch: 9 * DEG },
  { name: 'golden-away', ...TOWER, sunElevation: 5 * DEG, face: 'antisun', pitch: 9 * DEG },
  { name: 'twilight6', ...TOWER, sunElevation: -6 * DEG, face: 'sun', pitch: 12 * DEG },
  { name: 'twilight6-away', ...TOWER, sunElevation: -6 * DEG, face: 'antisun', pitch: 12 * DEG },
  { name: 'twilight12', ...TOWER, sunElevation: -12 * DEG, face: 'sun', pitch: 12 * DEG },
  // A full-moon night with the moon in view, and a new-moon night under the stars.
  { name: 'moonlit', ...TOWER, localTime: 19.5, moonAge: 14.77, face: 'moon', pitch: 12 * DEG },
  { name: 'stars', ...TOWER, localTime: 23.5, moonAge: 0, face: 'antisun', pitch: 16 * DEG },
  {
    // The highest range under a full moon, far from any settlement's lights: moonlight alone.
    name: 'moonlit-range',
    dLat: 0,
    dLon: 0,
    altitude: 12 * KM,
    tilt: 80 * DEG,
    heading: 0,
    sunElevation: -30 * DEG,
    moonAge: 14.77,
    target: 'peak',
    sunHeading: 80 * DEG,
  },
  {
    // Settlement and road lights at night, over the largest city.
    name: 'night',
    dLat: 0,
    dLon: 0,
    altitude: 6 * KM,
    tilt: 65 * DEG,
    heading: 0,
    localTime: 23,
    target: 'city',
  },
];

/**
 * Strategic previews (SCENE=strategic): one view per zoom band and the Part II
 * acceptance checks (decision 93). `globe` is check 1 (the Globe band with the
 * terminator, night lights and weather); every view feeds check 4 with CVD=1; `sharp`
 * is check 5 (the floor at 1920 × 1080). The old orbit, limb and terminator views of
 * the single renderer live here now.
 */
export const STRATEGIC_PREVIEW_VIEWS: PreviewView[] = [
  { name: 'globe', dLat: 0, dLon: 0, altitude: 3000 * KM, tilt: 0, heading: 0, localTime: 18.5 },
  { name: 'night', dLat: 0, dLon: 0, altitude: 3000 * KM, tilt: 0, heading: 0, localTime: 22 },
  { name: 'theater', dLat: 0, dLon: 0, altitude: 900 * KM, tilt: 0, heading: 0, localTime: 11 },
  {
    name: 'region',
    dLat: 0,
    dLon: 0,
    altitude: 250 * KM,
    tilt: 0,
    heading: 30 * DEG,
    localTime: 10,
  },
  { name: 'floor', dLat: 0, dLon: 0, altitude: 100 * KM, tilt: 0, heading: 0, localTime: 11 },
  // The military overlays (decision 101) at the Theater band, centered on the first front.
  // Settlements and infrastructure (decision 104) round the Alliance capital: the
  // Theater band's cities, motorways and airbases, and the Region band's roads,
  // railways, bridges and symbols.
  {
    name: 'cities',
    dLat: 0,
    dLon: 0,
    altitude: 700 * KM,
    tilt: 0,
    heading: 0,
    localTime: 11,
    target: 'capital',
  },
  {
    name: 'capital',
    dLat: 0,
    dLon: 0,
    altitude: 150 * KM,
    tilt: 0,
    heading: 0,
    localTime: 11,
    target: 'capital',
  },
  {
    name: 'front',
    dLat: 0,
    dLon: 0,
    altitude: 1100 * KM,
    tilt: 0,
    heading: 0,
    localTime: 11,
    target: 'front',
  },
  // The air war (C2): flights, trails and carriers over the first front a day into the war.
  {
    name: 'air',
    dLat: 0,
    dLon: 0,
    altitude: 900 * KM,
    tilt: 0,
    heading: 0,
    localTime: 14,
    day: 1,
    target: 'front',
  },
  {
    name: 'winter',
    dLat: 0,
    dLon: 0,
    altitude: 1500 * KM,
    tilt: 0,
    heading: 0,
    localTime: 12,
    day: 150,
  },
  {
    name: 'sharp',
    dLat: 0,
    dLon: 0,
    altitude: 100 * KM,
    tilt: 0,
    heading: 0,
    localTime: 14,
    width: 1920,
    height: 1080,
  },
];

/** Draw statistics for PERF lines: visible meshes and triangles per scene group, and layer counts. */
function drawStats(scene: GlobeScene): string {
  const names = new Map<unknown, string>([
    [scene.terrain.group, 'terrain'],
    [scene.forest.group, 'trees'],
    [scene.structures.group, 'buildings'],
    [scene.clouds.group, 'clouds'],
    [scene.strategic.group, 'overlay'],
    [scene.globe.group, 'grid'],
  ]);
  const groups = scene.scene.children
    .map((g) => {
      let n = 0;
      let tris = 0;
      g.traverseVisible((o) => {
        const m = o as unknown as {
          isMesh?: boolean;
          geometry?: {
            index?: { count: number } | null;
            instanceCount?: number;
            attributes: Record<string, { count: number; isInstancedBufferAttribute?: boolean }>;
          };
        };
        if (!m.isMesh || !m.geometry) return;
        n++;
        const g = m.geometry;
        // Indexed or not; instanced geometry draws its instance attributes' count
        // unless instanceCount limits it (three's default is Infinity).
        const vertices = g.index?.count ?? g.attributes.position?.count ?? 0;
        let instances = 1;
        for (const a of Object.values(g.attributes))
          if (a.isInstancedBufferAttribute) instances = a.count;
        if (Number.isFinite(g.instanceCount)) instances = Math.min(instances, g.instanceCount!);
        tris += (vertices / 3) * instances;
      });
      return n ? `${names.get(g) ?? g.type} ${n} draws ${(tris / 1e6).toFixed(2)} M tris` : '';
    })
    .filter(Boolean)
    .join(', ');
  return `${groups}; deepest L${scene.terrain.stats.deepest}, ${scene.forest.stats.instances} tree clumps, ${scene.structures.stats.instances} buildings`;
}

const env = (k: string, d: string) => process.env[k] ?? d;

it('renders preview views', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No WebGPU adapter (Dawn) available');
  const seed = Number(env('SEED', '1983'));
  const tres = Number(env('TRES', '256'));
  const gres = Number(env('GRES', '1024'));
  const width = Number(env('W', '1024'));
  const height = Number(env('H', '576'));
  const exaggeration = Number(env('EX', '1'));
  const wanted = env('VIEWS', '');
  const strategic = env('SCENE', 'sim') === 'strategic';
  const views = (strategic ? STRATEGIC_PREVIEW_VIEWS : PREVIEW_VIEWS).filter(
    (v) =>
      !wanted ||
      wanted.split(',').includes(v.name) ||
      (wanted.split(',').includes('checks') && v.check !== undefined),
  );

  // The campaign world first: the global pass uses the seed that passed the validity check.
  const campaign = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed });
  const params = { ...DEFAULT_PLANET_PARAMS, seed: campaign.seed };
  const { world, global } = await previewWorld(gpu, params, tres, gres);
  const infra = new InfraScene(campaign.graph, campaign.infrastructure, params.radius);

  if (strategic) {
    await renderStrategic(gpu, {
      world,
      global,
      campaign,
      params,
      seed,
      width,
      height,
      views,
    });
    return;
  }
  // The app antialiases with four samples (`antialias: true`); the previews draw one unless asked.
  const head = await headlessRenderer(gpu.device, width, height, Number(process.env.MSAA ?? 0));
  const scene = new GlobeScene(head.renderer, {
    radius: params.radius,
    grid: new CubeGrid(tres),
    input: false,
  });
  scene.resize(width, height);
  // POST=0 draws directly, without the post-processing pipeline; BLOOM=0, GRAIN=0 (grain and
  // dither) and GRADE_TOD=0 (time-of-day grade) leave single stages out. VOLTEST=1 puts a
  // test height fog through the volumetric path (VOLSCALE sets its resolution, default 1/3;
  // VOLDENSITY its extinction at sea level, 1/m).
  scene.postEnabled = process.env.POST !== '0';
  if (scene.pipeline) {
    const pipeline = scene.pipeline;
    pipeline.bloom = process.env.BLOOM !== '0';
    pipeline.grain = pipeline.dither = process.env.GRAIN !== '0';
    pipeline.grading = process.env.GRADE_TOD !== '0';
    if (process.env.VOLSCALE) pipeline.volumetricScale = Number(process.env.VOLSCALE);
    if (process.env.VOLTEST === '1') {
      pipeline.volumetrics = heightFogTestSource({
        eye: scene.lighting.eye,
        radius: params.radius,
        density: process.env.VOLDENSITY ? Number(process.env.VOLDENSITY) : undefined,
      });
    }
  }
  scene.globe.setWorld(world);
  scene.climate.setWorld(world);
  // The valley floor, as the app sets it once the global pass is done (decision 122).
  scene.climate.setValleyFloor(global.finish.display.valleyFloor ?? null, world.maps.height);
  scene.globe.setExaggeration(exaggeration);
  scene.terrain.setExaggeration(exaggeration);
  scene.terrain.buildBudgetMs = 10_000;
  scene.terrain.budgetMiB = 600; // the app's default (GUI → Tile memory)
  const riverIndex = new RiverIndex(global.finish.rivers, {
    height: global.height,
    radius: params.radius,
  });
  const synth = new TileSynthesizer(global.grid, {
    seed: params.seed,
    reliefScale: params.reliefScale,
    radius: params.radius,
    biome: global.finish.biome,
    lakeDepth: global.finish.drainage.lakeDepth,
    height: global.height,
    forest: global.finish.forest,
    treeline: global.finish.treeline,
    index: riverIndex,
  });
  scene.terrain.setWorld({
    synth,
    seed: params.seed,
    radius: params.radius,
    reliefScale: params.reliefScale,
    rivers: riverIndex,
    infra,
    // GRADE=0 leaves the airfields ungraded, for comparison.
    grading:
      process.env.GRADE === '0' ? undefined : airfieldGrading(infra, global.height, global.n),
  });
  scene.setInfrastructure(infra);
  scene.terrainReady = true;
  // Mountain shadows (decision 139) from the global heights; SHADOW=0 leaves them out.
  // SPARKLE=0 leaves the snow's glints out; WET=x (0..1) wets the ground whatever the weather.
  if (process.env.SHADOW !== '0') scene.shadows.setHeights(global.height, global.n);
  if (process.env.SPARKLE === '0') scene.terrain.land.sparkle.value = 0;
  // SKY_LIGHT=x sets the sky light on surfaces (PlanetLighting.skyLight): the fill in the shadows.
  if (process.env.SKY_LIGHT) scene.lighting.skyLight.value = Number(process.env.SKY_LIGHT);
  // DAYLIGHT=x sets the sun's illuminance by day (PlanetLighting.daylight, default 1.4): the exposure.
  if (process.env.DAYLIGHT) scene.lighting.daylight = Number(process.env.DAYLIGHT);
  // LOW_SUN_EXPOSURE=x sets the exposure of lit surfaces over the sky's under a low sun
  // (PlanetLighting.lowSunExposure, default 1.7; 1 exposes the ground as the sky).
  if (process.env.LOW_SUN_EXPOSURE) {
    scene.lighting.lowSunExposure = Number(process.env.LOW_SUN_EXPOSURE);
  }
  // SKY_LEAN=x sets how far the sky's light leans toward the sun (PlanetLighting.skyLean).
  if (process.env.SKY_LEAN) scene.lighting.skyLean.value = Number(process.env.SKY_LEAN);
  // HAZE=x sets the clear-air haze in front of surfaces (AtmosphereNodes.haze; 1 = all of the
  // in-scattered light), LOW_SUN_FILL=x the sky light's gain under a low sun and VIBRANCE=x the
  // sky's saturation around sunset (PlanetLighting.lowSunFill, sunsetVibrance; decision 140).
  if (process.env.HAZE) scene.lighting.atmosphere.haze.value = Number(process.env.HAZE);
  if (process.env.LOW_SUN_FILL) scene.lighting.lowSunFill = Number(process.env.LOW_SUN_FILL);
  if (process.env.VIBRANCE) scene.lighting.sunsetVibrance = Number(process.env.VIBRANCE);
  // LIGHTS=0 puts the settlements' and roads' night glow out, to judge moonlight on its own.
  if (process.env.LIGHTS === '0') scene.terrain.roadStyle.lights.value = 0;
  if (process.env.WET) {
    const state = scene.weatherState;
    const update = state.update.bind(state);
    state.update = (...a: Parameters<typeof update>) => {
      update(...a);
      state.wetness.value = Number(process.env.WET);
    };
  }

  const main = new Vec3d(...world.info.mainContinent);
  const lat0 = Math.asin(main.y);
  const lon0 = Math.atan2(main.x, main.z);
  const calendar = defaultCampaignStart(main, params);
  // Live weather from the sim (decision 68), replayed to each view's time.
  const climate = buildWeatherClimate(
    { ...world.maps, resolution: world.info.resolution, reliefScale: world.info.reliefScale },
    new WeatherGrid(),
    params.radius,
  );
  const weatherConfig = {
    seed: params.seed,
    radius: params.radius,
    orbit: params,
    calendar,
    climate,
  };
  let simWorld = createSimWorld(weatherConfig);
  const weatherAt = (t: number) => {
    if (t < simWorld.sim.time) simWorld = createSimWorld(weatherConfig);
    simWorld.sim.advanceTo(t);
    const view = simWorld.weather.view();
    scene.weather.setFrames(view);
    scene.weather.update(view, t);
  };

  // Targets: the deepest lake away from the ice caps, and dense forest near the main continent.
  const n = global.n;
  const lakeDepth = global.finish.drainage.lakeDepth;
  const forestMap = global.finish.forest;
  const cellDir = new Vec3d();
  const sp = campaign.graph.settlements;
  let biggest = 0;
  for (let i = 1; i < sp.cells.length; i++)
    if (sp.population[i]! > sp.population[biggest]!) biggest = i;
  const base = campaign.infrastructure.airbases.find((a) => a.kind === 'main');
  // Check targets (decision 128); tiles judge the conifer candidates only when a view needs them.
  const needsTiles = views.some((v) => v.target === 'conifer');
  const { notes: checkNotes, ...checks } = await findCheckTargets(
    global,
    campaign.graph,
    main,
    params.radius,
    needsTiles ? synth : undefined,
  );
  for (const note of checkNotes) console.log(note);
  const targets: Record<NonNullable<PreviewView['target']>, Vec3d | null> = {
    front: null, // strategic previews only
    capital: null,
    lake: null,
    forest: null,
    peak: null,
    farmland: null,
    ...checks,
    city: sp.cells.length ? new Vec3d(...settlementPoint(sp, biggest)) : null,
    airbase: base ? new Vec3d(...base.point) : null,
  };
  let deepest = 0;
  let nearest = -2;
  let highest = 0;
  for (let c = 0; c < lakeDepth.length; c++) {
    const lakeCandidate = lakeDepth[c]! > deepest;
    const forestCandidate = forestMap[c]! > 220 && global.height[c]! > 30;
    const peakCandidate = global.height[c]! > highest;
    if (!lakeCandidate && !forestCandidate && !peakCandidate) continue;
    const face = Math.floor(c / (n * n)) as CubeFace;
    cubeFaceUvToDirection(face, ((c % n) + 0.5) / n, ((Math.floor(c / n) % n) + 0.5) / n, cellDir);
    if (lakeCandidate && Math.abs(cellDir.y) < Math.sin(55 * DEG)) {
      deepest = lakeDepth[c]!;
      targets.lake = cellDir.clone();
    }
    // Within about 600 km of the main continent, away from the ice caps.
    if (
      peakCandidate &&
      cellDir.dot(main) > Math.cos((600 * KM) / params.radius) &&
      Math.abs(cellDir.y) < 0.8
    ) {
      highest = global.height[c]!;
      targets.peak = cellDir.clone();
    }
    if (forestCandidate && cellDir.dot(main) > nearest) {
      nearest = cellDir.dot(main);
      targets.forest = cellDir.clone();
    }
  }
  // Farmland (decision 127): the most settled cell of the coarse habitability map within
  // about 600 km of the main continent whose global cell is open, low, farmable land.
  {
    const m = infra.habitabilityResolution;
    let best = 0;
    for (let h = 0; h < infra.habitability.length; h++) {
      if (infra.habitability[h]! <= best) continue;
      const face = Math.floor(h / (m * m)) as CubeFace;
      cubeFaceUvToDirection(
        face,
        ((h % m) + 0.5) / m,
        ((Math.floor(h / m) % m) + 0.5) / m,
        cellDir,
      );
      if (cellDir.dot(main) < Math.cos((600 * KM) / params.radius)) continue;
      const uv = directionToCubeFace(cellDir);
      const g =
        uv.face * n * n +
        Math.min(n - 1, Math.floor(uv.v * n)) * n +
        Math.min(n - 1, Math.floor(uv.u * n));
      const open = forestMap[g]! < 80 && global.height[g]! > 5 && global.height[g]! < 800;
      if (!open || !FARMABLE_BIOMES.has(global.finish.biome[g]!)) continue;
      best = infra.habitability[h]!;
      targets.farmland = cellDir.clone();
    }
  }
  // OUT=dir writes the images there instead of tools/out (several sessions rendering at once).
  const outDir = process.env.OUT ?? join(import.meta.dirname, 'out');
  mkdirSync(outDir, { recursive: true });

  const stations = observerStations(campaign.infrastructure, params.radius);
  // SPOTS=all or a comma list of landscape kinds: observer views at landscape spots.
  if (process.env.SPOTS) {
    const kinds =
      process.env.SPOTS === 'all'
        ? [...SPOT_KINDS]
        : (process.env.SPOTS.split(',') as (typeof SPOT_KINDS)[number][]);
    // The sun's compass azimuth at a spot at the spot views' local time, for framing.
    const spotHour = Number(process.env.SPOT_TIME ?? 15.5);
    const sunAzimuth = (p: Readonly<Vec3d>) => {
      const lon = Math.atan2(p.x, p.z);
      let at = withLocalTime(0, lon, spotHour * HOUR, params, calendar);
      if (at < 0) at = withLocalTime(DAY, lon, spotHour * HOUR, params, calendar);
      const sun = sunDirection(at, params, calendar, new Vec3d());
      const east = new Vec3d(0, 1, 0).cross(p).normalize();
      const north = p.clone().cross(east);
      return Math.atan2(sun.dot(east), sun.dot(north));
    };
    // Framing reads synthesized level-6 tiles (about 100 m samples) around each spot.
    const prepare = async (center: Readonly<Vec3d>, radiusM: number) => {
      const level = 6;
      const keys = new Map<string, TileKey>();
      const east = new Vec3d(0, 1, 0).cross(center).normalize();
      const north = center.clone().cross(east);
      for (let y = -radiusM; y <= radiusM; y += 4000) {
        for (let x = -radiusM; x <= radiusM; x += 4000) {
          const d = center
            .clone()
            .addScaled(east, x / params.radius)
            .addScaled(north, y / params.radius)
            .normalize();
          const k = tileForDirection(d, level);
          keys.set(tileKeyString(k), k);
        }
      }
      const tiles = new Map<string, TileData>();
      for (const t of await synth.generate([...keys.values()])) tiles.set(tileKeyString(t.key), t);
      const uv = { face: 0, u: 0, v: 0 } as ReturnType<typeof directionToCubeFace>;
      return (d: Readonly<Vec3d>) => {
        const k = tileForDirection(d, level);
        const t = tiles.get(tileKeyString(k));
        if (!t) return 0;
        directionToCubeFace(d, uv);
        const size = TILE_TEXELS * (1 << level);
        const sx = Math.min(TILE_TEXELS, Math.max(0, Math.round(uv.u * size - k.x * TILE_TEXELS)));
        const sy = Math.min(TILE_TEXELS, Math.max(0, Math.round(uv.v * size - k.y * TILE_TEXELS)));
        return t.height[(sy + TILE_BORDER) * TILE_STRIDE + sx + TILE_BORDER]!;
      };
    };
    const spots = await findSpots(global, params.radius, sunAzimuth, prepare);
    for (const k of kinds) {
      const spot = spots.get(k);
      if (!spot) {
        console.log(`spot ${k}: none in this world`);
        continue;
      }
      const lat = Math.asin(spot.point.y) / DEG;
      const lon = Math.atan2(spot.point.x, spot.point.z) / DEG;
      console.log(
        `spot ${k}: ${lat.toFixed(3)}, ${lon.toFixed(3)} facing ${(spot.facing / DEG).toFixed(0)}° at ${spot.height.toFixed(0)} m (${spot.note})`,
      );
      views.push({
        name: `spot-${k}`,
        dLat: 0,
        dLon: 0,
        altitude: 0,
        tilt: 0,
        heading: 0,
        localTime: Number(process.env.SPOT_TIME ?? 15.5),
        spot,
      });
    }
  }
  for (const listed of views) {
    // ALT (m) and TILT (deg) override a view's altitude and tilt.
    const view: PreviewView = {
      ...listed,
      altitude: process.env.ALT ? Number(process.env.ALT) : listed.altitude,
      tilt: process.env.TILT ? Number(process.env.TILT) * DEG : listed.tilt,
    };
    const target = view.target ? targets[view.target] : null;
    // Midwinter: about 150 days after the campaign's mid-August start in the main
    // continent's hemisphere, mid-July of the next year in the other.
    const v =
      view.midwinter && target
        ? { ...view, day: Math.sign(target.y) === Math.sign(main.y) ? 150 : 335 }
        : view;
    const o = scene.orbit;
    if (target && v.alongRunway && base) {
      // Back from the runway's threshold, looking down it.
      const back = v.altitude * Math.tan(Math.min(v.tilt, 70 * DEG));
      const p = offsetPoint(target, base.heading, -base.runwayLength / 2 - back, 0, params.radius);
      o.lat = Math.asin(p.y);
      o.lon = Math.atan2(p.x, p.z);
    } else if (target) {
      // Stand back from the target, south of it, looking north.
      o.lat =
        Math.asin(target.y) - (v.altitude * Math.tan(Math.min(v.tilt, 70 * DEG))) / params.radius;
      o.lon = Math.atan2(target.x, target.z);
    } else {
      o.lat = lat0 + v.dLat;
      o.lon = lon0 + v.dLon;
    }
    o.altitude = o.targetAltitude = v.altitude;
    o.tilt = v.tilt;
    o.heading = v.alongRunway && base ? base.heading : v.heading;
    const station = v.spot
      ? {
          key: `spot-${v.spot.kind}`,
          label: v.spot.kind,
          kind: 'port' as const,
          side: 'alliance' as const,
          point: v.spot.point,
          facing: v.spot.facing,
          height: v.spot.height,
          pitch: v.spot.pitch,
        }
      : v.observer && base
        ? stations.find((x) => x.key === `airbase-${base.id}`)
        : null;
    if (station) {
      // OBS_HEIGHT (m above the ground) and OBS_PITCH (deg) override the station's;
      // OBS_HEADING (deg, or 'sun' to face the sun's azimuth) is applied once the sun is set.
      const env = process.env;
      scene.observer.setStation({
        ...station,
        height: env.OBS_HEIGHT ? Number(env.OBS_HEIGHT) : (v.eyeHeight ?? station.height),
        pitch: env.OBS_PITCH ? Number(env.OBS_PITCH) * DEG : (v.pitch ?? station.pitch),
      });
      // OBS_LAT and OBS_LON (deg) move the observer from the station to that spot.
      if (env.OBS_LAT && env.OBS_LON) {
        scene.observer.spot.copy(
          latLonToDirection(Number(env.OBS_LAT) * DEG, Number(env.OBS_LON) * DEG),
        );
      }
      // The clock and the sun follow the observer's spot.
      o.lat = scene.observer.lat;
      o.lon = scene.observer.lon;
    }
    scene.cameraMode = station ? 'observer' : 'free';
    const localAt = (day: number) =>
      withLocalTime(day * DAY, o.lon, (v.localTime ?? 11) * HOUR, params, calendar);
    // MOON_AGE (days; 0 new, 14.8 full) or the view's moonAge moves the view to the day, of the
    // month from its own on, whose moon at the view's time comes closest.
    const wantedAge = process.env.MOON_AGE ? Number(process.env.MOON_AGE) : v.moonAge;
    let day = v.day ?? 0;
    if (wantedAge !== undefined) {
      let best = Infinity;
      for (let d = v.day ?? 0; d < (v.day ?? 0) + 30; d++) {
        const off = Math.abs(moonAge(Math.max(0, localAt(d)), params, calendar) - wantedAge);
        const miss = Math.min(off, SYNODIC_MONTH_DAYS - off);
        if (miss < best) {
          best = miss;
          day = d;
        }
      }
    }
    // The sim starts at campaign start: an early local time on day 0 can fall before it.
    let t = localAt(day);
    if (t < 0) t = localAt(day + 1);
    // SUN_EL (deg) overrides the view's sun elevation; MORNING=1 takes the morning's.
    const wantedElevation = process.env.SUN_EL ? Number(process.env.SUN_EL) * DEG : v.sunElevation;
    if (wantedElevation !== undefined) {
      // Step through the afternoon and evening until the sun sinks to the elevation
      // (back through the morning for the rising sun).
      const morning = process.env.MORNING ? process.env.MORNING === '1' : v.morning === true;
      const up = latLonToDirection(o.lat, o.lon);
      const sun = new Vec3d();
      for (let k = 0; k < 12 * 60; k++) {
        const h = morning ? 12 - k / 60 : 12 + k / 60;
        let at = withLocalTime(day * DAY, o.lon, h * HOUR, params, calendar);
        if (at < 0) at = withLocalTime(day * DAY + DAY, o.lon, h * HOUR, params, calendar);
        if (sunDirection(at, params, calendar, sun).dot(up) < Math.sin(wantedElevation)) {
          t = at;
          break;
        }
      }
      const el = Math.asin(sunDirection(t, params, calendar, sun).dot(up)) / DEG;
      console.log(
        `${v.name}: sun at ${el.toFixed(1)}° (wanted ${(wantedElevation / DEG).toFixed(1)}°)`,
      );
    }
    // The moon and the stars follow the game time (decision 140).
    scene.gameTime = t;
    scene.planetOrbit = params;
    scene.calendar = calendar;
    {
      const up = latLonToDirection(o.lat, o.lon);
      const moon = moonDirection(t, params, calendar);
      const sun = sunDirection(t, params, calendar, new Vec3d());
      console.log(
        `${v.name}: sun ${(Math.asin(sun.dot(up)) / DEG).toFixed(1)}° up, ` +
          `moon ${moonAge(t, params, calendar).toFixed(1)} days old, ` +
          `${(Math.asin(moon.dot(up)) / DEG).toFixed(1)}° up`,
      );
    }
    sunDirection(t, params, calendar, scene.sun);
    // SUN_HEADING (deg) overrides a view's facing relative to the sun (0 looks into it).
    const sunHeading = process.env.SUN_HEADING
      ? Number(process.env.SUN_HEADING) * DEG
      : v.sunHeading;
    if (target && sunHeading !== undefined && !station) {
      // Face relative to the sun's azimuth at the target, standing back along that heading.
      const east = new Vec3d(0, 1, 0).cross(target).normalize();
      const north = target.clone().cross(east);
      o.heading = Math.atan2(scene.sun.dot(east), scene.sun.dot(north)) + sunHeading;
      const back = v.altitude * Math.tan(Math.min(v.tilt, 70 * DEG));
      const p = offsetPoint(target, o.heading, -back, 0, params.radius);
      o.lat = Math.asin(p.y);
      o.lon = Math.atan2(p.x, p.z);
      console.log(
        `${v.name}: target ${(Math.asin(target.y) / DEG).toFixed(3)}, ${(Math.atan2(target.x, target.z) / DEG).toFixed(3)}, heading ${(o.heading / DEG).toFixed(0)}°`,
      );
    }
    if (station && (process.env.OBS_HEADING || v.face)) {
      const h = process.env.OBS_HEADING ?? v.face!;
      if (h === 'sun' || h === 'moon' || h === 'antisun') {
        // Compass azimuth of the body at the spot: atan2(east, north) of its tangential part.
        const up = scene.observer.spot;
        const east = new Vec3d(0, 1, 0).cross(up).normalize();
        const north = up.clone().cross(east);
        const body = h === 'moon' ? moonDirection(t, params, calendar) : scene.sun;
        scene.observer.heading =
          Math.atan2(body.dot(east), body.dot(north)) + (h === 'antisun' ? Math.PI : 0);
      } else {
        scene.observer.heading = Number(h) * DEG;
      }
    }
    scene.terrain.land.seasonPhase.value = seasonPhase(t, params, calendar);
    // HOURS shifts only the clouds' clock (to see them move with the sun held fixed).
    const cloudTime = t + Number(process.env.HOURS ?? 0) * HOUR;
    scene.clouds.time.value = cloudTime;
    weatherAt(cloudTime);
    scene.clouds.enabled.value = process.env.CLOUDS === '0' ? 0 : 1;
    // RIVERS=x sets how strongly sub-pixel rivers are drawn (0 = their true pixel fraction).
    if (process.env.RIVERS) scene.terrain.riverStyle.legibility.value = Number(process.env.RIVERS);
    // FACETS=0 shades the terrain smoothly, to compare with the flat facets (decision 123).
    scene.terrain.land.facets.value = process.env.FACETS === '0' ? 0 : 1;
    // TEMP_OFFSET (°C) shifts every surface temperature: −30 puts snow on most ground.
    if (process.env.TEMP_OFFSET) {
      scene.terrain.land.temperatureOffset.value = Number(process.env.TEMP_OFFSET);
    }
    // FARMLAND=0 leaves the fields out (decision 127).
    scene.terrain.land.farmland.value = process.env.FARMLAND === '0' ? 0 : 1;
    // DETAIL=1 adds the instanced trees and buildings (off in the strategic view, decision 71).
    // A view's own detail flag turns them on unless DETAIL=0.
    scene.forest.enabled = scene.structures.enabled =
      process.env.DETAIL === '1' || (v.detail === true && process.env.DETAIL !== '0');
    // Render until the terrain has loaded everything this view wants.
    let stable = 0;
    let last = '';
    const t0 = performance.now();
    for (let f = 0; f < 400 && stable < 3; f++) {
      // The camera clamps to 2 km above the highest terrain until the ground under it
      // has loaded; ask for the view's altitude again every frame.
      o.altitude = o.targetAltitude = v.altitude;
      scene.render(0);
      await gpu.finish();
      await new Promise((r) => setTimeout(r, 2));
      const s = scene.terrain.stats;
      const sig = `${s.drawn}/${s.deepest}/${s.meshes}`;
      if (process.env.DEBUG) console.log(v.name, f, JSON.stringify(s), o.tilt, o.altitude);
      const treesPending =
        (scene.forest.group.visible ? scene.forest.stats.pending : 0) +
        (scene.structures.group.visible ? scene.structures.stats.pending : 0);
      stable = s.pending === 0 && treesPending === 0 && sig === last ? stable + 1 : 0;
      last = sig;
    }
    if (process.env.SHADOW_LIVE === '1') {
      // SHADOW_LIVE=1: the mountain shadows as the app bakes them, a pass per frame while the
      // view settled (and until the last grid is published), to compare with the bake in one go.
      let frames = 0;
      while (scene.shadows.busy && frames++ < 600) scene.render(1 / 60);
      for (let f = 0; f < 60; f++) scene.render(1 / 60);
      const st = scene.shadows.stats;
      console.log(
        `  shadows live: ${st.bakes} grids in ${st.passes} passes, ${st.sourceRows} rows of tile heights, ` +
          `${frames} more frames, strength ${scene.shadows.strength.value.toFixed(2)}`,
      );
    } else {
      // The mountain shadows in one go for the settled view; the app spreads the passes over frames.
      const e = scene.lighting.eye.value;
      scene.shadows.reset();
      scene.shadows.exaggeration = exaggeration;
      scene.shadows.bake(head.renderer, new Vec3d(e.x, e.y, e.z), scene.sun);
    }
    scene.render(0);
    // PERF=n: time n more frames of the loaded view (CPU in scene.render, and until the GPU is done).
    // FLICKER=n: n frames at 30 fps with the view turning slowly (as when dragging),
    // logging terrain statistics and the lower half's brightness per frame.
    const flicker = Number(process.env.FLICKER ?? 0);
    for (let f = 0; f < flicker; f++) {
      // FLICKER_TURN: radians per frame (default 0.004, about 7°/s).
      const turn = Number(process.env.FLICKER_TURN ?? 0.004);
      if (scene.cameraMode === 'observer') scene.observer.heading += turn;
      else o.heading += turn;
      // FLICKER_FORWARD (−1..1) moves the observer along the view, FLICKER_CLIMB (−1..1) climbs,
      // FLICKER_BOOST=1 moves five times faster;
      // PREFETCH=0 turns the terrain's prefetch off (decision 119), to compare.
      scene.observer.input.forward = Number(process.env.FLICKER_FORWARD ?? 0);
      scene.observer.input.climb = Number(process.env.FLICKER_CLIMB ?? 0);
      scene.observer.input.boost = process.env.FLICKER_BOOST === '1' ? 1 : 0;
      scene.terrain.prefetch.enabled = process.env.PREFETCH !== '0';
      scene.render(1 / 30);
      await gpu.finish();
      const px = await head.readRgb();
      let sum = 0;
      for (let i = (px.length / 2) | 0; i < px.length; i++) sum += px[i]!;
      const s = scene.terrain.stats;
      console.log(
        `  frame ${f}: lower mean ${(sum / (px.length / 2)).toFixed(1)}, drawn ${s.drawn}, visited ${s.visited}, deepest ${s.deepest}, meshes ${s.meshes}, data ${s.dataTiles}, pending ${s.pending}, generated ${s.generated}, waiting ${s.waiting}, bubble ${s.bubbleReady}/${s.bubble}, ahead ${s.ahead}`,
      );
    }
    const perfFrames = Number(process.env.PERF ?? 0);
    if (perfFrames > 0) {
      await gpu.finish();
      let cpu = 0;
      const p0 = performance.now();
      const parts: Record<string, number> = {};
      const wrap = (obj: Record<string, unknown>, name: string, label: string) => {
        const fn = obj[name] as (...a: unknown[]) => unknown;
        obj[name] = (...a: unknown[]) => {
          const q0 = performance.now();
          const r = fn.apply(obj, a);
          parts[label] = (parts[label] ?? 0) + performance.now() - q0;
          return r;
        };
        return () => (obj[name] = fn);
      };
      const unwrap = [
        wrap(scene.terrain as unknown as Record<string, unknown>, 'update', 'terrain'),
        wrap(scene.forest as unknown as Record<string, unknown>, 'update', 'forest'),
        wrap(scene.structures as unknown as Record<string, unknown>, 'update', 'buildings'),
        wrap(scene.strategic as unknown as Record<string, unknown>, 'update', 'strategic'),
        wrap(head.renderer as unknown as Record<string, unknown>, 'render', 'three'),
      ];
      const { Session } = await import('node:inspector/promises');
      const session = process.env.PROF ? new Session() : null;
      if (session) {
        session.connect();
        await session.post('Profiler.enable');
        await session.post('Profiler.start');
      }
      const frameCpu: number[] = [];
      for (let f = 0; f < perfFrames; f++) {
        const c0 = performance.now();
        scene.render(0);
        frameCpu.push(performance.now() - c0);
        cpu += frameCpu[f]!;
        await gpu.finish();
      }
      frameCpu.sort((a, b) => a - b);
      console.log(
        `  CPU per frame: median ${frameCpu[frameCpu.length >> 1]!.toFixed(1)} ms, max ${frameCpu[frameCpu.length - 1]!.toFixed(1)} ms`,
      );
      const wall = (performance.now() - p0) / perfFrames;
      if (session) {
        const { profile } = await session.post('Profiler.stop');
        writeFileSync(process.env.PROF!, JSON.stringify(profile));
        session.disconnect();
      }
      for (const u of unwrap) u();
      const counts: Record<string, number[]> = { river: [], road: [], light: [] };
      scene.terrain.group.traverseVisible((m) => {
        if (!(m as { isMesh?: boolean }).isMesh) return;
        for (const k of ['river', 'road', 'light'])
          counts[k]!.push(m.userData[`${k}Count`] as number);
      });
      console.log(
        '  loops per mesh (mean/max): ' +
          Object.entries(counts)
            .map(
              ([k, c]) =>
                `${k} ${(c.reduce((a, b) => a + b, 0) / Math.max(1, c.length)).toFixed(0)}/${Math.max(0, ...c)}`,
            )
            .join(', '),
      );
      console.log(
        '  CPU parts: ' +
          Object.entries(parts)
            .map(([k, ms]) => `${k} ${(ms / perfFrames).toFixed(1)}`)
            .join(', '),
      );
      console.log(
        `  perf ${v.name}: ${wall.toFixed(1)} ms/frame, CPU ${(cpu / perfFrames).toFixed(1)} ms, ` +
          drawStats(scene),
      );
    }
    // PERF_SKY=n: n rounds of the frame with the sky from its LUT and from the march per pixel
    // that it replaced (decision 140), interleaved; prints the median ms per frame of each.
    const skyRounds = Number(process.env.PERF_SKY ?? 0);
    if (skyRounds > 0) {
      const sky = scene.lighting.atmosphere.sky;
      const times: Record<string, number[]> = { lut: [], march: [] };
      for (let round = -1; round < skyRounds; round++) {
        for (const mode of ['lut', 'march'] as const) {
          sky.forceMarch = mode === 'march';
          scene.render(0);
          await gpu.finish();
          const q0 = performance.now();
          scene.render(0);
          await gpu.finish();
          // Round −1 compiles and bakes.
          if (round >= 0) times[mode]!.push(performance.now() - q0);
        }
      }
      sky.forceMarch = false;
      const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;
      console.log(
        `  sky ${v.name}: LUT ${median(times.lut!).toFixed(1)} ms/frame, march ${median(times.march!).toFixed(1)} ms/frame ` +
          `(medians of ${skyRounds}); ${sky.bakes} bakes so far`,
      );
      scene.render(0);
      await gpu.finish();
    }
    // PERF_POST=n: n rounds of the frame drawn directly, through the bare pipeline (every stage
    // off), through the pipeline as configured, and with the volumetric source on, interleaved
    // so that other load on the machine falls on all four alike. Prints the median ms per frame.
    const postRounds = Number(process.env.PERF_POST ?? 0);
    if (postRounds > 0 && scene.pipeline) {
      const pipeline = scene.pipeline;
      const saved = {
        post: scene.postEnabled,
        bloom: pipeline.bloom,
        grading: pipeline.grading,
        grain: pipeline.grain,
        dither: pipeline.dither,
        volumetrics: pipeline.volumetricsEnabled,
      };
      pipeline.volumetrics ??= heightFogTestSource({
        eye: scene.lighting.eye,
        radius: params.radius,
      });
      const stages = (on: boolean) => {
        pipeline.bloom = on && saved.bloom;
        pipeline.grading = on && saved.grading;
        pipeline.grain = on && saved.grain;
        pipeline.dither = on && saved.dither;
      };
      const modes: [string, () => void][] = [
        ['direct', () => (scene.postEnabled = false)],
        [
          'bare',
          () => ((scene.postEnabled = true), stages(false), (pipeline.volumetricsEnabled = false)),
        ],
        ['pipeline', () => (stages(true), (pipeline.volumetricsEnabled = false))],
        ['volumetric', () => (pipeline.volumetricsEnabled = true)],
      ];
      const times: Record<string, number[]> = {};
      for (let round = -1; round < postRounds; round++) {
        for (const [name, set] of modes) {
          set();
          scene.render(0);
          await gpu.finish();
          const q0 = performance.now();
          scene.render(0);
          await gpu.finish();
          // Round −1 compiles each mode's shaders.
          if (round >= 0) (times[name] ??= []).push(performance.now() - q0);
        }
      }
      const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;
      console.log(
        `  post ${v.name}: ` +
          modes
            .map(
              ([name]) =>
                `${name} ${median(times[name]!).toFixed(1)} (least ${Math.min(...times[name]!).toFixed(1)})`,
            )
            .join(', ') +
          ` ms/frame (median of ${postRounds}); passes ${pipeline.stats.passes}, targets ${pipeline.stats.targets}`,
      );
      scene.postEnabled = saved.post;
      stages(true);
      pipeline.volumetricsEnabled = saved.volumetrics;
      if (process.env.VOLTEST !== '1') pipeline.volumetrics = null;
      scene.render(0);
      await gpu.finish();
    }
    // PERF_SHADOW=n: n rounds of the frame without the mountain shadows' lookup and the snow's
    // glints, with the lookup, and with both, interleaved like PERF_POST. Nothing is baked
    // meanwhile (the view is still), so this is the cost per shaded fragment.
    const shadowRounds = Number(process.env.PERF_SHADOW ?? 0);
    if (shadowRounds > 0) {
      const land = scene.terrain.land;
      const modes: [string, () => void][] = [
        ['neither', () => ((scene.shadows.enabled = false), (land.sparkle.value = 0))],
        ['shadows', () => ((scene.shadows.enabled = true), (land.sparkle.value = 0))],
        ['shadows and sparkle', () => ((scene.shadows.enabled = true), (land.sparkle.value = 1))],
      ];
      const times: Record<string, number[]> = {};
      for (let round = -1; round < shadowRounds; round++) {
        for (const [name, set] of modes) {
          set();
          scene.render(0);
          await gpu.finish();
          const q0 = performance.now();
          scene.render(0);
          await gpu.finish();
          if (round >= 0) (times[name] ??= []).push(performance.now() - q0);
        }
      }
      const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;
      console.log(
        `  shadow ${v.name}: ` +
          modes
            .map(
              ([name]) =>
                `${name} ${median(times[name]!).toFixed(1)} (least ${Math.min(...times[name]!).toFixed(1)})`,
            )
            .join(', ') +
          ` ms/frame (median of ${shadowRounds}); strength ${scene.shadows.strength.value.toFixed(2)}, bake passes ${scene.shadows.stats.passes}`,
      );
      land.sparkle.value = process.env.SPARKLE === '0' ? 0 : 1;
      scene.render(0);
      await gpu.finish();
    }
    const rgb = await head.readRgb();
    const ungraded = process.env.GRADE === '0' ? '-ungraded' : '';
    const smooth = process.env.FACETS === '0' ? '-smooth' : '';
    const file = join(outDir, `render-${seed}-${v.name}${ungraded}${smooth}.png`);
    writeFileSync(file, encodePng(width, height, rgb));
    const s = scene.terrain.stats;
    if (process.env.DEBUG) {
      let withRivers = 0;
      let total = 0;
      scene.terrain.group.traverse((m) => {
        if (!m.visible || !(m as { isMesh?: boolean }).isMesh) return;
        total++;
        if ((m.userData.riverCount as number) > 0) withRivers++;
      });
      console.log(`  meshes ${total}, with rivers ${withRivers}`);
    }
    if (scene.structures.stats.instances) {
      console.log(`  buildings: ${scene.structures.stats.instances}`);
    }
    if (scene.forest.stats.instances) {
      console.log(
        `  trees: ${scene.forest.stats.tiles} tiles, ${scene.forest.stats.instances} clumps`,
      );
    }
    console.log(
      `${v.name}: ${s.drawn} tiles, deepest ${s.deepest}, ${((performance.now() - t0) / 1000).toFixed(1)} s → ${file}`,
    );
  }
  if (gpu.errors.length) throw new Error(`GPU errors: ${gpu.errors.join(' | ')}`);
  scene.dispose();
  synth.dispose();
  global.grid.dispose();
  head.dispose();
});

/**
 * SCENE=strategic: the strategic view's scene from STRATEGIC_PREVIEW_VIEWS, with clouds
 * from the sim's weather, tile counts and frame times, and (CVD=1) the same images as
 * seen with protanopia, deuteranopia and tritanopia (acceptance check 4).
 */
async function renderStrategic(
  gpu: NonNullable<Awaited<ReturnType<typeof testGpu>>>,
  o: {
    world: Awaited<ReturnType<typeof previewWorld>>['world'];
    global: Awaited<ReturnType<typeof previewWorld>>['global'];
    campaign: ReturnType<typeof generateCampaignWorld>;
    params: typeof DEFAULT_PLANET_PARAMS;
    seed: number;
    width: number;
    height: number;
    views: PreviewView[];
  },
): Promise<void> {
  const { world, global, campaign, params } = o;
  const cvd = process.env.CVD === '1';
  const d = global.finish.display;
  let maxHeight = -Infinity;
  for (const h of d.height) maxHeight = Math.max(maxHeight, h);
  const displayWorld = {
    maps: {
      ...world.maps,
      height: d.height,
      biome: d.biome,
      discharge: d.discharge,
      lakeDepth: d.lakeDepth,
    },
    info: { ...world.info, maxHeight },
  };
  const riverIndex = new RiverIndex(global.finish.rivers, {
    height: global.height,
    radius: params.radius,
  });
  // The relief mesh (decision 77) from the same synthesizer as the terrain.
  const synth = new TileSynthesizer(global.grid, {
    seed: params.seed,
    reliefScale: params.reliefScale,
    radius: params.radius,
    biome: global.finish.biome,
    lakeDepth: global.finish.drainage.lakeDepth,
    height: global.height,
    forest: global.finish.forest,
    treeline: global.finish.treeline,
    index: riverIndex,
  });
  const main = new Vec3d(...world.info.mainContinent);
  const lat0 = Math.asin(main.y);
  const lon0 = Math.atan2(main.x, main.z);
  const calendar = defaultCampaignStart(main, params);
  // Live weather from the sim, replayed to each view's time, for the map's clouds.
  const weatherConfig = {
    seed: params.seed,
    radius: params.radius,
    orbit: params,
    calendar,
    climate: buildWeatherClimate(
      { ...world.maps, resolution: world.info.resolution, reliefScale: world.info.reliefScale },
      new WeatherGrid(),
      params.radius,
    ),
  };
  // The air war (C2) runs with the weather; FLIGHTS=0 leaves it out, ROUTES=1 draws every route.
  const airConfig = {
    ...weatherConfig,
    campaign:
      process.env.FLIGHTS === '0'
        ? null
        : campaignInput(campaign.graph, campaign.campaign.cast, campaign.infrastructure),
  };
  let simWorld = createSimWorld(airConfig);
  const outDir = join(import.meta.dirname, 'out');
  mkdirSync(outDir, { recursive: true });
  // One renderer and scene per image size.
  const sizes = new Map<string, PreviewView[]>();
  for (const v of o.views) {
    const key = `${v.width ?? o.width}x${v.height ?? o.height}`;
    sizes.set(key, [...(sizes.get(key) ?? []), v]);
  }
  let fakeNow = 0;
  for (const [key, group] of sizes) {
    const [width, height] = key.split('x').map(Number) as [number, number];
    const head = await headlessRenderer(gpu.device, width, height);
    const weather = new WeatherTexture();
    const clouds = new CloudLayer(params.radius, new PlanetLighting(params.radius), weather);
    const scene = new StrategicScene(head.renderer, {
      radius: params.radius,
      grid: new CubeGrid(world.info.resolution),
      input: false,
      weather: clouds,
    });
    scene.resize(width, height);
    scene.setWorld(displayWorld);
    scene.setValleyFloor(global.finish.display.valleyFloor ?? null);
    scene.setStrategic(campaign.graph, campaign.campaign.cast, campaign.infrastructure);
    // Labels (decision 98): the same fonts as the app, read from node_modules.
    if (process.env.LABELS !== '0') scene.setLabelFonts(labelAtlas());
    scene.setTerrainWorld({
      synth,
      seed: params.seed,
      radius: params.radius,
      reliefScale: params.reliefScale,
      biome: global.finish.biome,
      biomeResolution: global.n,
      height: global.height,
      rivers: riverIndex,
    });
    scene.relief.buildBudgetMs = 10_000;
    // The graph debug overlay is not part of the map's look; OVERLAY=1 shows it.
    scene.overlay.enabled = process.env.OVERLAY === '1';
    if (process.env.TINT) scene.relief.territoryOpacity.value = Number(process.env.TINT);
    for (const v of group) {
      const cam = scene.orbit;
      cam.lat = lat0 + v.dLat;
      cam.lon = lon0 + v.dLon;
      if (v.target === 'front') {
        // The middle of the first continental front's start line.
        const g = campaign.graph;
        const t = campaign.campaign.cast.theaters.find((x) => x.kind === 'continental-front');
        const line = t ? g.barrierLines[g.fronts[t.front!]!.start] : undefined;
        if (line) {
          const i = Math.floor(line.points.length / 6);
          const p = line.points.subarray(i * 3, i * 3 + 3);
          cam.lat = Math.asin(p[1]!) + v.dLat;
          cam.lon = Math.atan2(p[0]!, p[2]!) + v.dLon;
        } else
          console.log(`strategic ${v.name}: no continental front; centered on the main continent`);
      }
      if (v.target === 'capital') {
        const cap = campaign.infrastructure.capitals.alliance;
        const sp = campaign.graph.settlements.points;
        if (cap >= 0) {
          cam.lat = Math.asin(sp[cap * 3 + 1]!) + v.dLat;
          cam.lon = Math.atan2(sp[cap * 3]!, sp[cap * 3 + 2]!) + v.dLon;
        }
      }
      cam.altitude = cam.targetAltitude = v.altitude;
      cam.heading = v.heading;
      // The sun, season and weather at the view's local time and day.
      const localAt = (day: number) =>
        withLocalTime(day * DAY, cam.lon, (v.localTime ?? 11) * HOUR, params, calendar);
      let when = localAt(v.day ?? 0);
      if (when < 0) when = localAt((v.day ?? 0) + 1);
      sunDirection(when, params, calendar, scene.sun);
      scene.relief.seasonPhase.value = seasonPhase(when, params, calendar);
      if (when < simWorld.sim.time) simWorld = createSimWorld(airConfig);
      simWorld.sim.advanceTo(when);
      scene.setMissions(simWorld.air?.liveMissions() ?? []);
      scene.setAirTime(when);
      scene.airView.routes = process.env.ROUTES === '1';
      scene.setAirVisible('routes', scene.airView.routes);
      if (simWorld.air) {
        const a = simWorld.air;
        console.log(
          `strategic ${v.name}: ${a.missions.size} missions, airborne ${a.airborneAt('alliance', when)} Alliance / ${a.airborneAt('pact', when)} Pact, ${a.carriers.length} carriers`,
        );
      }
      const view = simWorld.weather.view();
      weather.setFrames(view);
      weather.update(view, when);
      clouds.time.value = when;
      // A clock far ahead of real time, so the bake runs now whatever its throttle.
      clouds.bake(head.renderer, (fakeNow += 1e9));
      // Render until every tile this view wants has loaded.
      let stable = 0;
      let last = '';
      for (let f = 0; f < 300 && stable < 3; f++) {
        scene.render(0);
        await gpu.finish();
        await new Promise((r) => setTimeout(r, 2));
        const s = scene.relief.stats;
        const sig = `${s.drawn}/${s.deepest}/${s.meshes}`;
        stable = s.pending === 0 && sig === last ? stable + 1 : 0;
        last = sig;
      }
      // Frame time of the loaded view (ms until the GPU is done; on a software adapter
      // only ratios between views mean anything).
      const frames = 20;
      const p0 = performance.now();
      for (let f = 0; f < frames; f++) {
        scene.render(0);
        await gpu.finish();
      }
      const ms = (performance.now() - p0) / frames;
      const rgb = await head.readRgb();
      const base = join(outDir, `render-${o.seed}-strategic-${v.name}`);
      writeFileSync(`${base}.png`, encodePng(width, height, rgb));
      if (cvd) {
        for (const kind of DEFICIENCIES)
          writeFileSync(`${base}-${kind}.png`, encodePng(width, height, simulateCvd(rgb, kind)));
      }
      const s = scene.relief.stats;
      console.log(
        `strategic ${v.name} (${width}×${height}): ${s.drawn} tiles, deepest L${s.deepest}, ` +
          `${ms.toFixed(1)} ms/frame → ${base}.png`,
      );
    }
    scene.dispose();
    clouds.dispose();
    head.dispose();
  }
  if (gpu.errors.length) throw new Error(`GPU errors: ${gpu.errors.join(' | ')}`);
  synth.dispose();
  global.grid.dispose();
}

/** The label atlas from the font files in node_modules. */
function labelAtlas() {
  const req = createRequire(import.meta.url);
  const buffers = Object.fromEntries(
    FONT_IDS.map((id) => {
      const b = readFileSync(req.resolve(LABEL_FONT_FILES[id]));
      return [id, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)];
    }),
  ) as Record<FontId, ArrayBuffer>;
  return buildFontAtlas(buffers);
}
