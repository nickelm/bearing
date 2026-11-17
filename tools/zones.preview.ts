/**
 * Zones (decision 210) recomputed on cached eroded worlds, with the current
 * code, without the GPU: reads the worlds `tools/previewWorld.ts` stored in the
 * OS temp directory and prints each one's zone statistics.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/zones.preview.ts
 *
 * Env: SEEDS (comma list; default every cached world).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserialize } from 'node:v8';
import { it } from 'vitest';
import type { StoredWorld } from '../src/worldgen/worldStore';
import { segmentZones } from '../src/worldgen/zones';

it('recomputes zones on cached worlds', () => {
  const dir = join(tmpdir(), 'bearing-tools-worlds');
  const want = process.env.SEEDS?.split(',').map((s) => s.trim());
  const rows = [
    '| world | zones | 16–63 km | median km | > 63 km | islets left |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const file of readdirSync(dir).sort()) {
    const seed = file.split('-')[0]!;
    if (want && !want.includes(seed)) continue;
    const w = deserialize(readFileSync(join(dir, file))) as StoredWorld;
    const g = w.global;
    const fin = g.finish;
    if (!fin.province) continue;
    const z = segmentZones(
      g.n,
      g.height,
      fin.biome,
      fin.province,
      fin.drainage.discharge,
      1e6,
      seed,
    );
    const d = z.records.map((r) => r.diameter / 1000).sort((a, b) => a - b);
    const inRange = d.filter((x) => x >= 16 && x <= 63).length;
    rows.push(
      `| ${file} | ${z.records.length} | ${((100 * inRange) / d.length).toFixed(1)}% | ${d[Math.floor(d.length / 2)]!.toFixed(0)} | ${d.filter((x) => x > 63).length} | ${d.filter((x) => x < 16).length} |`,
    );
  }
  console.log(rows.join('\n'));
}, 3_600_000);
