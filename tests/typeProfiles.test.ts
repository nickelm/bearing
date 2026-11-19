/**
 * Avionics profiles for every type of the air war (decision 224): one per type, valid,
 * in its side's skin, with the proposal's complements.
 */
import { describe, expect, it } from 'vitest';
import { AIRCRAFT_TYPES } from '../src/sim/air/aircraft';
import { AVIONICS_PROFILES, profileProblems, TYPE_PROFILES } from '../src/sim/avionics/profiles';

describe('avionics profiles by aircraft type (decision 224)', () => {
  it('cover every type of the table and nothing else', () => {
    expect(Object.keys(TYPE_PROFILES).sort()).toEqual(AIRCRAFT_TYPES.map((t) => t.id).sort());
  });

  it('are valid, in the side skin, with rotor gauges on helicopters and crew where there is one', () => {
    for (const t of AIRCRAFT_TYPES) {
      const p = TYPE_PROFILES[t.id]!;
      expect(profileProblems(p), t.id).toEqual([]);
      expect(p.skin, t.id).toBe(t.side);
      expect(p.rotorGauges, t.id).toBe(t.helicopter);
      expect(p.crew.length > 0, t.id).toBe(t.crew > 1);
      // A radar spec exactly where the air-to-air radar is carried.
      expect(p.radar !== undefined, t.id).toBe(p.systems.includes('radar-aa'));
      // Messages everywhere; the threat display wherever there is a warning receiver.
      expect(p.slots.messages, t.id).toEqual(['messages']);
      expect(p.slots.threat !== undefined, t.id).toBe(p.systems.includes('rwr'));
    }
  });

  it("follow the proposal's examples", () => {
    // The Su-27 analogue alone shows its radar in the HUD.
    expect(
      Object.entries(TYPE_PROFILES)
        .filter(([, p]) => p.hudRadar)
        .map(([id]) => id),
    ).toEqual(['vo33']);
    // The early fighter: no moving map, its radar in a round scope.
    expect(TYPE_PROFILES.ar23!.slots.leftMfd).toBeUndefined();
    expect(TYPE_PROFILES.ar23!.roundScopes).toBe(true);
    // Strike aircraft with crew: the air-to-ground radar, terrain following and a pod.
    for (const id of ['f124', 'a14', 'vo37']) {
      expect(TYPE_PROFILES[id]!.systems).toEqual(
        expect.arrayContaining(['radar-ag', 'terrain-following', 'targeting-pod']),
      );
      expect(TYPE_PROFILES[id]!.slots.rightMfd![0]).toBe('radar-ag');
    }
    // Attack aircraft carry no radar.
    for (const id of ['a15', 'vo35']) expect(TYPE_PROFILES[id]!.radar).toBeUndefined();
    // The multirole fighter: the full complement; Free Flight's Kestrel is that profile.
    expect(TYPE_PROFILES.f21!.slots.rightMfd).toEqual([
      'radar-aa',
      'radar-ag',
      'targeting-pod',
      'engines',
    ]);
    expect(AVIONICS_PROFILES['alliance-fighter']).toBe(TYPE_PROFILES.f21);
  });
});
