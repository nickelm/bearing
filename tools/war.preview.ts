/**
 * A headless day of war (roadmap R1.3): builds each demo seed's campaign world
 * as the app does (the coarse pass at COARSE_RESOLUTION, the weather climate
 * from its maps, the default campaign start) and runs the campaign simulation
 * for HOURS game hours, twice:
 *
 * - **Stepped** as the worker steps it at RATE (30 steps per real second), with
 *   each new hour's weather fields computed as the worker sends them, to
 *   measure the worker's cost per game hour at that rate;
 * - **In one jump** (`seek`), as fast as it goes.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/war.preview.ts --disable-console-intercept
 *
 * Env: SEEDS (default the demo seeds), HOURS (24), RATE (64), OUT (tools/out/war.md).
 * Fails if a run throws or the two runs end in different states.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, it } from 'vitest';
import { DEMO_SEEDS } from '../src/campaign/demoSeeds';
import { defaultCampaignStart } from '../src/core/calendar';
import { CubeGrid } from '../src/core/cubeGrid';
import { HOUR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { campaignInput } from '../src/sim/command/campaignInput';
import { SimHost } from '../src/sim/host';
import { applyInput, createSimWorld } from '../src/sim/world';
import type { SimWorld } from '../src/sim/world';
import { buildWeatherClimate } from '../src/sim/weather/climate';
import { WeatherGrid } from '../src/sim/weather/grid';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { COARSE_RESOLUTION } from '../src/worldgen/coarsePass';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';

const SEEDS = process.env.SEEDS ? process.env.SEEDS.split(',').map(Number) : [...DEMO_SEEDS];
const HOURS = Number(process.env.HOURS ?? 24);
const RATE = Number(process.env.RATE ?? 64);
const OUT = process.env.OUT ?? 'tools/out/war.md';
/** The worker's steps per real second (workers/sim.worker.ts). */
const STEP_HZ = 30;

interface Report {
  seed: number;
  buildS: number;
  steppedMs: number;
  jumpMs: number;
  worstStepMs: number;
  hash: string;
  same: boolean;
  launched: string;
  /** Missions seen live, by type (sampled every step). */
  byType: string;
  completed: string;
  meanAirborne: number;
  maxAirborne: number;
  squadrons: number;
  weatherSystems: number;
  logEntries: number;
  /** The air tasking orders (R2.1), per side: orders, revisions, sorties planned and committed, cancellations by reason. */
  ato: string[];
  /** Missions seen by type and side, for the four demo types. */
  demo: string;
  /** Resolution (R2.2): losses, intercepts, outcomes, damage, deliveries. */
  war: string[];
  error: string | null;
}

