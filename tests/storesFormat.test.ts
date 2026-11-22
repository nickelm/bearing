/** The stores format, master arm and weapon selection (decision 289). */
import { describe, expect, it } from 'vitest';
import { applyCommand, initialAvionics } from '../src/sim/avionics/avionics';
import { bundleOfType } from '../src/sim/air/bundles';
import { stationLoads } from '../src/sim/air/stores';
import { loadedStations } from '../src/sim/flight/storesRack';
import { storesSnapshot } from '../src/ui/displays/aircraftSnapshot';
import { displayModel } from '../src/ui/displays/formats';
import { initialDisplayState } from '../src/ui/displays/presets';
import type { AircraftSnapshot } from '../src/ui/displays/snapshot';

const f21 = bundleOfType('f21');
const strike = stationLoads(
  f21.airWar!.loadouts.find((l) => l.id === 'strike')!.stations!,
  f21.pylons!,
);

function snap(avionics = initialAvionics(false)): AircraftSnapshot {
  const loaded = loadedStations(strike, { 'bomb-900': 1 });
  return {
    time: 0,
    kind: 'jet',
    name: 'F-21',
    profile: f21.avionics!,
    avionics,
    onGround: false,
    position: { lat: 0, lon: 0, radius: 1e6 },
    destination: null,
    track: 0,
    heading: 0,
    cas: 150,
    groundSpeed: 160,
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
    sensors: null,
    stores: storesSnapshot(strike, loaded, 1500),
  };
}

describe('weapon selection (decision 289)', () => {
  it('brings the weapon’s master mode', () => {
    let s = initialAvionics(false);
    s = applyCommand(s, { type: 'select-weapon', weapon: 'bomb-900' });
    expect(s.masterMode).toBe('air-to-ground');
    expect(s.weapon).toBe('bomb-900');
    s = applyCommand(s, { type: 'select-weapon', weapon: 'srm' });
    expect(s.masterMode).toBe('air-to-air');
  });

  it('keeps a dogfight for an air-to-air weapon, and deselects a weapon of the other mode', () => {
    let s = applyCommand(initialAvionics(false), { type: 'dogfight' });
    s = applyCommand(s, { type: 'select-weapon', weapon: 'srm' });
    expect(s.masterMode).toBe('dogfight');
    s = applyCommand(s, { type: 'master-mode', mode: 'air-to-ground' });
    expect(s.weapon).toBeNull();
  });
});

describe('the stores format (decision 289)', () => {
  it('counts the stores left and the tanks', () => {
    const st = snap().stores!;
    expect(st.weapons).toEqual([
      { id: 'srm', label: 'SRM', count: 2, mode: 'air-to-air' },
      { id: 'bomb-900', label: 'B900', count: 3, mode: 'air-to-ground' },
    ]);
    expect(st.tanks).toBe(1);
    // Left wing to right.
    expect(st.stations[0]!.station).toBe('wingtip.left');
    expect(st.stations.at(-1)!.station).toBe('wingtip.right');
    expect(st.stations.filter((x) => !x.loaded).map((x) => x.station)).toEqual(['middle.right']);
  });

  it('has weapon, master arm and jettison buttons that issue their commands', () => {
    const s = snap();
    const d = initialDisplayState(s);
    const m = displayModel(
      s,
      { ...d, slots: { ...d.slots, leftMfd: { ...d.slots.leftMfd, format: 'stores' } } },
      'leftMfd',
    )!;
    expect(m.title).toBe('SMS');
    expect(m.buttons[0]!.label).toBe('SRM');
    expect(m.buttons[1]!.command).toEqual({
      to: 'avionics',
      command: { type: 'select-weapon', weapon: 'bomb-900' },
    });
    expect(m.buttons[5]!.command).toEqual({
      to: 'avionics',
      command: { type: 'master-arm', on: true },
    });
    expect(m.buttons[9]!.command).toEqual({ to: 'controls', action: 'jettisonTanks' });
    expect(m.items.some((i) => i.kind === 'text' && i.text === 'SAFE')).toBe(true);
  });

  it('opens in air-to-ground on the left display', () => {
    const s = snap(
      applyCommand(initialAvionics(false), { type: 'select-weapon', weapon: 'bomb-900' }),
    );
    expect(initialDisplayState(s).slots.leftMfd.format).toBe('stores');
  });
});
