/**
 * Spike N5.0 (decision 181): the alignment tier on a real world's roads and
 * railways. Pieces of the network's links, cut at anchors every PIECE_KM, are
 * aligned (decision 180) over two height sources, the global grid (CPU, 1.5 km
 * cells) and level-6 tiles (GPU, 96 m samples), and compared: how many route,
 * how long they take, how much longer than straight, their switchbacks,
 * viaducts, tunnels and deepest earthworks.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/networks.preview.ts
 *
 * Env: SEED (1983), GRES (1024), ROADS (12), RAILS (4), PIECE_KM (12),
 * SOURCES (global,tiles).
 */
import { it } from 'vitest';
import { directionToCubeFace } from '../src/core/coords';
import {
  TILE_BORDER,
  TILE_STRIDE,
  TILE_TEXELS,
  tileForDirection,
  tileKeyString,
} from '../src/core/tiles';
import type { TileKey } from '../src/core/tiles';
import { Vec3d } from '../src/core/vec3d';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { cubeMapSampler } from '../src/worldgen/channels/channels';
import type { TileData } from '../src/worldgen/gpu/tileSynth';
import { TileSynthesizer } from '../src/worldgen/gpu/tileSynth';
import { EARTHWORK_LIMITS, STRUCTURE } from '../src/worldgen/networks/alignment';
import { alignPiece, FORMATION_HALF_WIDTH } from '../src/worldgen/networks/pieces';
import type { Piece } from '../src/worldgen/networks/pieces';
import { ROUTE_CLASSES } from '../src/worldgen/networks/router';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { RiverIndex } from '../src/worldgen/riverIndex';
import { RoadClass } from '../src/worldgen/strategic/graph';
import type { RoadNetwork } from '../src/worldgen/strategic/graph';
import { testGpu } from '../tests/gpu/device';
import { previewWorld } from './previewWorld';

const env = process.env;
const LEVEL = 6;

type ClassKey = keyof typeof ROUTE_CLASSES;
interface Job {
  name: string;
  a: Vec3d;
  b: Vec3d;
  cls: ClassKey;
  /** The class tried when `cls` finds no route (the plan's class switches). */
  fallback: ClassKey | null;
}

const SPACING: Record<ClassKey, number> = {
  mainline: 50,
  mountainRailway: 50,
  motorway: 50,
  trunk: 40,
  secondary: 25,
  mountainRoad: 12.5,
  track: 12.5,
};

/** Pieces of polyline k of `net`, anchored every `pieceM` along its cell centers. */
function pieces(net: RoadNetwork, k: number, pieceM: number, R: number): [Vec3d, Vec3d][] {
  const pts: Vec3d[] = [];
  for (let p = net.offsets[k]!; p < net.offsets[k + 1]!; p++)
    pts.push(new Vec3d(net.points[p * 3]!, net.points[p * 3 + 1]!, net.points[p * 3 + 2]!));
  const out: [Vec3d, Vec3d][] = [];
  let anchor = pts[0]!;
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    run += pts[i]!.distanceTo(pts[i - 1]!) * R;
    if (run >= pieceM || i === pts.length - 1) {
      out.push([anchor, pts[i]!]);
      anchor = pts[i]!;
      run = 0;
    }
  }
  return out;
}

function switchbacks(p: Piece): number {
  // Reversals of travel along the piece's chord.
  const a = p.points[0]!;
  const b = p.points[p.points.length - 1]!;
  const chord = b.clone().sub(a);
  let last = 0;
  let n = 0;
  for (let i = 1; i < p.points.length; i++) {
    const d = Math.sign(
      p.points[i]!.clone()
        .sub(p.points[i - 1]!)
        .dot(chord),
    );
    if (d !== 0 && last !== 0 && d !== last) n++;
    if (d !== 0) last = d;
  }
  return Math.floor(n / 2);
}

