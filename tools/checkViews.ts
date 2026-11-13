/**
 * Targets for Part I's acceptance checks 1, 2 and 5 (docs/visual-style.md,
 * _Acceptance Checks_; decision 128), found in a generated world by scanning
 * the global grid around settlements, roads and coasts near the main
 * continent. `tools/render.preview.ts` aims the views `mixed`, `conifer` and
 * `beach` at them; checks 3 and 4 use the `peak` and `airbase` targets.
 *
 *   mixed    a town with forest, open farmland and a river around it (check 1)
 *   conifer  a road through the edge of a conifer forest (check 2)
 *   beach    a low, warm coast with a broad shallow shelf (check 5)
 */
import { cubeFaceUvToDirection, directionToCubeFace } from '../src/core/coords';
import type { CubeFace } from '../src/core/coords';
import {
  tileForDirection,
  tileKeyString,
  TILE_BORDER,
  TILE_STRIDE,
  TILE_TEXELS,
} from '../src/core/tiles';
import type { TileKey } from '../src/core/tiles';
import { Vec3d } from '../src/core/vec3d';
import type { TileData, TileSynthesizer } from '../src/worldgen/gpu/tileSynth';
import { FARMABLE_BIOMES } from '../src/render/common/palette';
import { Biome } from '../src/worldgen/biomes';
import type { GlobalWorld } from '../src/worldgen/globalPipeline';
import type { StrategicGraph } from '../src/worldgen/strategic/graph';
import { settlementPoint } from '../src/worldgen/strategic/graph';
import { WorldSampler } from './landscapeSpots';

export interface CheckTargets {
  mixed: Vec3d | null;
  conifer: Vec3d | null;
  beach: Vec3d | null;
  /** What each search found, for the log. */
  notes: string[];
}

/** Forest density (0..255) counted as forest, and under which ground counts as open. */
const FOREST = 150;
const OPEN = 70;
/** Discharge (m³/s) of a river that reads from 5 km. */
const RIVER = 40;
const WARM: ReadonlySet<number> = new Set([
  Biome.TemperateGrassland,
  Biome.Shrubland,
  Biome.Savanna,
  Biome.TropicalSeasonalForest,
  Biome.TropicalRainforest,
  Biome.HotDesert,
]);

/** Conifer candidates judged on synthesized tiles. */
const TILE_CANDIDATES = 8;
/** Tile level for judging candidates: about 48 m samples. */
const TILE_LEVEL = 7;

/**
 * Forest density (0..1) and height (m) at directions within `radiusM` of `center`,
 * read from synthesized tiles at TILE_LEVEL (nearest sample).
 */
async function tileSampler(
  synth: TileSynthesizer,
  s: WorldSampler,
  center: Readonly<Vec3d>,
  radiusM: number,
): Promise<(d: Readonly<Vec3d>) => { forest: number; height: number }> {
  const keys = new Map<string, TileKey>();
  for (const [dx, dy] of [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
    [0, 0],
  ] as const) {
    const d = s.offset(s.offset(center, 0, dy * radiusM), Math.PI / 2, dx * radiusM);
    const k = tileForDirection(d, TILE_LEVEL);
    keys.set(tileKeyString(k), k);
  }
  const tiles = new Map<string, TileData>();
  for (const t of await synth.generate([...keys.values()])) tiles.set(tileKeyString(t.key), t);
  const uv = { face: 0, u: 0, v: 0 } as ReturnType<typeof directionToCubeFace>;
  const size = TILE_TEXELS * (1 << TILE_LEVEL);
  return (d) => {
    const k = tileForDirection(d, TILE_LEVEL);
    const t = tiles.get(tileKeyString(k));
    if (!t) return { forest: 0, height: 0 };
    directionToCubeFace(d, uv);
    const sx = Math.min(TILE_TEXELS, Math.max(0, Math.round(uv.u * size - k.x * TILE_TEXELS)));
    const sy = Math.min(TILE_TEXELS, Math.max(0, Math.round(uv.v * size - k.y * TILE_TEXELS)));
    const i = (sy + TILE_BORDER) * TILE_STRIDE + sx + TILE_BORDER;
    return { forest: (t.material[i]! >>> 24) / 255, height: t.height[i]! };
  };
}

/** Fractions of a square window of points around `p` (spacing `step` m, `half` steps each way). */
function window(
  s: WorldSampler,
  p: Readonly<Vec3d>,
  half: number,
  step: number,
  visit: (cell: number) => void,
): void {
  const q = new Vec3d();
  const r = new Vec3d();
  for (let j = -half; j <= half; j++) {
    s.offset(p, 0, j * step, q);
    for (let i = -half; i <= half; i++) visit(s.cell(s.offset(q, Math.PI / 2, i * step, r)));
  }
}

/**
 * The check targets within `reachM` of the main continent's center `main`
 * (unit direction), or null where the world has none.
 */
