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
  const head = await headlessRenderer(gpu.device, width, height);
  const scene = new GlobeScene(head.renderer, {
    radius: params.radius,
    grid: new CubeGrid(tres),
    input: false,
  });
  scene.resize(width, height);
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
  const outDir = join(import.meta.dirname, 'out');
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
  for (const view of views) {
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
        height: env.OBS_HEIGHT ? Number(env.OBS_HEIGHT) : station.height,
        pitch: env.OBS_PITCH ? Number(env.OBS_PITCH) * DEG : station.pitch,
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
    // The sim starts at campaign start: an early local time on day 0 can fall before it.
    let t = localAt(v.day ?? 0);
    if (t < 0) t = localAt((v.day ?? 0) + 1);
    if (v.sunElevation !== undefined) {
      // Step through the afternoon and evening until the sun sinks to the elevation.
      const up = latLonToDirection(o.lat, o.lon);
      const sun = new Vec3d();
      for (let h = 12; h < 24; h += 1 / 60) {
        let at = withLocalTime((v.day ?? 0) * DAY, o.lon, h * HOUR, params, calendar);
        if (at < 0) at = withLocalTime((v.day ?? 0) * DAY + DAY, o.lon, h * HOUR, params, calendar);
        if (sunDirection(at, params, calendar, sun).dot(up) < Math.sin(v.sunElevation)) {
          t = at;
          break;
        }
      }
      const el = Math.asin(sunDirection(t, params, calendar, sun).dot(up)) / DEG;
      console.log(
        `${v.name}: sun at ${el.toFixed(1)}° (wanted ${(v.sunElevation / DEG).toFixed(1)}°)`,
      );
    }
    sunDirection(t, params, calendar, scene.sun);
    if (target && v.sunHeading !== undefined && !station) {
      // Face relative to the sun's azimuth at the target, standing back along that heading.
      const east = new Vec3d(0, 1, 0).cross(target).normalize();
      const north = target.clone().cross(east);
      o.heading = Math.atan2(scene.sun.dot(east), scene.sun.dot(north)) + v.sunHeading;
      const back = v.altitude * Math.tan(Math.min(v.tilt, 70 * DEG));
      const p = offsetPoint(target, o.heading, -back, 0, params.radius);
      o.lat = Math.asin(p.y);
      o.lon = Math.atan2(p.x, p.z);
      console.log(
        `${v.name}: target ${(Math.asin(target.y) / DEG).toFixed(3)}, ${(Math.atan2(target.x, target.z) / DEG).toFixed(3)}, heading ${(o.heading / DEG).toFixed(0)}°`,
      );
    }
    if (station && process.env.OBS_HEADING) {
      const h = process.env.OBS_HEADING;
      if (h === 'sun') {
        // Compass azimuth of the sun at the spot: atan2(east, north) of its tangential part.
        const up = scene.observer.spot;
        const east = new Vec3d(0, 1, 0).cross(up).normalize();
        const north = up.clone().cross(east);
        scene.observer.heading = Math.atan2(scene.sun.dot(east), scene.sun.dot(north));
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
  let simWorld = createSimWorld(weatherConfig);
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
      if (when < simWorld.sim.time) simWorld = createSimWorld(weatherConfig);
      simWorld.sim.advanceTo(when);
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
