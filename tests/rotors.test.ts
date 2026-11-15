/** Helicopter rotors in model specs, the builder and the flown view (decision 149). */
import { describe, expect, it } from 'vitest';
import {
  buildAnimatedModel,
  buildModel,
  buildRotors,
  DISC_BANDS,
  DISC_RIM_ALPHA,
  rotorFrame,
  withinBudget,
} from '../src/render/common/models/builder';
import { MODEL_SPECS } from '../src/render/common/models/library';
import { ModelSpecError, validateSpec } from '../src/render/common/models/spec';
import type { ModelSpec } from '../src/render/common/models/spec';
import { rotorBlend } from '../src/render/sim/aircraft/aircraftView';

const MAIN = { hub: [0, 2.6, 0], radius: 4, blades: 5, chord: 0.17, direction: 1, group: 'r' };
const TAIL = {
  hub: [-4.9, 1.5, -0.25],
  axis: [0, 0, -1],
  radius: 0.7,
  blades: 2,
  chord: 0.1,
  direction: 1,
  group: 'r',
};

const spec = (rotors: unknown, extra: object = {}): ModelSpec =>
  validateSpec(
    {
      name: 'test',
      class: 'helicopter',
      groups: { a: '#808080', r: '#34373A' },
      parts: [{ type: 'box', group: 'a', center: [0, 1, 0], size: [3, 1.5, 1.4] }],
      rotors,
      ...extra,
    },
    'test',
  );

describe('rotor specs', () => {
  it('accepts main and tail rotors', () => {
    expect(spec([MAIN, TAIL]).rotors).toHaveLength(2);
    expect(spec([{ ...MAIN, disc: 'a', direction: -1 }]).rotors![0]!.disc).toBe('a');
  });

  it('rejects bad rotors with the path and the reason', () => {
    const bad: [object, RegExp][] = [
      [{ ...MAIN, blades: 1 }, /rotors\[0\]\.blades: must be a whole number 2–8/],
      [{ ...MAIN, blades: 9 }, /blades/],
      [{ ...MAIN, blades: 2.5 }, /blades/],
      [{ ...MAIN, direction: 0 }, /rotors\[0\]\.direction: must be 1 or -1/],
      [{ ...MAIN, axis: [0, 2, 0] }, /rotors\[0\]\.axis: must be a unit vector/],
      [{ ...MAIN, axis: [0, 1] }, /axis/],
      [{ ...MAIN, radius: 0 }, /rotors\[0\]\.radius: must be positive/],
      [{ ...MAIN, chord: 2.5 }, /rotors\[0\]\.chord: must be positive and under half/],
      [{ ...MAIN, hub: undefined }, /rotors\[0\]\.hub: must be \[x, y, z\]/],
      [{ ...MAIN, group: 'nope' }, /rotors\[0\]\.group: group "nope" has no color/],
      [{ ...MAIN, disc: 'nope' }, /rotors\[0\]\.disc: group "nope" has no color/],
    ];
    for (const [r, msg] of bad) {
      expect(() => spec([MAIN, r].slice(1)), JSON.stringify(r)).toThrow(ModelSpecError);
      expect(() => spec([r]), JSON.stringify(r)).toThrow(msg);
    }
    expect(() => spec(MAIN)).toThrow(/rotors: must be a list/);
  });
});

