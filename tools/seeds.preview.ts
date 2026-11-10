/**
 * Seed browser, CLI version (milestone 4): runs the coarse pass, theater
 * detection and casting for a range of seeds and prints a table of the
 * theaters each produces, with fit scores, the range factor and retries.
 *
 *   npm run seeds                       # seeds 1..20
 *   SEEDS=1983,7,42 npm run seeds
 *   FROM=100 COUNT=50 npm run seeds
 *   BRIEFING=1 SEEDS=7 npm run seeds    # also print the briefing
 *
 * Writes tools/out/seeds.tsv (one row per seed) and a summary of how often
 * each theater appears, to tune the fit thresholds (design open question).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { THEATER_LABELS } from '../src/campaign/theaters';
import type { TheaterKind } from '../src/campaign/theaters';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { COARSE_RESOLUTION } from '../src/worldgen/coarsePass';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';

const KINDS = Object.keys(THEATER_LABELS) as TheaterKind[];
const SHORT: Record<TheaterKind, string> = {
  'continental-front': 'front',
  'sea-lane': 'lane',
  chokepoint: 'choke',
  'island-campaign': 'islands',
  strategic: 'strat',
};

function seedList(): string[] {
  if (process.env.SEEDS) return process.env.SEEDS.split(',').map((s) => s.trim());
  const from = Number(process.env.FROM ?? 1);
  const count = Number(process.env.COUNT ?? 20);
  return Array.from({ length: count }, (_, i) => String(from + i));
}

it('seed browser', () => {
  const res = Number(process.env.RES ?? COARSE_RESOLUTION);
  const grid = new CubeGrid(res);
  const rows: string[] = [];
  const header = [
    'seed',
    'retries',
    'land%',
    'nodes',
    'lanes',
    'chokes',
    ...KINDS.map((k) => SHORT[k]),
    'best fits',
    'range',
    'bases A/P',
    'ms',
  ];
  rows.push(header.join('\t'));
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<TheaterKind, number>;
  const factors: number[] = [];
  let invalid = 0;
  const lines: string[] = [];
  for (const seed of seedList()) {
    const t0 = performance.now();
    const w = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed }, { grid });
    const ms = performance.now() - t0;
    const { detection, cast, validity } = w.campaign;
    const placed = (side: string) =>
      w.infrastructure.airbases.filter((a) => a.side === side).length;
    if (!validity.valid) invalid++;
    const perKind = KINDS.map((k) => detection.selected.filter((t) => t.kind === k).length);
    KINDS.forEach((k, i) => (counts[k] += perKind[i]! > 0 ? 1 : 0));
    factors.push(cast.rangeFactor);
    const best = KINDS.filter((k) => k !== 'strategic')
      .map((k) => {
        const c = detection.candidates.filter((t) => t.kind === k);
        return c.length ? `${SHORT[k]} ${Math.max(...c.map((x) => x.fit)).toFixed(2)}` : null;
      })
      .filter(Boolean)
      .join(', ');
    const row = [
      seed,
      `${w.retries}${validity.valid ? '' : ' INVALID'}`,
      (w.world.info.landFraction * 100).toFixed(0),
      w.graph.nodes.length,
      w.graph.lanes.length,
      w.graph.chokepoints.length,
      ...perKind,
      best,
      cast.rangeFactor.toFixed(2),
      `${cast.airbases.alliance}/${cast.airbases.pact}`,
      ms.toFixed(0),
    ];
    rows.push(row.join('\t'));
    lines.push(
      `${seed.padStart(6)}  retries ${w.retries}${validity.valid ? '' : ' INVALID'}  ` +
        `${cast.theaters.map((t) => `${SHORT[t.kind]}(${t.fit.toFixed(2)})`).join(' ')}  ` +
        `range ${cast.rangeFactor.toFixed(2)}  sites ${cast.airbases.alliance}/${cast.airbases.pact}  ` +
        `bases ${placed('alliance')}/${placed('pact')}  towns ${w.graph.settlements.cells.length}  ` +
        `roads ${w.graph.roads.count}  bridges ${w.graph.bridges.cells.length}  ${(ms / 1000).toFixed(1)} s` +
        (w.rejected.length
          ? `\n        rejected: ${w.rejected.map((r) => r.join('; ')).join(' | ')}`
          : ''),
    );
    if (process.env.BRIEFING === '1') lines.push(`\n${cast.briefing}\n`);
  }
  const n = factors.length;
  const summary = [
    `${n} seeds, ${invalid} invalid after retries`,
    ...KINDS.map(
      (k) => `${THEATER_LABELS[k].padEnd(18)} ${counts[k]} (${Math.round((100 * counts[k]) / n)}%)`,
    ),
    `range factor: min ${Math.min(...factors).toFixed(2)}, mean ${(factors.reduce((a, b) => a + b, 0) / n).toFixed(2)}, max ${Math.max(...factors).toFixed(2)}`,
  ];
  console.info([...lines, '', ...summary].join('\n'));
  const outDir = join(import.meta.dirname, 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'seeds.tsv'), rows.join('\n') + '\n');
});
