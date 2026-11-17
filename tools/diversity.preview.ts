/**
 * World diversity metrics (proposal 0007, decision 204): the numbers its
 * verification criteria compare against, measured on generated worlds.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/diversity.preview.ts
 *
 * Env: SEEDS (comma list) or FROM and COUNT (default seeds 1..20);
 * GLOBAL=1 also builds each seed's eroded world on the GPU (Dawn; about ten
 * minutes per world on lavapipe, cached on disk by tools/previewWorld.ts) for
 * peak heights and the eroded biomes; GLOBAL_SEEDS limits that to a list;
 * GRES (default 1024); OUT (default tools/out/diversity.md).
 *
 * Each seed runs as the app does: the campaign world with its validity retries.
 * Measured per seed (coarse pass, 256² per face, and the eroded global grid
 * where built):
 *
 *   - land share per biome;
 *   - biome entropy (bits) of the land within about 8 km of each land cell,
 *     i.e. over the proposal's 100 km windows scaled to the planet (decision 205); the median and the land shares above 0.5 and 1 bit;
 *   - Jensen–Shannon divergence (bits) between the biome distributions of the
 *     two largest landmasses;
 *   - the highest point and the land area above 4 and 6 km;
 *   - the share of land the tile kernel would terrace (strata where the
 *     aridity mask passes 0.35, decision 126) and where it would raise buttes
 *     (aridity × flatness), from a CPU copy of the mask;
 *   - mountains in dry land: the share of the highest 5% of land whose biome
 *     is desert or shrubland (a share, so the uneroded coarse heights count too);
 *   - lake cells in arid biomes (the tiles' salt pans, decision 130) and
 *     endorheic basins (always 0 today: every depression drains to the sea);
 *   - time per coarse stage.
 *
 * With provinces (W1), entropy and the divergence count joint classes of
 * biome and province, and a table gives the province shares. Zones and
 * wonders join as track W adds them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { EARTH_RADIUS } from '../src/core/units';
import { Biome, BIOME_COUNT, BIOME_NAMES, DESERT_BIOMES } from '../src/worldgen/biomes';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { LANDFORM_MASK_TUNING } from '../src/worldgen/gpu/landformMasks';
import { PROVINCE_COUNT, PROVINCE_NAMES } from '../src/worldgen/provinces';
import { CHARACTER_NAMES } from '../src/worldgen/characters';
import { FeatureKind } from '../src/worldgen/strategic/graph';
import { isLayered } from '../src/worldgen/lithology';
import { TILE_SYNTH_TUNING } from '../src/worldgen/gpu/tileSynth';
import { labelLandmasses } from '../src/worldgen/landmasses';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';

/**
 * Window radius for the entropy (m): the proposal's 100 km windows, scaled to
 * the planet like every regional extent (decision 205): about 16 km across.
 */
const WINDOW_RADIUS = 50e3 * (DEFAULT_PLANET_PARAMS.radius / EARTH_RADIUS);
/** The coarse grid's 6 km cells hold too few cells in that window; there the unscaled 100 km windows serve. */
const COARSE_WINDOW_RADIUS = 50e3;
/** The highest share of land that counts as mountain for the dry-mountain share. */
const MOUNTAIN_SHARE = 0.05;
const DRY_BIOMES: ReadonlySet<number> = new Set([...DESERT_BIOMES, Biome.Shrubland]);

function seedList(): string[] {
  if (process.env.SEEDS) return process.env.SEEDS.split(',').map((s) => s.trim());
  const from = Number(process.env.FROM ?? 1);
  const count = Number(process.env.COUNT ?? 20);
  return Array.from({ length: count }, (_, i) => String(from + i));
}