describe('built rotors', () => {
  it('builds a six-sided hub, plank blades and a banded disc per rotor', () => {
    const s = spec([MAIN, TAIL]);
    const [main, tail] = buildRotors(s, { noAo: true });
    expect(main!.hubModel.triangles).toBe(20);
    expect(main!.blades.triangles).toBe(5 * 12);
    expect(tail!.blades.triangles).toBe(2 * 12);
    // A fan, three rings and the rim: 24 sectors on a main rotor, 12 on a small tail rotor.
    expect(main!.disc.triangles).toBe(24 + 3 * 48 + 48);
    expect(tail!.disc.triangles).toBe(12 + 3 * 24 + 24);
    expect(tail!.axis).toEqual([0, 0, -1]);
    for (const r of [main!, tail!]) {
      const d = r.disc;
      const sides = r.radius >= 2 ? 24 : 12;
      const bands = d.triangles - 2 * sides;
      let maxR = 0;
      for (let i = 0; i < bands * 9; i += 3) {
        const p = [0, 1, 2].map((k) => d.position[i + k]! - r.hub[k]!);
        // The bands lie in the rotor's plane, facing along its axis.
        expect(Math.abs(p[0]! * r.axis[0] + p[1]! * r.axis[1] + p[2]! * r.axis[2])).toBeLessThan(
          1e-5,
        );
        maxR = Math.max(maxR, Math.hypot(p[0]!, p[1]!, p[2]!));
        for (let k = 0; k < 3; k++) expect(d.normal[i + k]).toBeCloseTo(r.axis[k]!, 6);
      }
      expect(maxR).toBeCloseTo(r.radius, 4);
      // The rim faces outward, across the plane.
      for (let i = bands * 9; i < d.position.length; i += 3) {
        const n = [0, 1, 2].map((k) => d.normal[i + k]!);
        expect(Math.abs(n[0]! * r.axis[0] + n[1]! * r.axis[1] + n[2]! * r.axis[2])).toBeLessThan(
          1e-6,
        );
      }
      // One alpha per face, from the bands.
      for (let t = 0; t < d.triangles; t++) {
        expect(d.alpha[t * 3]).toBe(d.alpha[t * 3 + 1]);
        expect(d.alpha[t * 3]).toBe(d.alpha[t * 3 + 2]);
      }
      expect([...new Set(d.alpha)].sort()).toEqual(
        [...DISC_BANDS.map((b) => b[2]), DISC_RIM_ALPHA].map((a) => Math.fround(a)).sort(),
      );
    }
    // Opacity falls outward through the fan and rings; the tip ring is a little stronger.
    const a = DISC_BANDS.map((b) => b[2]);
    expect(a[0]!).toBeGreaterThan(a[1]!);
    expect(a[1]!).toBeGreaterThan(a[2]!);
    expect(a[3]!).toBeGreaterThan(a[2]!);
    expect(Math.max(...a)).toBeLessThan(0.5);
  });

  it('points the first blade aft at azimuth 0 and turns the next one in the direction of rotation', () => {
    const f = rotorFrame(MAIN as never);
    expect(f.u).toEqual([-1, 0, 0]);
    // v = axis × u: a quarter turn counterclockwise seen from above is to starboard (+z).
    expect(f.v[2]).toBeCloseTo(1, 9);
    const [main] = buildRotors(spec([MAIN]), { noAo: true });
    expect(main!.blades.bounds.min[0]).toBeCloseTo(-MAIN.radius, 4);
    // Blade 2 of 5 is 72° on: counterclockwise from above, toward starboard.
    const blade = (k: number) => main!.blades.position.subarray(k * 108, (k + 1) * 108);
    const z = (b: Float32Array) => b.filter((_, i) => i % 3 === 2).reduce((x, y) => x + y) / 36;
    expect(z(blade(1))).toBeGreaterThan(0.5);
  });

  it('puts hub and stopped blades in the static model and splits them out for the flown view', () => {
    const s = spec([MAIN, TAIL]);
    const whole = buildModel(s, { noAo: true });
    const body = buildModel({ ...s, rotors: undefined }, { noAo: true });
    expect(whole.triangles).toBe(body.triangles + 2 * 20 + 7 * 12);
    // Rotors only add triangles after the parts': the parts' geometry is unchanged.
    for (const k of ['position', 'normal', 'color'] as const)
      expect(whole[k].subarray(0, body[k].length)).toEqual(body[k]);
    const a = buildAnimatedModel(s, { noAo: true });
    expect(a.rotors).toHaveLength(2);
    const n =
      a.body.triangles +
      a.pieces.reduce((x, p) => x + p.model.triangles, 0) +
      a.rotors.reduce((x, r) => x + r.hubModel.triangles + r.blades.triangles, 0);
    expect(n).toBe(whole.triangles);
  });

  it('leaves models without rotors as they were', () => {
    for (const id of ['alliance-fighter', 'pact-strike', 'hangar']) {
      const s = MODEL_SPECS[id]!;
      expect(s.rotors).toBeUndefined();
      expect(buildAnimatedModel(s, { noAo: true }).rotors).toEqual([]);
    }
  });

  it('has the two H1 helicopters within the helicopter budget, discs aside', () => {
    for (const [id, blades] of [
      ['alliance-scout-helo', [5, 2]],
      ['alliance-utility-helo', [4, 4]],
    ] as const) {
      const s = MODEL_SPECS[id]!;
      expect(s.class).toBe('helicopter');
      expect(s.rotors!.map((r) => r.blades)).toEqual(blades);
      const m = buildModel(s);
      expect(withinBudget(m), `${id}: ${m.triangles}`).toBe(true);
      // Standing on the ground, x forward, with red to port and green to starboard.
      expect(m.bounds.min[1]).toBeCloseTo(0, 2);
      expect(m.emissives.find((e) => e.kind === 'nav-red')!.position[2]).toBeLessThan(0);
      expect(m.emissives.find((e) => e.kind === 'nav-green')!.position[2]).toBeGreaterThan(0);
      expect(m.emissives.some((e) => e.kind === 'beacon')).toBe(true);
      expect(buildRotors(s).every((r) => r.disc.triangles > 0)).toBe(true);
    }
  });
});

describe('rotor blend', () => {
  it('shows blades when slow, the disc when fast, and crossfades between', () => {
    expect(rotorBlend(0)).toEqual({ blades: 1, disc: 0 });
    expect(rotorBlend(0.3)).toEqual({ blades: 1, disc: 0 });
    expect(rotorBlend(0.7)).toEqual({ blades: 0, disc: 1 });
    expect(rotorBlend(1.1)).toEqual({ blades: 0, disc: 1 });
    const mid = rotorBlend(0.5);
    expect(mid.blades).toBeCloseTo(0.5, 9);
    expect(mid.blades + mid.disc).toBeCloseTo(1, 9);
  });
});