it('aligns pieces of a world network over two height sources', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No WebGPU adapter (Dawn) available');
  const campaign = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed: env.SEED ?? '1983' });
  const params = { ...DEFAULT_PLANET_PARAMS, seed: campaign.seed };
  const R = params.radius;
  const { global } = await previewWorld(gpu, params, 256, Number(env.GRES ?? 1024));
  const pieceM = Number(env.PIECE_KM ?? 12) * 1000;
  const g = campaign.graph;
  const globalH = cubeMapSampler(global.height, global.n);

  // Roads: the steepest half (relief per km on the global grid) and a spread of the rest.
  const relief = (net: RoadNetwork, k: number) => {
    let lo = Infinity;
    let hi = -Infinity;
    let len = 0;
    for (let p = net.offsets[k]!; p < net.offsets[k + 1]!; p++) {
      const d = new Vec3d(net.points[p * 3]!, net.points[p * 3 + 1]!, net.points[p * 3 + 2]!);
      const h = globalH(d);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      if (p > net.offsets[k]!)
        len +=
          d.distanceTo(
            new Vec3d(net.points[p * 3 - 3]!, net.points[p * 3 - 2]!, net.points[p * 3 - 1]!),
          ) * R;
    }
    return len > 5000 ? (hi - lo) / len : -1;
  };
  const pick = (net: RoadNetwork, count: number) => {
    const ks = [...Array(net.count).keys()]
      .map((k) => ({ k, r: relief(net, k) }))
      .filter((x) => x.r >= 0);
    const steep = [...ks].sort((a, b) => b.r - a.r).slice(0, Math.ceil(count / 2));
    const rest = ks.filter((x) => !steep.includes(x));
    const stride = Math.max(1, Math.floor(rest.length / Math.max(1, count - steep.length)));
    return [
      ...steep,
      ...rest.filter((_, i) => i % stride === 0).slice(0, count - steep.length),
    ].map((x) => x.k);
  };
  const jobs: Job[] = [];
  const roadCls = (c: number): ClassKey =>
    c === RoadClass.Motorway ? 'motorway' : c === RoadClass.Trunk ? 'trunk' : 'secondary';
  for (const k of pick(g.roads, Number(env.ROADS ?? 12))) {
    const cls = roadCls(g.roads.roadClass[k]!);
    pieces(g.roads, k, pieceM, R).forEach(([a, b], i) =>
      jobs.push({
        name: `road ${k}.${i} (${cls})`,
        a,
        b,
        cls,
        fallback: cls === 'secondary' ? 'mountainRoad' : null,
      }),
    );
  }
  for (const k of pick(g.railways.lines, Number(env.RAILS ?? 4))) {
    pieces(g.railways.lines, k, pieceM, R).forEach(([a, b], i) =>
      jobs.push({ name: `rail ${k}.${i}`, a, b, cls: 'mainline', fallback: 'mountainRailway' }),
    );
  }

  // Level-6 tiles under every piece's band.
  const sources = (env.SOURCES ?? 'global,tiles').split(',');
  const heights: Record<string, (d: Readonly<Vec3d>) => number> = { global: globalH };
  if (sources.includes('tiles')) {
    const index = new RiverIndex(global.finish.rivers, {
      height: global.height,
      radius: R,
      lakeDepth: global.finish.drainage.lakeDepth,
      channels: global.finish.channels,
    });
    const synth = new TileSynthesizer(global.grid, {
      seed: params.seed,
      reliefScale: params.reliefScale,
      radius: R,
      biome: global.finish.biome,
      lakeDepth: global.finish.drainage.lakeDepth,
      height: global.height,
      forest: global.finish.forest,
      treeline: global.finish.treeline,
      index,
    });
    const keys = new Map<string, TileKey>();
    for (const j of jobs)
      for (let f = 0; f <= 1.0001; f += 0.1) {
        const m = new Vec3d(
          j.a.x + (j.b.x - j.a.x) * f,
          j.a.y + (j.b.y - j.a.y) * f,
          j.a.z + (j.b.z - j.a.z) * f,
        ).normalize();
        const t = tileForDirection(m, LEVEL);
        keys.set(tileKeyString(t), t);
      }
    const tiles = new Map<string, TileData>();
    const list = [...keys.values()];
    const t0 = performance.now();
    for (let i = 0; i < list.length; i += 8)
      for (const t of await synth.generate(list.slice(i, i + 8)))
        tiles.set(tileKeyString(t.key), t);
    console.log(
      `${list.length} level-${LEVEL} tiles in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
    );
    heights.tiles = (d) => {
      const key = tileForDirection(d, LEVEL);
      const t = tiles.get(tileKeyString(key));
      if (!t) return globalH(d);
      const uv = directionToCubeFace(d);
      const size = TILE_TEXELS * (1 << LEVEL);
      const fx =
        Math.min(TILE_TEXELS + 1, Math.max(-1, uv.u * size - key.x * TILE_TEXELS)) + TILE_BORDER;
      const fy =
        Math.min(TILE_TEXELS + 1, Math.max(-1, uv.v * size - key.y * TILE_TEXELS)) + TILE_BORDER;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const at = (x: number, y: number) => t.height[y * TILE_STRIDE + x]!;
      return (
        (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) +
        (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
      );
    };
  }

  for (const src of sources) {
    const h = heights[src]!;
    let ok = 0;
    let fell = 0;
    let km = 0;
    let ms = 0;
    let longer = 0;
    let sw = 0;
    let viaduct = 0;
    let tunnel = 0;
    let deepest = 0;
    let viol = 0;
    const rows: string[] = [];
    for (const j of jobs) {
      const t0 = performance.now();
      const straight = j.a.distanceTo(j.b) * R;
      const tryCls = (cls: ClassKey) =>
        alignPiece(j.a, j.b, h, R, {
          cls: ROUTE_CLASSES[cls],
          limits: EARTHWORK_LIMITS[cls],
          halfWidth: FORMATION_HALF_WIDTH[cls],
          spacing: SPACING[cls],
          band: Math.max(1500, 0.3 * straight),
          maxExpansions: 3_000_000,
        });
      let used = j.cls;
      let p = tryCls(j.cls);
      if (!p && j.fallback) {
        used = j.fallback;
        p = tryCls(j.fallback);
        if (p) fell++;
      }
      const dt = performance.now() - t0;
      ms += dt;
      if (!p) {
        rows.push(`  ${j.name}: no route (${(straight / 1000).toFixed(1)} km)`);
        continue;
      }
      ok++;
      const L = p.s[p.s.length - 1]!;
      km += L / 1000;
      longer += L / straight;
      const b = switchbacks(p);
      sw += b;
      let v = 0;
      let tn = 0;
      for (let i = 1; i < p.s.length; i++) {
        const ds = p.s[i]! - p.s[i - 1]!;
        if (p.structure[i] === STRUCTURE.Viaduct) v += ds;
        if (p.structure[i] === STRUCTURE.Tunnel) tn += ds;
        if (p.structure[i] === STRUCTURE.Corridor)
          deepest = Math.max(deepest, Math.abs(p.design[i]! - p.ground[i]!));
      }
      viaduct += v;
      tunnel += tn;
      viol += p.violations.length;
      rows.push(
        `  ${j.name}${used !== j.cls ? ` → ${used}` : ''}: ${(straight / 1000).toFixed(1)} km → ${(L / 1000).toFixed(1)} km, ` +
          `${b} switchbacks, viaduct ${v.toFixed(0)} m, tunnel ${tn.toFixed(0)} m, ${p.expansions} expansions, ${dt.toFixed(0)} ms`,
      );
    }
    console.log(
      `\n${src}: ${ok} of ${jobs.length} pieces routed (${fell} by the mountain class), ${km.toFixed(0)} km, ` +
        `${(ms / 1000).toFixed(1)} s (${(ms / Math.max(km, 1)).toFixed(0)} ms/km), length ×${(longer / Math.max(ok, 1)).toFixed(2)} on average, ` +
        `${sw} switchbacks, viaducts ${(viaduct / 1000).toFixed(1)} km, tunnels ${(tunnel / 1000).toFixed(1)} km, ` +
        `deepest corridor cut or fill ${deepest.toFixed(0)} m, ${viol} corners tighter than their radius`,
    );
    if (env.ROWS === '1') console.log(rows.join('\n'));
  }
}, 7_200_000);
