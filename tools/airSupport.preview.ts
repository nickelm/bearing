/**
 * The ground war with and without one side's air support (roadmap R2.3): each
 * seed's campaign, built as the app builds it, run for HOURS game hours three
 * times in one jump: as is, with the Alliance flying no strikes and no ground
 * support, and with the Pact flying none. Reports each run's front (offset per
 * segment, km toward the defender) and strengths, and how far the suppressed
 * runs' fronts end from the full run's.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/airSupport.preview.ts --disable-console-intercept
 *
 * Env: SEEDS (default the demo seeds), HOURS (24), OUT (tools/out/air-support.md).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, it } from 'vitest';
import type { Side } from '../src/campaign/cast';
import { DEMO_SEEDS } from '../src/campaign/demoSeeds';
import { defaultCampaignStart } from '../src/core/calendar';
import { CubeGrid } from '../src/core/cubeGrid';
import { HOUR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { campaignInput } from '../src/sim/command/campaignInput';
import { SimHost } from '../src/sim/host';
import { applyInput, createSimWorld } from '../src/sim/world';
import { buildWeatherClimate } from '../src/sim/weather/climate';
import { WeatherGrid } from '../src/sim/weather/grid';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { COARSE_RESOLUTION } from '../src/worldgen/coarsePass';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';

const SEEDS = process.env.SEEDS ? process.env.SEEDS.split(',').map(Number) : [...DEMO_SEEDS];
const HOURS = Number(process.env.HOURS ?? 24);
const OUT = process.env.OUT ?? 'tools/out/air-support.md';

interface Run {
  label: string;
  offsets: number[];
  strength: Record<Side, number>;
  attacks: number;
  cut: number;
}

function runs(seed: number): { seed: number; attacker: Side; runs: Run[] } {
  const params = { ...DEFAULT_PLANET_PARAMS, seed };
  const w = generateCampaignWorld(params, { grid: new CubeGrid(COARSE_RESOLUTION) });
  const climate = buildWeatherClimate(
    { ...w.world.maps, resolution: w.world.info.resolution, reliefScale: w.world.info.reliefScale },
    new WeatherGrid(),
    params.radius,
  );
  const campaign = campaignInput(w.graph, w.campaign.cast, w.infrastructure);
  const front = campaign.fronts[0]!;
  const base = {
    seed: String(w.seed),
    radius: params.radius,
    orbit: params,
    calendar: defaultCampaignStart(new Vec3d(...w.world.info.mainContinent), params),
    campaign,
    ground: { height: w.world.maps.height, n: w.world.info.resolution },
  };
  const out: Run[] = [];
  for (const suppress of [null, 'alliance', 'pact'] as const) {
    const host = new SimHost(
      () =>
        createSimWorld({
          ...base,
          climate: structuredClone(climate),
          suppressAirSupport: suppress,
        }),
      applyInput,
    );
    host.seek(HOURS * HOUR);
    const g = host.world.ground!;
    const dmg = host.world.damage!;
    out.push({
      label: suppress ? `no ${suppress} air support` : 'full air war',
      offsets: g.frontOffsets(front.theater),
      strength: {
        alliance: g.strengthOf(front.theater, 'alliance'),
        pact: g.strengthOf(front.theater, 'pact'),
      },
      attacks: dmg.attacks.length,
      cut: dmg.damaged().filter((x) => campaign.targets[x.id]!.bridge && x.damage >= 0.5).length,
    });
  }
  return { seed, attacker: front.attacker, runs: out };
}

it('compares the front with and without each side’s air support', () => {
  const results = SEEDS.map(runs);
  const km = (x: number) => (x / 1000).toFixed(1);
  const lines = [
    '# The front with and without air support',
    '',
    `${HOURS} game hours per seed in one jump. Offsets per front segment in km, + toward the defender; ` +
      'strength in battalion equivalents; the difference is the largest change of a segment against the full run.',
    '',
  ];
  for (const r of results) {
    lines.push(`## Seed ${r.seed} (attacker: ${r.attacker})`, '');
    lines.push(
      '| Run | Offsets (km) | Mean | Alliance | Pact | Attacks on troops | Bridges cut | Largest change |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    const full = r.runs[0]!;
    for (const run of r.runs) {
      const mean = run.offsets.reduce((a, b) => a + b, 0) / run.offsets.length;
      const change = Math.max(...run.offsets.map((o, i) => Math.abs(o - full.offsets[i]!)));
      lines.push(
        `| ${run.label} | ${run.offsets.map(km).join(', ')} | ${km(mean)} | ${run.strength.alliance.toFixed(1)} | ` +
          `${run.strength.pact.toFixed(1)} | ${run.attacks} | ${run.cut} | ${km(change)} |`,
      );
    }
    lines.push('');
  }
  const text = lines.join('\n') + '\n';
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(text);
  for (const r of results) {
    const full = r.runs[0]!.offsets;
    for (const run of r.runs.slice(1)) {
      expect(run.offsets, `seed ${r.seed}: ${run.label}`).not.toEqual(full);
    }
  }
}, 1_200_000);