interface GridMetrics {
  /** Land area share per biome. */
  biomeShare: Float64Array;
  /** Land area share per province (zeros without provinces). */
  provinceShare: Float64Array;
  entropyMedian: number;
  entropyAbove05: number;
  entropyAbove1: number;
  jsdTwoLargest: number;
  maxHeight: number;
  /** Land area (km²) above 4 km and 6 km. */
  above4km: number;
  above6km: number;
  /** Land share the tile kernel would layer into strata, and raise buttes on. */
  strataShare: number;
  butteShare: number;
  /** Share of the highest 5% of land (by area) that is desert or shrubland. */
  dryMountainShare: number;
  /** Land share of lake cells in arid biomes (salt pans in the tiles). */
  aridLakeShare: number;
  ms: number;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** One pass of the landform masks' blur (center weight 2, eight neighbors 1). */
function blur(grid: CubeGrid, v: Float32Array, passes: number): Float32Array {
  let a: Float32Array = v;
  let b: Float32Array = new Float32Array(v.length);
  for (let p = 0; p < passes; p++) {
    for (let c = 0; c < grid.cellCount; c++) {
      let sum = 2 * a[c]!;
      let w = 2;
      for (let k = 0; k < 8; k++) {
        const nb = grid.neighbors8[c * 8 + k]!;
        if (nb >= 0) {
          sum += a[nb]!;
          w += 1;
        }
      }
      b[c] = sum / w;
    }
    [a, b] = [b, a];
  }
  return a;
}

/** Slope (rise over run) from the largest height difference to a 4-neighbor. */
function slopeAt(grid: CubeGrid, h: Float32Array, c: number, cellSize: number): number {
  let s = 0;
  for (let k = 0; k < 4; k++) {
    const nb = grid.neighbors4[c * 4 + k]!;
    s = Math.max(s, Math.abs(h[c]! - Math.max(0, h[nb]!)) / cellSize);
  }
  return s;
}

function entropyBits(counts: Float64Array, total: number): number {
  let e = 0;
  for (let i = 0; i < counts.length; i++) {
    const p = counts[i]! / total;
    if (p > 0) e -= p * Math.log2(p);
  }
  return e;
}

function jsdBits(p: Float64Array, q: Float64Array): number {
  let d = 0;
  for (let i = 0; i < p.length; i++) {
    const m = 0.5 * (p[i]! + q[i]!);
    if (p[i]! > 0) d += 0.5 * p[i]! * Math.log2(p[i]! / m);
    if (q[i]! > 0) d += 0.5 * q[i]! * Math.log2(q[i]! / m);
  }
  return d;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/**
 * Metrics on one grid. `blurPasses` scales the aridity mask's blur to the
 * grid (6 passes at 1024², as the tiles use; about 1 at 256²).
 */
function measure(
  grid: CubeGrid,
  height: Float32Array,
  biome: Uint8Array,
  lakeDepth: Float32Array | undefined,
  radius: number,
  blurPasses: number,
  province?: Uint8Array,
  lithology?: Uint8Array,
): GridMetrics {
  const t0 = performance.now();
  const n = grid.cellCount;
  const R2 = radius * radius;
  const cellSize = ((Math.PI / 2) * radius) / grid.n;
  const isLand = (c: number) => height[c]! > 0 && biome[c]! > Biome.SeaIce;

  // Biome shares.
  const share = new Float64Array(BIOME_COUNT);
  const provinceShare = new Float64Array(PROVINCE_COUNT);
  let landArea = 0;
  let maxHeight = -Infinity;
  let above4 = 0;
  let above6 = 0;
  let aridLake = 0;
  const landCells: number[] = [];
  for (let c = 0; c < n; c++) {
    if (!isLand(c)) continue;
    const a = grid.areas[c]!;
    const h = height[c]!;
    share[biome[c]!]! += a;
    if (province) provinceShare[province[c]!]! += a;
    landArea += a;
    maxHeight = Math.max(maxHeight, h);
    if (h > 4000) above4 += a;
    if (h > 6000) above6 += a;
    landCells.push(c);
    if (lakeDepth && lakeDepth[c]! > 0 && (LANDFORM_MASK_TUNING.arid[biome[c]!] ?? 0) >= 0.75)
      aridLake += a;
  }
  for (let i = 0; i < BIOME_COUNT; i++) share[i]! /= landArea;
  for (let i = 0; i < PROVINCE_COUNT; i++) provinceShare[i]! /= landArea;
  landCells.sort((a, b) => height[b]! - height[a]!);
  let mountain = 0;
  let dryMountain = 0;
  for (const c of landCells) {
    if (mountain >= MOUNTAIN_SHARE * landArea) break;
    mountain += grid.areas[c]!;
    if (DRY_BIOMES.has(biome[c]!)) dryMountain += grid.areas[c]!;
  }

  // Terracing and buttes, as the tile kernel gates them (decision 126).
  const aridSrc = new Float32Array(n);
  for (let c = 0; c < n; c++) aridSrc[c] = LANDFORM_MASK_TUNING.arid[biome[c]!] ?? 0;
  const arid = blur(grid, aridSrc, blurPasses);
  // Strata and buttes need layered rock (decision 208): the kernel's second mask.
  const laySrc = new Float32Array(n).fill(1);
  if (lithology) for (let c = 0; c < n; c++) laySrc[c] = isLayered(lithology[c]!) ? 1 : 0;
  const layered = blur(grid, laySrc, blurPasses);
  const t = TILE_SYNTH_TUNING;
  let strata = 0;
  let buttes = 0;
  for (let c = 0; c < n; c++) {
    if (!isLand(c)) continue;
    const a = grid.areas[c]!;
    const w =
      smoothstep(t.aridRange[0], t.aridRange[1], arid[c]!) * smoothstep(0.3, 0.7, layered[c]!);
    if (w > 0.05) strata += a;
    const flat = 1 - smoothstep(t.butteFlat[0], t.butteFlat[1], slopeAt(grid, height, c, cellSize));
    if (w * flat > 0.25) buttes += a;
  }

  // Entropy over 100 km windows: breadth-first over 8-neighbors within the radius.
  const limit = (grid.n > 256 ? WINDOW_RADIUS : COARSE_WINDOW_RADIUS) / radius;
  const cosLimit = Math.cos(limit);
  const stamp = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  // With provinces, entropy and divergence count joint classes (biome, province; decision 204).
  const P = province ? PROVINCE_COUNT : 1;
  const classOf = (c: number) => biome[c]! * P + (province ? province[c]! : 0);
  const counts = new Float64Array(BIOME_COUNT * P);
  const C = grid.centers;
  const entropies: number[] = [];
  let e05 = 0;
  let e1 = 0;
  // Sample every land cell on coarse grids; every 4th on fine ones (the median barely moves).
  const stride = grid.n > 256 ? 4 : 1;
  let sampledArea = 0;
  for (let s = 0; s < n; s += stride) {
    if (!isLand(s)) continue;
    counts.fill(0);
    let total = 0;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    stamp[s] = s;
    const sx = C[3 * s]!;
    const sy = C[3 * s + 1]!;
    const sz = C[3 * s + 2]!;
    while (head < tail) {
      const c = queue[head++]!;
      if (isLand(c)) {
        counts[classOf(c)]! += grid.areas[c]!;
        total += grid.areas[c]!;
      }
      for (let k = 0; k < 8; k++) {
        const nb = grid.neighbors8[c * 8 + k]!;
        if (nb < 0 || stamp[nb] === s) continue;
        stamp[nb] = s;
        const dot = sx * C[3 * nb]! + sy * C[3 * nb + 1]! + sz * C[3 * nb + 2]!;
        if (dot >= cosLimit) queue[tail++] = nb;
      }
    }
    const e = entropyBits(counts, total);
    entropies.push(e);
    const a = grid.areas[s]!;
    sampledArea += a;
    if (e >= 0.5) e05 += a;
    if (e >= 1) e1 += a;
  }

  // The two largest landmasses.
  const { label, landmasses } = labelLandmasses(grid, height, radius);
  let jsd = NaN;
  if (landmasses.length >= 2) {
    const p = new Float64Array(BIOME_COUNT * P);
    const q = new Float64Array(BIOME_COUNT * P);
    for (let c = 0; c < n; c++) {
      if (!isLand(c)) continue;
      if (label[c] === 0) p[classOf(c)]! += grid.areas[c]!;
      else if (label[c] === 1) q[classOf(c)]! += grid.areas[c]!;
    }
    const sp = p.reduce((x, y) => x + y, 0);
    const sq = q.reduce((x, y) => x + y, 0);
    for (let i = 0; i < p.length; i++) {
      p[i]! /= sp;
      q[i]! /= sq;
    }
    jsd = jsdBits(p, q);
  }

  return {
    biomeShare: share,
    provinceShare,
    entropyMedian: median(entropies),
    entropyAbove05: e05 / sampledArea,
    entropyAbove1: e1 / sampledArea,
    jsdTwoLargest: jsd,
    maxHeight,
    above4km: (above4 * R2) / 1e6,
    above6km: (above6 * R2) / 1e6,
    strataShare: strata / landArea,
    butteShare: buttes / landArea,
    dryMountainShare: mountain > 0 ? dryMountain / mountain : 0,
    aridLakeShare: aridLake / landArea,
    ms: performance.now() - t0,
  };
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '–');

function summaryRows(rows: { seed: string; m: GridMetrics }[]): string[] {
  const out = [
    '| seed | max height (m) | > 4 km (km²) | > 6 km (km²) | entropy median (bits) | land ≥ 0.5 bit | land ≥ 1 bit | JSD two largest (bits) | strata | buttes | dry share of highest 5% | arid lakes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const { seed, m } of rows) {
    out.push(
      `| ${seed} | ${Math.round(m.maxHeight)} | ${Math.round(m.above4km)} | ${Math.round(m.above6km)} | ` +
        `${f2(m.entropyMedian)} | ${pct(m.entropyAbove05)} | ${pct(m.entropyAbove1)} | ${f2(m.jsdTwoLargest)} | ` +
        `${pct(m.strataShare)} | ${pct(m.butteShare)} | ${pct(m.dryMountainShare)} | ${(100 * m.aridLakeShare).toFixed(2)}% |`,
    );
  }
  const col = (g: (m: GridMetrics) => number) =>
    median(rows.map((r) => g(r.m)).filter(Number.isFinite));
  const jsds = rows.map((r) => r.m.jsdTwoLargest).filter(Number.isFinite);
  out.push(
    `| **median** | ${Math.round(col((m) => m.maxHeight))} | ${Math.round(col((m) => m.above4km))} | ` +
      `${Math.round(col((m) => m.above6km))} | ${f2(col((m) => m.entropyMedian))} | ` +
      `${pct(col((m) => m.entropyAbove05))} | ${pct(col((m) => m.entropyAbove1))} | ` +
      `${f2(col((m) => m.jsdTwoLargest))} (${jsds.length} seeds with two landmasses) | ` +
      `${pct(col((m) => m.strataShare))} | ${pct(col((m) => m.butteShare))} | ` +
      `${pct(col((m) => m.dryMountainShare))} | ${(100 * col((m) => m.aridLakeShare)).toFixed(2)}% |`,
  );
  return out;
}

function provinceTable(rows: { seed: string; m: GridMetrics }[]): string[] {
  if (rows.every((r) => r.m.provinceShare.every((v) => v === 0))) return [];
  const out = [
    '| province | mean land share | seeds where present (> 0.1%) |',
    '| --- | --- | --- |',
  ];
  for (let p = 1; p < PROVINCE_COUNT; p++) {
    const mean = rows.reduce((s, r) => s + r.m.provinceShare[p]!, 0) / rows.length;
    const present = rows.filter((r) => r.m.provinceShare[p]! > 0.001).length;
    out.push(`| ${PROVINCE_NAMES[p]} | ${pct(mean)} | ${present} of ${rows.length} |`);
  }
  return ['### Provinces', '', ...out, ''];
}

function biomeTable(rows: { seed: string; m: GridMetrics }[]): string[] {
  const out = ['| biome | mean land share | seeds where present (> 0.1%) |', '| --- | --- | --- |'];
  for (let b = Biome.IceSheet; b < BIOME_COUNT; b++) {
    const mean = rows.reduce((s, r) => s + r.m.biomeShare[b]!, 0) / rows.length;
    const present = rows.filter((r) => r.m.biomeShare[b]! > 0.001).length;
    out.push(`| ${BIOME_NAMES[b]} | ${pct(mean)} | ${present} of ${rows.length} |`);
  }
  return out;
}

it('measures world diversity', async () => {
  const seeds = seedList();
  const params0 = DEFAULT_PLANET_PARAMS;
  const coarseGrid = new CubeGrid(256);
  const coarse: { seed: string; m: GridMetrics }[] = [];
  const stageMs = new Map<string, number[]>();
  const generated: { seed: string; actual: string }[] = [];
  const characterRows: string[] = [];
  for (const s of seeds) {
    const t0 = performance.now();
    const w = generateCampaignWorld({ ...params0, seed: s });
    const genMs = performance.now() - t0;
    generated.push({ seed: s, actual: String(w.seed) });
    for (const t of w.timings) {
      const list = stageMs.get(t.stage) ?? [];
      list.push(t.ms);
      stageMs.set(t.stage, list);
    }
    const total = stageMs.get('campaign world total') ?? [];
    total.push(genMs);
    stageMs.set('campaign world total', total);
    const info = w.world.info;
    if (info.continents) {
      const top = info.continents
        .slice(0, 3)
        .map((k) => `${CHARACTER_NAMES[k.character]} (${Math.round(k.area / 1e9)}k km²)`)
        .join(', ');
      const f = w.graph.features;
      let candidates = 0;
      for (let i = 0; i < f.count; i++) if (f.kind[i] === FeatureKind.Wonder) candidates++;
      const sel = w.campaign.cast.wonders ?? [];
      const flats = w.graph.saltFlats ?? [];
      characterRows.push(
        `| ${s} | ${top} | ${info.characterRedraws ?? 0} | ${candidates} | ${sel.length} | ` +
          `${sel
            .slice(0, 3)
            .map((i) => f.names[i])
            .join(', ')} | ${flats.length} (${flats.filter((x) => x.airstrip).length}) |`,
      );
    }
    const m = w.world.maps;
    const grid =
      w.world.info.resolution === 256 ? coarseGrid : new CubeGrid(w.world.info.resolution);
    coarse.push({
      seed: s,
      m: measure(grid, m.height, m.biome, m.lakeDepth, params0.radius, 1, m.province, m.lithology),
    });
    console.log(`seed ${s} (world ${w.seed}): coarse metrics in ${Math.round(genMs)} ms`);
  }

  const lines: string[] = [
    `# World diversity metrics`,
    '',
    `Generated ${new Date().toISOString().slice(0, 10)} by \`tools/diversity.preview.ts\` over seeds ${seeds.join(', ')} ` +
      `(the campaign worlds after validity retries: ${
        generated
          .filter((g) => g.actual !== g.seed)
          .map((g) => `${g.seed} → ${g.actual}`)
          .join(', ') || 'none retried'
      }).`,
    '',
    '## Coarse pass (256² per face, about 6 km cells, no erosion; entropy over unscaled 100 km windows)',
    '',
    ...summaryRows(coarse),
    '',
    '### Biomes over all seeds',
    '',
    ...biomeTable(coarse),
    '',
    ...provinceTable(coarse),
    ...(characterRows.length
      ? [
          '### Continental characters, wonders and salt flats (decisions 208, 210, 212)',
          '',
          '| seed | three largest continents | redraws | wonder candidates | wonders selected | first wonders | salt flats (airstrips) |',
          '| --- | --- | --- | --- | --- | --- | --- |',
          ...characterRows,
          '',
        ]
      : []),
    '### Coarse stage times (median ms)',
    '',
    '| stage | median ms |',
    '| --- | --- |',
    ...[...stageMs].map(([k, v]) => `| ${k} | ${Math.round(median(v))} |`),
    '',
  ];

  if (process.env.GLOBAL === '1') {
    const { testGpu } = await import('../tests/gpu/device');
    const { previewWorld } = await import('./previewWorld');
    const gpu = await testGpu();
    if (!gpu) throw new Error('No WebGPU adapter (Dawn) available');
    const gres = Number(process.env.GRES ?? 1024);
    const gseeds = process.env.GLOBAL_SEEDS?.split(',').map((x) => x.trim()) ?? seeds;
    const globalGrid = new CubeGrid(gres);
    const eroded: { seed: string; m: GridMetrics }[] = [];
    const globalMs: string[] = [];
    const zoneRows: string[] = [];
    for (const s of gseeds) {
      const actual =
        generated.find((g) => g.seed === s)?.actual ??
        String(generateCampaignWorld({ ...params0, seed: s }).seed);
      const params = { ...params0, seed: actual };
      const t0 = performance.now();
      const { global } = await previewWorld(gpu, params, 256, gres);
      const ms = performance.now() - t0;
      if (global.timings?.length)
        globalMs.push(
          `| ${s} | ${global.timings.map((t) => `${t.stage} ${Math.round(t.ms / 1000)} s`).join(', ')} |`,
        );
      else globalMs.push(`| ${s} | ${Math.round(ms / 1000)} s (load or build) |`);
      eroded.push({
        seed: s,
        m: measure(
          globalGrid,
          global.height,
          global.finish.biome,
          global.finish.drainage.lakeDepth,
          params0.radius,
          LANDFORM_MASK_TUNING.blurPasses,
          global.finish.province,
          global.finish.lithology,
        ),
      });
      const zs = global.finish.zones;
      if (zs) {
        let land = 0;
        let zoned = 0;
        for (let c = 0; c < global.height.length; c++) {
          if (global.height[c]! <= 0) continue;
          land++;
          if (zs.zone[c] !== 0xffff) zoned++;
        }
        const inRange = zs.records.filter(
          (z) => z.diameter >= 16_000 && z.diameter <= 63_000,
        ).length;
        const named = zs.records.filter((z) => z.name && z.recipe).length;
        const d = zs.records.map((z) => z.diameter / 1000).sort((a, b) => a - b);
        zoneRows.push(
          `| ${s} | ${zs.records.length} | ${pct(zoned / land)} | ${pct(inRange / zs.records.length)} | ` +
            `${d[Math.floor(d.length / 2)]!.toFixed(0)} | ${pct(named / zs.records.length)} | ` +
            `${zs.records
              .slice(0, 3)
              .map((z) => z.name)
              .join(', ')} |`,
        );
      }
      console.log(`seed ${s}: eroded metrics done`);
      // Incremental output: eroded worlds take minutes each.
      writeReport([...lines, ...erodedSection(gres, eroded, globalMs, zoneRows)]);
    }
    lines.push(...erodedSection(gres, eroded, globalMs, zoneRows));
  }
  writeReport(lines);
});

function erodedSection(
  gres: number,
  eroded: { seed: string; m: GridMetrics }[],
  globalMs: string[],
  zoneRows: string[] = [],
): string[] {
  return [
    `## Eroded global grid (${gres}² per face, decision 122's landform gain; entropy over 16 km windows, decision 205)`,
    '',
    ...summaryRows(eroded),
    '',
    '### Biomes over the eroded seeds',
    '',
    ...biomeTable(eroded),
    '',
    ...provinceTable(eroded),
    ...(zoneRows.length
      ? [
          '### Zones (decision 211)',
          '',
          '| seed | zones | land in a zone | 16–63 km | median diameter (km) | named, with recipe | first names |',
          '| --- | --- | --- | --- | --- | --- | --- |',
          ...zoneRows,
          '',
        ]
      : []),
    '### Global pass times',
    '',
    '| seed | stages |',
    '| --- | --- |',
    ...globalMs,
    '',
  ];
}

function writeReport(lines: string[]): void {
  const out = process.env.OUT ?? join('tools', 'out', 'diversity.md');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join('\n'));
  console.log(`wrote ${out}`);
}
