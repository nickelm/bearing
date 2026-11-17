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
 *   part by at most 4·10⁻⁹ m over the 519 s circuit. Two scenarios amplify V8's
 *   last-bit differences, the tumbling tail slide and the slide in a gale, and are
 *   compared within a hundred times the tolerance (decision 207: since the drag
 *   retune the tail slide parts by 10⁻⁵ m in 35 s).
 *
 * A change meant to alter the Kestrel's flight re-records the fixture and
 * says so in its decision:
 *
 * 1. `LOCKSTEP_RECORD=reset npx vitest run tests/flightLockstep.test.ts` under
 *    one Node version starts the fixture over: runs and that version's hashes.
 * 2. `LOCKSTEP_RECORD=1 …` under each other version adds its hashes, and fails
 *    if its runs disagree with the stored ones (so two versions cannot be
 *    recorded from different code). In a cloud session Node 24 runs as
 *    `PATH=/opt/node24/bin:$PATH node node_modules/vitest/vitest.mjs run …`.
 *
 * `LOCKSTEP_RECORD=1` also records a new scenario's run where none is stored.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIB, runScenario, SAMPLE_NAMES, SCENARIOS } from './helpers/lockstep';
import type { Digest } from './helpers/lockstep';

interface Fixture {
  /** Hash of each scenario by V8 major version. */
  hashes: Record<string, Record<string, string>>;
  /** Each scenario's run without its hash. */
  runs: Record<string, Omit<Digest, 'hash'>>;
}

const FIXTURE = new URL('./fixtures/flight-lockstep.json', import.meta.url);
const RECORD_MODE = process.env.LOCKSTEP_RECORD;
const RECORD = RECORD_MODE === '1' || RECORD_MODE === 'reset';
const V8 = process.versions.v8.split('.')[0]!;

/** Most difference allowed between versions, per sample quantity: position and velocity, attitude, rates, time. */
const TOLERANCE = [1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-9, 1e-9, 1e-9, 1e-9, 1e-8, 1e-8, 1e-8, 0];
/** Scenarios whose dynamics amplify the versions' last-bit differences, and the factor on their tolerance. */
const CHAOTIC: Readonly<Record<string, number>> = { 'tail-slide': 100, 'stand-gale': 100 };
const toleranceFor = (name: string) => TOLERANCE.map((t) => t * (CHAOTIC[name] ?? 1));

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
  const fixture: Fixture = RECORD_MODE === 'reset' ? { hashes: {}, runs: {} } : load();
  /** Scenarios recorded without a failed check; the fixture is written only if all were. */
  const recorded = new Set<string>();

  for (const name of SCENARIOS) {
    it(`flies "${name}" as recorded`, () => {
      // Through JSON, as the fixture holds it.
      const now = JSON.parse(JSON.stringify(runScenario(name))) as Digest;
      if (RECORD) {
        const { hash: _hash, ...run } = now;
        const stored = fixture.runs[name];
        if (stored) {
          // Another version's record of the same code: it must agree with this run.
          expect(run.steps, 'steps differ from the stored run: record with reset first').toBe(
            stored.steps,
          );
          expect(kinds(run.events)).toEqual(kinds(stored.events));
          expect(difference(run.samples, stored.samples, toleranceFor(name))).toBeNull();
        } else {
          fixture.runs[name] = run;
        }
        (fixture.hashes[V8] ??= {})[name] = now.hash;
        recorded.add(name);
        return;
      }
      const ref = fixture.runs[name];
      expect(ref, `no recorded run for "${name}"`).toBeDefined();
      expect(now.steps).toBe(ref!.steps);
      expect(now.crashed).toBe(ref!.crashed);
      expect(kinds(now.events)).toEqual(kinds(ref!.events));
      expect(difference(now.samples, ref!.samples, toleranceFor(name))).toBeNull();
      const hash = fixture.hashes[V8]?.[name];
      // The hash covers the events' text too (their times in full).
      if (hash !== undefined) {
        expect(now.hash, difference(ref!.samples, now.samples, null) ?? 'samples agree').toBe(hash);
      }
    });
  }

  it('tells one last bit at one step apart (negative control)', () => {
    const hash = fixture.hashes[V8]?.['hard-landing'];
    if (RECORD || hash === undefined) return;
    // The next double above the velocity's x after the air start, nothing else.
    const f = new Float64Array(1);
    const i = new BigInt64Array(f.buffer);
    const nudged = {
      ...LIB,
      spawnInAir: (...args: Parameters<typeof LIB.spawnInAir>) => {
        LIB.spawnInAir(...args);
        const m = args[0];
        f[0] = m.vel.x;
        i[0]! += m.vel.x >= 0 ? 1n : -1n;
        m.vel.x = f[0]!;
      },
    };
    expect(runScenario('hard-landing', nudged).hash).not.toBe(hash);
  });

  if (RECORD) {
    it('writes the fixture', () => {
      expect([...recorded].sort(), 'a scenario failed: the fixture is left as it was').toEqual(
        [...SCENARIOS].sort(),
      );
      writeFileSync(FIXTURE, JSON.stringify(fixture, null, 1) + '\n');
    });
  }
});