export async function findCheckTargets(
  g: GlobalWorld,
  graph: StrategicGraph,
  main: Readonly<Vec3d>,
  radius: number,
  synth?: TileSynthesizer,
  reachM = 900_000,
): Promise<CheckTargets> {
  const s = new WorldSampler(g, radius);
  const near = (p: Readonly<Vec3d>) => p.dot(main) > Math.cos(reachM / radius);
  const { biome, forest } = g.finish;
  const { discharge } = g.finish.drainage;
  const height = g.height;

  // Check 1: towns and cities with forest, farmland and a river within about 6 km.
  let mixed: Vec3d | null = null;
  let best = 0;
  const sp = graph.settlements;
  for (let i = 0; i < sp.cells.length; i++) {
    if (sp.population[i]! < 5000) continue;
    const p = new Vec3d(...settlementPoint(sp, i));
    if (!near(p)) continue;
    let n = 0;
    let wooded = 0;
    let farmed = 0;
    let wet = 0;
    let river = false;
    window(s, p, 6, 1000, (c) => {
      n++;
      if (height[c]! <= 0) wet++;
      else if (forest[c]! >= FOREST) wooded++;
      else if (forest[c]! < OPEN && FARMABLE_BIOMES.has(biome[c]!)) farmed++;
      if (discharge[c]! >= RIVER) river = true;
    });
    const score = ((Math.min(wooded, farmed) - wet / 2) / n) * (river ? 1 : 0.3);
    if (score > best) {
      best = score;
      mixed = p;
    }
  }

  // Check 2: road points with lowland conifer forest and open ground within about 2 km,
  // nearest the main continent when several score alike (taiga can be scarce near it).
  // The global grid ranks them; synthesized tiles, which cut the forest by the fine
  // height's treeline, slope and water, judge the best few.
  const candidates: { p: Vec3d; score: number }[] = [];
  const roads = graph.roads;
  const q = new Vec3d();
  for (let k = 0; k < roads.count; k++) {
    for (let v = roads.offsets[k]!; v < roads.offsets[k + 1]!; v += 2) {
      q.set(roads.points[v * 3]!, roads.points[v * 3 + 1]!, roads.points[v * 3 + 2]!);
      let n = 0;
      let taiga = 0;
      let open = 0;
      window(s, q, 2, 1000, (c) => {
        n++;
        const h = height[c]!;
        if (h <= 0 || h > 1500) return;
        if (forest[c]! >= FOREST && biome[c] === Biome.Taiga) taiga++;
        else if (forest[c]! < OPEN) open++;
      });
      // Up to 10% for proximity: 1 at the main continent's center, 0 opposite.
      const score = (Math.min(taiga, open) / n) * (0.9 + 0.05 * (1 + q.dot(main)));
      if (score > 0) candidates.push({ p: q.clone(), score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const shortlist: Vec3d[] = [];
  for (const c of candidates) {
    if (shortlist.length >= TILE_CANDIDATES) break;
    if (shortlist.every((p) => p.dot(c.p) < Math.cos(30_000 / radius))) shortlist.push(c.p);
  }
  let conifer: Vec3d | null = shortlist[0] ?? null;
  let coniferNote = `conifer: ${candidates.length} road points near taiga`;
  if (synth && shortlist.length) {
    let bestTiles = 0;
    for (const p of shortlist) {
      const at = await tileSampler(synth, s, p, 2000);
      let n = 0;
      let wooded = 0;
      let open = 0;
      for (let j = -8; j <= 8; j++) {
        for (let i = -8; i <= 8; i++) {
          const d = s.offset(s.offset(p, 0, j * 250), Math.PI / 2, i * 250);
          const { forest: f, height: h } = at(d);
          n++;
          if (h <= 0) continue;
          if (f >= 0.5) wooded++;
          else if (f < 0.15) open++;
        }
      }
      const score = Math.min(wooded, open) / n;
      if (score > bestTiles) {
        bestTiles = score;
        conifer = p;
        coniferNote = `conifer: ${wooded} wooded and ${open} open of ${n} tile samples (best of ${shortlist.length})`;
      }
    }
  }

  // Check 5: warm, low coast with shallow sea offshore and little relief.
  let beach: Vec3d | null = null;
  best = 0;
  const n = g.n;
  const d = new Vec3d();
  for (let c = 0; c < height.length; c += 3) {
    const h = height[c]!;
    if (h <= 0 || h > 25 || !WARM.has(biome[c]!)) continue;
    const face = Math.floor(c / (n * n));
    const j = Math.floor(c / n) % n;
    const i = c % n;
    cubeFaceUvToDirection(face as CubeFace, (i + 0.5) / n, (j + 0.5) / n, d);
    if (!near(d)) continue;
    let total = 0;
    let shallow = 0;
    let deep = 0;
    let steep = 0;
    window(s, d, 3, 1500, (cc) => {
      total++;
      const hh = height[cc]!;
      if (hh < 0 && hh > -40) shallow++;
      else if (hh <= -40) deep++;
      else if (hh > 150) steep++;
    });
    const score = (Math.min(shallow, total - shallow - deep) / total) * (1 - steep / total);
    if (score > best) {
      best = score;
      beach = d.clone();
    }
  }
  return { mixed, conifer, beach, notes: [coniferNote] };
}
