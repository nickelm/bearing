/**
 * Settlement plans over seeds (proposal 0009, decision 260): plans every city and a
 * sample of towns and villages on the coarse campaign world (or the eroded grid's
 * heights with GLOBAL=1 is left for later), prints and writes the metrics, and draws
 * plans to PNG.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/cities.preview.ts
 *
 * env: SEEDS (default 4), FROM/COUNT (seed range), TOWNS (sample per seed, 12),
 * VILLAGES (12), DRAW (number of plans to draw per tier, 1), OUT (tools/out),
 * REPORT=path writes the Markdown metrics, ONLY=city|town|village.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { canopySeed } from '../src/worldgen/canopy';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { globalMapSampler } from '../src/worldgen/edits/airfields';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { settlementInput, settlementWorld } from '../src/worldgen/settlements/fromGraph';
import { boxCorners } from '../src/worldgen/settlements/geom';
import { planSettlement } from '../src/worldgen/settlements/plan';
import {
  DISTRICT_NAMES,
  Ground,
  STREET_NAMES,
  STYLE_NAMES,
  StreetKind,
  TARGET_NAMES,
  Tier,
  TIER_NAMES,
} from '../src/worldgen/settlements/types';
import type { SettlementPlan } from '../src/worldgen/settlements/types';
import { Canvas } from './cityDraw';
import { encodePng } from './png';

const GROUND_COLOR: Record<number, number> = {
  [Ground.Courtyard]: 0xc9bfae,
  [Ground.Garden]: 0xb9c79a,
  [Ground.Park]: 0x8fb070,
  [Ground.Square]: 0xe0d4bc,
  [Ground.Parking]: 0xa8a49c,
  [Ground.Concrete]: 0xb8b4ac,
  [Ground.Gravel]: 0xa89f8e,
  [Ground.Ballast]: 0x8c8378,
  [Ground.Sports]: 0x7fa860,
  [Ground.Cemetery]: 0x8a9a78,
};

function drawPlan(plan: SettlementPlan, extent: number, file: string, size = 1400): void {
  const c = new Canvas(size, size);
  const s = size / (2 * extent);
  const px = (x: number) => size / 2 + x * s;
  const py = (y: number) => size / 2 - y * s;
  const tp = (p: number[]) => p.map((v, i) => (i % 2 ? py(v) : px(v)));
  for (const b of plan.blocks) c.fill(tp(b.polygon), GROUND_COLOR[b.ground] ?? 0xcccccc);
  for (const p of plan.parcels) {
    const q = tp(p.polygon);
    for (let i = 0; i < q.length; i += 2) {
      const j = (i + 2) % q.length;
      if (s > 0.3) c.line(q[i]!, q[i + 1]!, q[j]!, q[j + 1]!, 0.6, 0xa09a8c);
    }
  }
  const widths = [3.2, 2.4, 1.5, 1.2, 0.8, 0.8];
  const colors = [0x5a4e40, 0x6e6252, 0x7a7062, 0x8a8070, 0xb07040, 0xd04030];
  for (const st of plan.streets) {
    const q = tp(st.points);
    for (let i = 0; i + 3 < q.length; i += 2) {
      c.line(
        q[i]!,
        q[i + 1]!,
        q[i + 2]!,
        q[i + 3]!,
        Math.max(0.8, widths[st.kind]! * s * 4),
        colors[st.kind]!,
      );
    }
  }
  for (const b of plan.buildings) {
    c.fill(tp(boxCorners(b.x, b.y, b.angle, b.halfLength, b.halfWidth)), b.roofColor);
  }
  for (const l of plan.landmarks) c.disk(px(l.x), py(l.y), Math.max(3, l.size * s), 0x2050c0);
  for (const t of plan.targets) {
    const q = tp(t.footprint);
    for (let i = 0; i < q.length; i += 2) {
      const j = (i + 2) % q.length;
      c.line(q[i]!, q[i + 1]!, q[j]!, q[j + 1]!, 2, 0xc02020);
    }
  }
  writeFileSync(file, encodePng(size, size, c.rgb));
}

it('plans settlements', () => {
  const seeds = process.env.SEEDS
    ? process.env.SEEDS.split(',')
    : process.env.FROM
      ? Array.from({ length: Number(process.env.COUNT ?? 20) }, (_, k) =>
          String(Number(process.env.FROM) + k),
        )
      : ['4'];
  const out = process.env.OUT ?? 'tools/out';
  mkdirSync(out, { recursive: true });
  const towns = Number(process.env.TOWNS ?? 12);
  const villages = Number(process.env.VILLAGES ?? 12);
  const draw = Number(process.env.DRAW ?? 1);
  const only = process.env.ONLY;
  const rows: string[] = [];
  const totals = {
    plans: [0, 0, 0],
    ms: [0, 0, 0],
    msMax: [0, 0, 0],
    buildings: [0, 0, 0],
    sloped: 0,
    along: 0,
    steep: 0,
    outside: 0,
    noFrontage: 0,
    inWater: 0,
    dropped: 0,
    blocks: 0,
    styles: new Map<string, number>(),
    worldMs: 0,
    districts: new Map<string, number>(),
    targets: new Map<string, number>(),
    streets: [0, 0, 0, 0, 0, 0],
  };
  for (const seed of seeds) {
    const t0 = performance.now();
    const w = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed });
    const worldMs = performance.now() - t0;
    totals.worldMs += worldMs;
    const m = w.world.maps;
    const n = w.graph.resolution;
    const height = globalMapSampler(m.height, n);
    const lake = globalMapSampler(m.lakeDepth, n);
    const g = w.graph;
    const t1 = performance.now();
    const sw = settlementWorld(
      g,
      DEFAULT_PLANET_PARAMS.radius,
      {
        height: (d) => height(d),
        water: (d) => height(d) <= 0 || lake(d) > 0.5,
      },
      (i) => m.biome[g.settlements.cells[i]!]!,
    );
    const setupMs = performance.now() - t1;
    const s = g.settlements;
    const order = [...s.population.keys()].sort((a, b) => s.population[b]! - s.population[a]!);
    const byTier: number[][] = [[], [], []];
    for (const i of order) byTier[sw.graph ? planTier(s.population[i]!) : 0]!.push(i);
    for (const i of order)
      totals.styles.set(
        STYLE_NAMES[sw.styles[i]!]!,
        (totals.styles.get(STYLE_NAMES[sw.styles[i]!]!) ?? 0) + 1,
      );
    const pickEvery = (l: number[], k: number) =>
      l.length <= k ? l : Array.from({ length: k }, (_, j) => l[Math.floor((j * l.length) / k)]!);
    const chosen = [byTier[0]!, pickEvery(byTier[1]!, towns), pickEvery(byTier[2]!, villages)];
    const drawn = [0, 0, 0];
    console.log(
      `seed ${seed}: world ${(worldMs / 1000).toFixed(1)} s, settlement setup ${setupMs.toFixed(0)} ms; cities ${byTier[0]!.length}, towns ${byTier[1]!.length}, villages ${byTier[2]!.length}`,
    );
    for (let tier = 0; tier < 3; tier++) {
      if (only && TIER_NAMES[tier] !== only) continue;
      for (const i of chosen[tier]!) {
        const input = settlementInput(sw, i);
        const plan = planSettlement(input, w.seed, {
          radius: DEFAULT_PLANET_PARAMS.radius,
          fieldSeed: canopySeed(w.seed),
        });
        const mt = plan.metrics;
        totals.plans[tier]!++;
        totals.ms[tier]! += mt.ms;
        totals.msMax[tier] = Math.max(totals.msMax[tier]!, mt.ms);
        totals.buildings[tier]! += plan.buildings.length;
        totals.sloped += mt.slopedMinor;
        totals.along += mt.slopedMinorAlong;
        totals.steep += mt.steepVehicle;
        totals.outside += mt.outsideParcel;
        totals.noFrontage += mt.noFrontage;
        totals.inWater += mt.inWater;
        totals.dropped += mt.droppedBlocks;
        totals.blocks += plan.blocks.length;
        mt.streetLength.forEach((l, k) => (totals.streets[k]! += l));
        for (const b of plan.blocks)
          totals.districts.set(
            DISTRICT_NAMES[b.district]!,
            (totals.districts.get(DISTRICT_NAMES[b.district]!) ?? 0) + 1,
          );
        for (const t of plan.targets)
          totals.targets.set(
            TARGET_NAMES[t.kind]!,
            (totals.targets.get(TARGET_NAMES[t.kind]!) ?? 0) + 1,
          );
        const line = `  ${TIER_NAMES[tier]} ${input.name} (${s.population[i]}, ${STYLE_NAMES[input.style]}): ${plan.streets.length} streets, ${plan.blocks.length} blocks (${mt.droppedBlocks} dropped), ${plan.parcels.length} parcels, ${plan.buildings.length} buildings, ${plan.landmarks.length} landmarks, ${plan.targets.length} targets; ${mt.ms.toFixed(0)} ms; sloped minor ${(mt.slopedMinor / 1000).toFixed(2)} km (${mt.slopedMinor ? ((100 * mt.slopedMinorAlong) / mt.slopedMinor).toFixed(0) : '-'}% along contours); steep ${mt.steepVehicle}, outside ${mt.outsideParcel}, no frontage ${mt.noFrontage}, in water ${mt.inWater}`;
        console.log(line);
        rows.push(
          `| ${seed} | ${TIER_NAMES[tier]} | ${input.name} | ${s.population[i]} | ${STYLE_NAMES[input.style]} | ${plan.streets.length} | ${plan.blocks.length} | ${plan.parcels.length} | ${plan.buildings.length} | ${plan.landmarks.length} | ${plan.targets.length} | ${mt.ms.toFixed(0)} |`,
        );
        if (drawn[tier]! < draw) {
          drawn[tier]!++;
          const extent = Math.max(...Array.from(input.outline)) * (tier === Tier.City ? 1.05 : 1.6);
          drawPlan(plan, extent, join(out, `city-${seed}-${TIER_NAMES[tier]}-${drawn[tier]}.png`));
        }
      }
    }
  }
  const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : '-');
  const summary = [
    `plans: ${totals.plans.join(' / ')} (city / town / village)`,
    `generation ms mean: ${totals.ms.map((m, k) => (totals.plans[k] ? (m / totals.plans[k]!).toFixed(0) : '-')).join(' / ')}, max ${totals.msMax.map((m) => m.toFixed(0)).join(' / ')}`,
    `buildings mean: ${totals.buildings.map((b, k) => (totals.plans[k] ? (b / totals.plans[k]!).toFixed(0) : '-')).join(' / ')}`,
    `minor streets on slopes > 10%: ${(totals.sloped / 1000).toFixed(1)} km, ${pct(totals.along, totals.sloped)}% within 30° of the contour`,
    `vehicle streets over the grade limit: ${totals.steep}; buildings outside their parcel: ${totals.outside}; parcels without frontage: ${totals.noFrontage}; buildings in water: ${totals.inWater}`,
    `blocks: ${totals.blocks}, dropped faces: ${totals.dropped}`,
    `street km by class: ${totals.streets.map((l, k) => `${STREET_NAMES[k]} ${(l / 1000).toFixed(0)}`).join(', ')}`,
    `styles (settlements): ${[...totals.styles].map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `districts (blocks): ${[...totals.districts].map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `targets: ${[...totals.targets].map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `world generation: ${(totals.worldMs / seeds.length / 1000).toFixed(1)} s per seed (coarse pass, casting, infrastructure; unchanged by plans, which build on demand)`,
  ];
  console.log(summary.join('\n'));
  if (process.env.REPORT) {
    writeFileSync(
      process.env.REPORT,
      [
        `Seeds: ${seeds.join(', ')}`,
        '',
        ...summary.map((l) => `- ${l}`),
        '',
        '| Seed | Tier | Name | Population | Style | Streets | Blocks | Parcels | Buildings | Landmarks | Targets | ms |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
      ].join('\n'),
    );
  }
  void StreetKind;
});

function planTier(population: number): number {
  return population >= 200_000 ? 0 : population >= 15_000 ? 1 : 2;
}
