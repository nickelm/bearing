/** The mission phases' interface defaults applied to the displays and the HUD (decision 304). */
import { describe, expect, it } from 'vitest';
import { FOOT } from '../src/core/units';
import { phaseInterface, showsLandingAid } from '../src/follow/follow';
import { initialAvionics, triggeredMode } from '../src/sim/avionics/avionics';
import type { ModeInputs } from '../src/sim/avionics/avionics';
import { AVIONICS_PROFILES } from '../src/sim/avionics/profiles';
import { missionPlugin } from '../src/sim/command/missions/registry';
import type { PhaseInterface } from '../src/sim/command/missions/plugin';
import {
  applyPreset,
  editsForNewPhase,
  initialDisplayState,
  preselectWeapon,
} from '../src/ui/displays/presets';
import type { AircraftSnapshot, SnapshotStores } from '../src/ui/displays/snapshot';
import { capMission, phaseStart } from './helpers/promoted';

const cruise: ModeInputs = {
  onGround: false,
  gearDown: false,
  radarAltitude: 3000,
  groundSpeed: 200,
  helicopter: false,
};

const snap = (masterMode: AircraftSnapshot['avionics']['masterMode']): AircraftSnapshot => ({
  time: 0,
  kind: 'jet',
  name: 'F-21',
  profile: AVIONICS_PROFILES['alliance-fighter']!,
  avionics: { ...initialAvionics(false), masterMode },
  position: { lat: 0, lon: 0, radius: 1e6 },
  destination: null,
  sensors: null,
  track: 0,
  heading: 0,
  onGround: false,
  cas: 200,
  groundSpeed: 200,
  radarAltitude: 3000,
  fuel: { mass: 4000, capacity: 5440, unlimited: false, joker: 1900, bingo: 1100, low: 544 },
  engine: { lever: 0.6, power: 0.6, afterburner: 0 },
  gear: { position: 0, down: false, fixed: false, overspeed: false },
  speedbrake: 0,
  brakes: false,
  parkingBrake: false,
  rotor: null,
  holds: [],
  control: 'mouse aim',
  mouseFree: false,
  messages: [],
});

const stores: SnapshotStores = {
  stations: [],
  weapons: [
    { id: 'gun', label: 'GUN', count: 510, mode: 'air-to-air' },
    { id: 'srm', label: 'SRM', count: 2, mode: 'air-to-air' },
    { id: 'bomb-900', label: 'B900', count: 4, mode: 'air-to-ground' },
  ],
  tanks: 1,
  tankFuel: 0,
};

describe('a phase’s master mode (decision 304)', () => {
  it('is what the triggers fall back to in the air; the ground and the approach still win', () => {
    expect(triggeredMode('navigation', { ...cruise, cruise: 'air-to-air' })).toBe('air-to-air');
    expect(triggeredMode('navigation', { ...cruise, cruise: 'ground' })).toBe('navigation');
    expect(triggeredMode('air-to-air', { ...cruise, onGround: true, cruise: 'air-to-air' })).toBe(
      'ground',
    );
    const low = {
      ...cruise,
      gearDown: true,
      radarAltitude: 2000 * FOOT,
      cruise: 'air-to-ground' as const,
    };
    expect(triggeredMode('air-to-ground', low)).toBe('approach');
  });
});

describe('a phase’s formats (decision 304)', () => {
  it('come before the mode’s preset, and the player’s edits before them', () => {
    const s = snap('navigation');
    const d = applyPreset(initialDisplayState(s), s, {}, { leftMfd: ['engines'] });
    expect(d.slots.leftMfd.format).toBe('engines');
    expect(d.slots.leftMfd.state).toBe('expanded');
    const edited = applyPreset(
      initialDisplayState(s),
      s,
      { navigation: { leftMfd: { format: 'stores', expanded: true } } },
      { leftMfd: ['engines'] },
    );
    expect(edited.slots.leftMfd.format).toBe('stores');
  });

  it('come up when a new phase begins even where the player once chose another (decision 310)', () => {
    // The map chosen by hand in air-to-ground mode in an earlier sortie, saved as an edit.
    const edits = {
      'air-to-ground': { leftMfd: { format: 'moving-map' as const, expanded: true } },
    };
    const fenceIn = missionPlugin('interdiction').interface as Record<string, PhaseInterface>;
    const formats = fenceIn['fence-in']!.formats;
    const s = snap('air-to-ground');
    const d0 = initialDisplayState(snap('navigation'));
    expect(applyPreset(d0, s, edits, formats).slots.leftMfd.format).toBe('moving-map');
    const fresh = editsForNewPhase(edits, 'air-to-ground', formats);
    expect(applyPreset(d0, s, fresh, formats).slots.leftMfd.format).toBe('stores');
    // Only the slots the phase names lose their edits, and only in its mode.
    const more = {
      ...edits,
      navigation: { leftMfd: { format: 'engines' as const, expanded: true } },
    };
    expect(editsForNewPhase(more, 'air-to-ground', formats).navigation).toEqual(more.navigation);
  });
});

describe('a phase’s cues (decision 304)', () => {
  it('pre-select an air-to-air missile on a CAP station and a bomb over the target', () => {
    const aa = { ...initialAvionics(false), masterMode: 'air-to-air' as const };
    expect(preselectWeapon(aa, stores, ['aa-reticle']).weapon).toBe('srm');
    const ag = { ...initialAvionics(false), masterMode: 'air-to-ground' as const };
    expect(preselectWeapon(ag, stores, ['target', 'ccip']).weapon).toBe('bomb-900');
    // Without the cue, or once the player chose, nothing changes.
    expect(preselectWeapon(aa, stores, []).weapon).toBeNull();
    expect(preselectWeapon({ ...aa, manual: true }, stores, ['aa-reticle']).weapon).toBeNull();
    // With the missiles gone, the gun.
    const dry = {
      ...stores,
      weapons: stores.weapons.map((w) => (w.id === 'srm' ? { ...w, count: 0 } : w)),
    };
    expect(preselectWeapon(aa, dry, ['aa-reticle']).weapon).toBe('gun');
  });

  it('follow the CAP’s phases, and the landing aid shows only on the ground and the approach', () => {
    const m = capMission();
    const station = phaseInterface(m, phaseStart(m, 'on-target') + 60)!;
    expect(station.masterMode).toBe('air-to-air');
    expect(station.hud).toContain('station');
    expect(showsLandingAid(station, 'air-to-air')).toBe(false);
    const approach = phaseInterface(m, phaseStart(m, 'approach') + 10)!;
    expect(showsLandingAid(approach, 'navigation')).toBe(true);
    const ui = missionPlugin('interdiction').interface as Record<string, PhaseInterface>;
    expect(ui['on-target']!.hud).toEqual(['target', 'ccip']);
  });
});
