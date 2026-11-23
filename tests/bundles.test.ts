import { describe, expect, it } from 'vitest';
import { FAST_JET_RIG, rigFromBundle } from '../src/render/sim/camera/chaseCamera';
import { MODEL_SPECS } from '../src/render/common/models/library';
import { AIRCRAFT_TYPES } from '../src/sim/air/aircraft';
import { AIRCRAFT_BUNDLES, BundleError, bundleGaps, parseBundle } from '../src/sim/air/bundles';
import { profileProblems } from '../src/sim/avionics/profiles';

const bundles = Object.values(AIRCRAFT_BUNDLES);

describe('aircraft bundles', () => {
  it('have unique ids, a dense air-war order and consistent sides', () => {
    const typeIds = bundles.filter((b) => b.airWar).map((b) => b.airWar!.id);
    expect(new Set(typeIds).size).toBe(typeIds.length);
    const orders = bundles
      .filter((b) => b.airWar)
      .map((b) => b.order!)
      .sort((a, b) => a - b);
    expect(orders).toEqual(orders.map((_, i) => i));
    expect(AIRCRAFT_TYPES.length).toBe(typeIds.length);
    for (const b of bundles) {
      if (b.airWar && b.avionics) expect(b.avionics.skin, b.id).toBe(b.airWar.side);
      if (b.avionics) expect(profileProblems(b.avionics), b.id).toEqual([]);
    }
  });

  it('name geometry that exists, and only the renderer’s specs have parts', () => {
    for (const b of bundles) {
      if (!b.geometry) continue;
      expect(MODEL_SPECS[b.geometry], `${b.id} → ${b.geometry}`).toBeDefined();
      expect(b.airWar?.model ?? b.geometry).toBe(b.geometry);
    }
    // Bundles without geometry stay out of the model library.
    for (const b of bundles) if (b.geometry !== b.id) expect(MODEL_SPECS[b.id]).toBeUndefined();
  });

  it('give the flown aircraft their rigs', () => {
    expect(rigFromBundle(AIRCRAFT_BUNDLES['alliance-fighter']!.rig!)).toEqual(FAST_JET_RIG);
    for (const b of bundles) {
      if (b.rig?.kind === 'helicopter') expect(b.hasRotors, b.id).toBe(true);
    }
  });

  it('refuse a malformed bundle', () => {
    expect(() => parseBundle({ name: 'X', class: 'fighter', airWar: { id: 'x' } }, 'x')).toThrow(
      BundleError,
    );
    expect(() =>
      parseBundle({ name: 'X', class: 'fighter', parts: [{}], model: 'pact-fighter' }, 'x'),
    ).toThrow(BundleError);
    expect(() => parseBundle({ name: 'X', class: 'fighter', rig: { kind: 'blimp' } }, 'x')).toThrow(
      BundleError,
    );
  });

  // What the demo roster (roadmap R2.7) still lacks: R2.7's checklist. Update it as parts land.
  it('list what the demo roster lacks', () => {
    const gaps = (typeId: string) =>
      bundleGaps(bundles.find((b) => b.airWar?.id === typeId)!).join(', ');
    expect(gaps('f21')).toBe('calibration');
    expect(gaps('uh68')).toBe('pylons, calibration');
    expect(gaps('ve18')).toBe('flight, pylons, calibration');
    expect(gaps('vo31')).toBe('calibration');
    expect(gaps('vo35')).toBe('calibration');
    expect(gaps('a15')).toBe('geometry, flight, rig, pylons, calibration');
    expect(gaps('c150')).toBe('flight, pylons, calibration');
    // The AI-only types of the demo's orders have their models and rigs (R2.7).
    for (const id of ['f25', 'e5', 'kc40', 'vo37', 'ra44', 'ra60', 've28']) {
      expect(gaps(id), id).not.toContain('geometry');
      expect(gaps(id), id).not.toContain('rig');
    }
  });
});
