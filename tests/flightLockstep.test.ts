/**
 * The Kestrel's flight, bit for bit (track H, step 0). The fixture
 * `fixtures/flight-lockstep.json` was recorded before the airframe split,
 * and every scenario of `helpers/lockstep.ts` must still give it.
 *
 * - **Exact.** The fixture holds each scenario's hash of every step's state per
 *   V8 major version (Node 22 and Node 24 so far). V8's Math functions differ in
 *   the last bit between versions, so the hash is compared only on a version it
 *   was recorded on.
 * - **Close.** On every version, the samples every 5 s must agree within a
 *   micrometer and the steps, crash and event kinds exactly. Node 22 and Node 24
 *   part by at most 4·10⁻⁹ m over the 519 s circuit.
 *
 * A change meant to alter the Kestrel's flight re-records the fixture with
 * `LOCKSTEP_RECORD=1 npx vitest run tests/flightLockstep.test.ts`, once per
 * Node version (`PATH=/opt/node24/bin:$PATH node node_modules/vitest/vitest.mjs
 * run …` in a cloud session), and says so in its decision.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runScenario, SAMPLE_NAMES, SCENARIOS } from './helpers/lockstep';
import type { Digest } from './helpers/lockstep';

interface Fixture {
  /** Hash of each scenario by V8 major version. */
  hashes: Record<string, Record<string, string>>;
  /** Each scenario's run without its hash. */
  runs: Record<string, Omit<Digest, 'hash'>>;
}

const FIXTURE = new URL('./fixtures/flight-lockstep.json', import.meta.url);
const RECORD = process.env.LOCKSTEP_RECORD === '1';
const V8 = process.versions.v8.split('.')[0]!;

/** Most difference allowed between versions, per sample quantity: position and velocity, attitude, rates, time. */
const TOLERANCE = [1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-9, 1e-9, 1e-9, 1e-9, 1e-8, 1e-8, 1e-8, 0];

function load(): Fixture {
  try {
    return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;
  } catch {
    return { hashes: {}, runs: {} };
  }
}

/** The first sample quantity that differs by more than `tolerance` (0: by anything), or null. */
function difference(
  a: readonly number[][],
  b: readonly number[][],
  tolerance: readonly number[] | null,
): string | null {
  if (a.length !== b.length) return `${a.length} samples vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    for (let k = 0; k < SAMPLE_NAMES.length; k++) {
      const x = a[i]![k]!;
      const y = b[i]![k]!;
      const off = tolerance ? Math.abs(x - y) > tolerance[k]! : !Object.is(x, y);
      if (off) return `sample ${i} (t ≈ ${i * 5} s): ${SAMPLE_NAMES[k]} ${x} vs ${y}`;
    }
  }
  return null;
}

const kinds = (events: readonly string[]) => events.map((e) => e.split(' ')[0]);

describe('the Kestrel in lockstep with its recorded flight', () => {
  const fixture = load();

  for (const name of SCENARIOS) {
    it(`flies "${name}" as recorded`, () => {
      // Through JSON, as the fixture holds it.
      const now = JSON.parse(JSON.stringify(runScenario(name))) as Digest;
      if (RECORD) {
        (fixture.hashes[V8] ??= {})[name] = now.hash;
        const { hash: _hash, ...run } = now;
        fixture.runs[name] ??= run;
        return;
      }
      const ref = fixture.runs[name];
      expect(ref, `no recorded run for "${name}"`).toBeDefined();
      expect(now.steps).toBe(ref!.steps);
      expect(now.crashed).toBe(ref!.crashed);
      expect(kinds(now.events)).toEqual(kinds(ref!.events));
      expect(difference(now.samples, ref!.samples, TOLERANCE)).toBeNull();
      const hash = fixture.hashes[V8]?.[name];
      // The hash covers the events' text too (their times in full).
      if (hash !== undefined) {
        expect(now.hash, difference(ref!.samples, now.samples, null) ?? 'samples agree').toBe(hash);
      }
    });
  }

  if (RECORD) {
    it('writes the fixture', () => {
      writeFileSync(FIXTURE, JSON.stringify(fixture, null, 1) + '\n');
    });
  }
});