function day(seed: number): Report {
  const t0 = performance.now();
  const params = { ...DEFAULT_PLANET_PARAMS, seed };
  const w = generateCampaignWorld(params, { grid: new CubeGrid(COARSE_RESOLUTION) });
  const radius = params.radius;
  const climate = buildWeatherClimate(
    { ...w.world.maps, resolution: w.world.info.resolution, reliefScale: w.world.info.reliefScale },
    new WeatherGrid(),
    radius,
  );
  const calendar = defaultCampaignStart(new Vec3d(...w.world.info.mainContinent), params);
  const campaign = campaignInput(w.graph, w.campaign.cast, w.infrastructure);
  // As main.ts starts it: the coarse heights are the ground under routes (R1.6).
  const ground = { height: w.world.maps.height, n: w.world.info.resolution };
  const config = {
    seed: String(w.seed),
    radius,
    orbit: params,
    calendar,
    climate,
    campaign,
    ground,
  };
  // The worker hands the sim its own copy of the climate; so does each world here.
  const make = (): SimWorld =>
    createSimWorld({ ...config, climate: structuredClone(config.climate) });
  const buildS = (performance.now() - t0) / 1000;
  const end = HOURS * HOUR;
  const report: Report = {
    seed,
    buildS,
    steppedMs: NaN,
    jumpMs: NaN,
    worstStepMs: 0,
    hash: '',
    same: false,
    launched: '',
    byType: '',
    completed: '',
    meanAirborne: 0,
    maxAirborne: 0,
    squadrons: 0,
    weatherSystems: 0,
    logEntries: 0,
    ato: [],
    demo: '',
    war: [],
    error: null,
  };
  try {
    const stepped = new SimHost(make, applyInput);
    stepped.rate = RATE;
    stepped.autoSlowdown = false;
    const seen = new Map<string, string>();
    let airborne = 0;
    let samples = 0;
    let nextSample = 0;
    const sent = new Set<number>();
    const s0 = performance.now();
    while (stepped.time < end) {
      const a = performance.now();
      stepped.step(Math.min(1 / STEP_HZ, (end - stepped.time) / RATE));
      // The worker sends each new hour's weather fields to the main thread (sim.worker.ts).
      for (const h of stepped.world.weather.availableHours()) {
        if (!sent.has(h)) {
          sent.add(h);
          stepped.world.weather.frame(h);
        }
      }
      report.worstStepMs = Math.max(report.worstStepMs, performance.now() - a);
      const air = stepped.world.air!;
      for (const m of air.missions.values()) seen.set(`${m.side}:${m.id}`, `${m.side}:${m.type}`);
      if (stepped.time >= nextSample) {
        const n = air.airborneAt('alliance', stepped.time) + air.airborneAt('pact', stepped.time);
        airborne += n;
        report.maxAirborne = Math.max(report.maxAirborne, n);
        samples++;
        nextSample += 10 * 60;
      }
    }
    report.steppedMs = performance.now() - s0;
    report.meanAirborne = airborne / Math.max(1, samples);
    const j0 = performance.now();
    const jump = new SimHost(make, applyInput);
    jump.seek(end);
    report.jumpMs = performance.now() - j0;
    const sw = stepped.world;
    report.hash = sw.sim.hash();
    report.same = report.hash === jump.world.sim.hash();
    const air = sw.air!;
    report.launched = `${air.launched.alliance}/${air.launched.pact}`;
    report.completed = `${air.completed.alliance}/${air.completed.pact}`;
    const counts = new Map<string, number>();
    const bySide = new Map<string, number>();
    for (const st of seen.values()) {
      const t = st.slice(st.indexOf(':') + 1);
      counts.set(t, (counts.get(t) ?? 0) + 1);
      bySide.set(st, (bySide.get(st) ?? 0) + 1);
    }
    report.demo = ['cap', 'interdiction', 'cas', 'airlift']
      .map((t) => `${t} ${bySide.get(`alliance:${t}`) ?? 0}/${bySide.get(`pact:${t}`) ?? 0}`)
      .join(', ');
    const res = sw.resolution!;
    for (const side of ['alliance', 'pact'] as const) {
      const st = res.stats[side];
      report.war.push(
        `${side}: ${air.lost[side]} aircraft lost (${air.killed[side]} aircrew killed), ` +
          `${air.survivors.filter((x) => x.side === side).length} survivors down; ` +
          `${st.intercepts} intercepts by its CAP; ${st.resolved} missions resolved, ${st.successes} successful; ` +
          `${st.hits} target hits, ${st.deliveries} deliveries`,
      );
    }
    const dmg = sw.damage!;
    const sites = dmg.damaged();
    const cut = sites.filter((x) => campaign.targets[x.id]!.bridge && x.damage >= 0.5).length;
    report.war.push(
      `damage: ${sites.length} sites hit (${cut} bridges cut), ${dmg.damagedRoads().length} road edges, ` +
        `${dmg.attacks.length} attacks on troops; aborts ${sw.sim.log.entries.filter((e) => e.source === 'decision' && e.kind === 'mission-aborted').length}`,
    );
    const ato = sw.ato!;
    for (const side of ['alliance', 'pact'] as const) {
      const st = ato.stats[side];
      const cancelled = Object.entries(st.cancelled)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([k, n]) => `${k} ${n}`)
        .join(', ');
      const unfilled = Object.entries(st.unfilled)
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(
          ([t, rs]) =>
            `${t} (${Object.entries(rs)
              .map(([k, n]) => `${k} ${n}`)
              .join(', ')})`,
        )
        .join('; ');
      report.ato.push(
        `${side}: ${st.orders} orders, ${st.revisions} revisions, ${st.planned} sorties planned, ` +
          `${st.committed} committed; cancelled: ${cancelled || 'none'}; unfilled: ${unfilled || 'none'}`,
      );
    }
    report.byType = [...counts]
      .sort((x, y) => y[1] - x[1])
      .map(([t, n]) => `${t} ${n}`)
      .join(', ');
    report.squadrons = air.squadrons.length;
    report.weatherSystems = sw.weather.systems.length;
    report.logEntries = sw.sim.log.size;
  } catch (err) {
    report.error = String(err instanceof Error ? (err.stack ?? err.message) : err);
  }
  return report;
}

it('runs a day of war on the demo seeds', () => {
  const reports = SEEDS.map(day);
  const realPerGameHour = HOUR / RATE;
  const lines = [
    `# Headless day of war`,
    '',
    `${HOURS} game hours per seed, stepped at ${RATE}× (${STEP_HZ} steps per real second, ` +
      `${realPerGameHour.toFixed(1)} real seconds per game hour) and in one jump. Node ${process.version}.`,
    '',
    '| Seed | Build (s) | Stepped: ms per game hour | Share of real time at ' +
      `${RATE}× | Worst step (ms) | Jump: ms per game hour | Missions launched (A/P) | Completed | ` +
      'Airborne mean / max | Squadrons | Weather systems | Log entries | Hash | Same |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of reports) {
    const perHour = r.steppedMs / HOURS;
    lines.push(
      `| ${r.seed} | ${r.buildS.toFixed(1)} | ${perHour.toFixed(1)} | ` +
        `${((perHour / 1000 / realPerGameHour) * 100).toFixed(2)}% | ${r.worstStepMs.toFixed(1)} | ` +
        `${(r.jumpMs / HOURS).toFixed(1)} | ${r.launched} | ${r.completed} | ` +
        `${r.meanAirborne.toFixed(1)} / ${r.maxAirborne} | ${r.squadrons} | ${r.weatherSystems} | ` +
        `${r.logEntries} | \`${r.hash}\` | ${r.same ? 'yes' : '**no**'} |`,
    );
  }
  lines.push('', 'Missions seen by type, both sides:', '');
  for (const r of reports) lines.push(`- Seed ${r.seed}: ${r.byType || 'none'}`);
  lines.push('', 'The demo types by side (Alliance/Pact):', '');
  for (const r of reports) lines.push(`- Seed ${r.seed}: ${r.demo}`);
  lines.push('', 'Resolution:', '');
  for (const r of reports) for (const a of r.war) lines.push(`- Seed ${r.seed}, ${a}`);
  lines.push('', 'Air tasking orders:', '');
  for (const r of reports) for (const a of r.ato) lines.push(`- Seed ${r.seed}, ${a}`);
  for (const r of reports)
    if (r.error) lines.push('', `Seed ${r.seed} failed:`, '', '```', r.error, '```');
  const text = lines.join('\n') + '\n';
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(text);
  for (const r of reports) {
    expect(r.error, `seed ${r.seed}`).toBeNull();
    expect(r.same, `seed ${r.seed}: stepped and jumped runs differ`).toBe(true);
  }
});
