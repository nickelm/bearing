/**
 * The displays' models, the strip and the avionics behind them (Proposal 0006,
 * decision 199): master modes follow their triggers with hysteresis, the
 * player's choice and the dogfight override; profiles list only formats
 * whose systems the aircraft carries; presets never move a slot and leave pins
 * alone; the strip is dark in normal flight and warns on conflicts; display
 * models are plain data; the hot keys are bound to nothing else.
 */
import { describe, expect, it } from 'vitest';
import { FOOT, KNOT } from '../src/core/units';
import {
  applyCommand,
  autoMode,
  initialAvionics,
  triggeredMode,
} from '../src/sim/avionics/avionics';
import type { AvionicsState, ModeInputs } from '../src/sim/avionics/avionics';
import { AVIONICS_PROFILES, profileProblems } from '../src/sim/avionics/profiles';
import { DISPLAY_BINDINGS } from '../src/ui/displays/bindings';
import { displayModel, slotFormats } from '../src/ui/displays/formats';
import { BEZEL_BUTTONS, SMALL_BUTTONS } from '../src/ui/displays/model';
import { applyPreset, applyUi, initialDisplayState, recordEdit } from '../src/ui/displays/presets';
import type { AircraftSnapshot } from '../src/ui/displays/snapshot';
import { cautionIds, stripModel } from '../src/ui/displays/strip';
import { FLIGHT_BINDINGS } from '../src/ui/flight/flightInput';
import { HELO_BINDINGS } from '../src/ui/flight/heloInput';

const cruise: ModeInputs = {
  onGround: false,
  gearDown: false,
  radarAltitude: 3000,
  groundSpeed: 200,
  helicopter: false,
};

function snap(over: Partial<AircraftSnapshot> = {}, avionics?: AvionicsState): AircraftSnapshot {
  return {
    time: 30,
    kind: 'jet',
    name: 'F-21 Kestrel',
    profile: AVIONICS_PROFILES['alliance-fighter']!,
    avionics: avionics ?? { ...initialAvionics(false) },
    position: { lat: 0.8, lon: 0.3, radius: 1_000_000 },
    destination: { label: 'RWY 07', bearing: 1.2, distance: 30_000 },
    track: 0.6,
    heading: 0.6,
    onGround: false,
    cas: 220,
    groundSpeed: 220,
    radarAltitude: 3000,
    fuel: { mass: 2600, capacity: 2630, unlimited: false, joker: 920, bingo: 526 },
    engine: { lever: 0.6, power: 0.7, afterburner: 0 },
    gear: { position: 0, down: false, fixed: false, overspeed: false },
    speedbrake: 0,
    brakes: false,
    parkingBrake: false,
    rotor: null,
    holds: [],
    control: 'mouse aim',
    mouseFree: false,
    messages: [{ at: 2, text: ['Airborne'], warn: false }],
    ...over,
  };
}

describe('master modes', () => {
  it('follow the triggers: ground, approach below 3,000 ft with the gear down, hover, navigation', () => {
    expect(triggeredMode('navigation', { ...cruise, onGround: true })).toBe('ground');
    expect(triggeredMode('navigation', cruise)).toBe('navigation');
    const low = { ...cruise, gearDown: true, radarAltitude: 2900 * FOOT };
    expect(triggeredMode('navigation', low)).toBe('approach');
    expect(triggeredMode('navigation', { ...low, gearDown: false })).toBe('navigation');
    const heli = { ...cruise, helicopter: true, groundSpeed: 15 * KNOT };
    expect(triggeredMode('navigation', heli)).toBe('hover');
  });

  it('hold their mode inside the hysteresis band', () => {
    const band = { ...cruise, gearDown: true, radarAltitude: 3150 * FOOT };
    expect(triggeredMode('approach', band)).toBe('approach');
    expect(triggeredMode('navigation', band)).toBe('navigation');
    const heli = { ...cruise, helicopter: true, groundSpeed: 22 * KNOT };
    expect(triggeredMode('hover', heli)).toBe('hover');
    expect(triggeredMode('navigation', heli)).toBe('navigation');
  });

  it("keep the player's choice in the air, and give way to the ground", () => {
    let s = applyCommand(initialAvionics(false), { type: 'master-mode', mode: 'air-to-air' });
    s = autoMode(s, { ...cruise, gearDown: true, radarAltitude: 100 });
    expect(s.masterMode).toBe('air-to-air');
    s = autoMode(s, { ...cruise, onGround: true });
    expect(s).toMatchObject({ masterMode: 'ground', manual: false });
    s = applyCommand(s, { type: 'auto-mode' });
    expect(autoMode(s, cruise).masterMode).toBe('navigation');
  });

  it('leave dogfight for the mode before it', () => {
    let s = applyCommand(initialAvionics(false), { type: 'master-mode', mode: 'air-to-ground' });
    s = applyCommand(s, { type: 'dogfight' });
    expect(s.masterMode).toBe('dogfight');
    s = applyCommand(s, { type: 'dogfight' });
    expect(s.masterMode).toBe('air-to-ground');
  });
});

describe('avionics profiles', () => {
  it('list only formats whose systems the aircraft carries', () => {
    for (const [id, p] of Object.entries(AVIONICS_PROFILES))
      expect(profileProblems(p), id).toEqual([]);
    const bad = {
      ...AVIONICS_PROFILES['alliance-scout-helo']!,
      slots: { rightMfd: ['radar-aa' as const] },
    };
    expect(profileProblems(bad)).toEqual(['rightMfd: radar-aa needs radar-aa']);
  });
});

describe('display presets', () => {
  it('show a built format in each used slot, and never the same one twice', () => {
    const d = initialDisplayState(snap());
    expect(d.slots.leftMfd).toMatchObject({ format: 'moving-map', state: 'expanded' });
    // Navigation keeps the right display collapsed; it offers engines and fuel beside the map.
    expect(d.slots.rightMfd).toMatchObject({ format: 'engines', state: 'collapsed' });
    expect(d.slots.messages).toMatchObject({ format: 'messages', state: 'expanded' });
    expect(d.slots.threat).toMatchObject({ format: 'threat', state: 'expanded' });
  });

  it('change formats and states with the master mode, but leave pinned slots alone', () => {
    const s = snap();
    let d = initialDisplayState(s);
    d = applyUi(d, s, { type: 'pin', slot: 'threat', pinned: true });
    d = applyUi(d, s, { type: 'toggle-slot', slot: 'threat' });
    expect(d.slots.threat.state).toBe('collapsed');
    for (const mode of ['ground', 'approach', 'dogfight', 'navigation'] as const) {
      d = applyPreset(d, snap({}, { ...s.avionics, masterMode: mode }));
      expect(d.slots.threat).toMatchObject({ state: 'collapsed', pinned: true });
    }
    d = applyPreset(d, snap({}, { ...s.avionics, masterMode: 'dogfight' }));
    expect(d.slots.leftMfd.state).toBe('collapsed');
  });

  it('let the player choose only formats the slot may show', () => {
    const s = snap();
    const d = initialDisplayState(s);
    expect(applyUi(d, s, { type: 'select-format', slot: 'leftMfd', format: 'radar-aa' })).toBe(d);
    expect(slotFormats(s, 'leftMfd')).toEqual(['moving-map', 'engines']);
  });
});

describe("the player's preset edits (decision 200)", () => {
  it('apply in their master mode, to every aircraft where the format exists', () => {
    const s = snap();
    let d = initialDisplayState(s);
    d = applyUi(d, s, { type: 'toggle-slot', slot: 'threat' });
    const edits = recordEdit({}, 'navigation', 'threat', d.slots.threat);
    expect(edits).toEqual({ navigation: { threat: { format: 'threat', expanded: false } } });
    // A fresh sortie in navigation keeps the edit; approach keeps its own preset.
    expect(initialDisplayState(s, edits).slots.threat.state).toBe('collapsed');
    const appr = snap({}, { ...s.avionics, masterMode: 'approach' });
    expect(applyPreset(initialDisplayState(s, edits), appr, edits).slots.threat.state).toBe(
      'collapsed',
    );
    const helo = snap({ kind: 'helicopter', profile: AVIONICS_PROFILES['alliance-scout-helo']! });
    expect(initialDisplayState(helo, edits).slots.threat.state).toBe('collapsed');
    // An edit naming a format the aircraft lacks is passed over.
    const odd = { navigation: { leftMfd: { format: 'radar-aa' as const, expanded: true } } };
    expect(initialDisplayState(s, odd).slots.leftMfd.format).toBe('moving-map');
  });
});

describe('the status strip', () => {
  it('is dark in normal flight', () => {
    expect(stripModel(snap()).items).toEqual([]);
    expect(stripModel(snap()).masterCaution).toBe(false);
  });

  it('warns of the gear up while slow and low, and of bingo fuel', () => {
    const m = stripModel(
      snap({ cas: 140 * KNOT, radarAltitude: 120, fuel: { ...snap().fuel, mass: 400 } }),
    );
    expect(m.items.map((i) => [i.id, i.level])).toEqual([
      ['gear-up-low', 'warning'],
      ['bingo', 'warning'],
    ]);
    expect(m.masterCaution).toBe(true);
  });

  it('flags conflicts: the parking brake with the throttle up, the speedbrake with afterburner', () => {
    const m = stripModel(
      snap(
        {
          onGround: true,
          parkingBrake: true,
          engine: { lever: 0.9, power: 1, afterburner: 2 },
          speedbrake: 1,
          gear: { position: 1, down: true, fixed: false, overspeed: false },
        },
        initialAvionics(true),
      ),
    );
    const levels = Object.fromEntries(m.items.map((i) => [i.id, i.level]));
    expect(levels).toMatchObject({
      'park-thr': 'caution',
      'sb-ab': 'caution',
      gear: 'normal',
      ab: 'normal',
    });
  });

  it('stops glowing once the master caution acknowledges, while the items stay', () => {
    const s = snap({ fuel: { ...snap().fuel, mass: 800 } });
    const m = stripModel(s);
    expect(m.masterCaution).toBe(true);
    const acked = applyCommand(s.avionics, { type: 'acknowledge', ids: cautionIds(m) });
    const after = stripModel({ ...s, avionics: acked });
    expect(after.masterCaution).toBe(false);
    expect(after.items.map((i) => i.id)).toEqual(['joker']);
  });

  it("ends with a helicopter's torque and rotor gauges, and shows no fixed gear", () => {
    const m = stripModel(
      snap({
        kind: 'helicopter',
        profile: AVIONICS_PROFILES['alliance-utility-helo']!,
        gear: { position: 1, down: true, fixed: true, overspeed: false },
        rotor: { torque: 1.05, rpm: 1, margin: 0 },
        holds: ['hover hold'],
      }),
    );
    expect(m.gauges.map((g) => [g.id, g.level])).toEqual([
      ['torque', 'warning'],
      ['rotor', 'normal'],
      ['margin', 'caution'],
    ]);
    expect(m.items.map((i) => i.id)).toEqual(['hover hold']);
  });
});

describe('display models', () => {
  it('are plain data with one bezel layout per slot size', () => {
    const s = snap();
    const d = initialDisplayState(s);
    const left = displayModel(s, d, 'leftMfd')!;
    const msgs = displayModel(s, d, 'messages')!;
    expect(left.buttons).toHaveLength(BEZEL_BUTTONS);
    expect(msgs.buttons).toHaveLength(SMALL_BUTTONS);
    for (const m of [left, msgs, displayModel(s, d, 'threat')!]) {
      expect(structuredClone(m)).toEqual(m);
      expect(JSON.parse(JSON.stringify(m))).toEqual(m);
    }
    // The bottom row selects the slot's formats; the format shown is highlighted.
    expect(left.buttons[14]).toMatchObject({ label: 'MAP', active: true });
    expect(left.buttons[13]).toMatchObject({ label: 'ENG', active: false });
  });
});

describe('hot keys', () => {
  it('are bound to nothing in the flight inputs', () => {
    const used = new Set(
      [...Object.values(FLIGHT_BINDINGS), ...Object.values(HELO_BINDINGS)].flat(),
    );
    for (const [a, codes] of Object.entries(DISPLAY_BINDINGS))
      for (const c of codes) expect(used.has(c), `${a}: ${c}`).toBe(false);
  });
});

describe('the moving map (decision 201)', () => {
  it('turns with the track in track-up, not in north-up, and steps through its ranges', () => {
    const s = snap();
    let d = initialDisplayState(s);
    const mapItem = () => displayModel(s, d, 'leftMfd')!.items.find((i) => i.kind === 'map')!;
    expect(mapItem()).toMatchObject({ rotation: 0.6, halfExtent: 20 * 1852, lat: 0.8 });
    d = applyUi(d, s, { type: 'map-orient', slot: 'leftMfd' });
    expect(mapItem()).toMatchObject({ rotation: 0 });
    for (let i = 0; i < 9; i++) d = applyUi(d, s, { type: 'map-range', slot: 'leftMfd', delta: 1 });
    expect(mapItem()).toMatchObject({ halfExtent: 160 * 1852 });
    for (let i = 0; i < 9; i++)
      d = applyUi(d, s, { type: 'map-range', slot: 'leftMfd', delta: -1 });
    expect(mapItem()).toMatchObject({ halfExtent: 5 * 1852 });
    const m = displayModel(s, d, 'leftMfd')!;
    expect(m.buttons[19]?.label).toBe('RNG▲');
    expect(m.buttons[6]?.label).toBe('N-UP');
  });

  it('marks the destination inside the range, and points to it at the edge beyond (decision 202)', () => {
    const s = snap();
    let d = initialDisplayState(s);
    const marks = () =>
      displayModel(s, d, 'leftMfd')!.items.filter(
        (i) => i.kind === 'text' && i.text.startsWith('RWY 07'),
      ) as { x: number; y: number; text: string }[];
    // 30 km at 20 nm (37 km): inside, along the bearing relative to the track (1.2 − 0.6 rad).
    const [inside] = marks();
    expect(inside!.text).toBe('RWY 07');
    expect(inside!.x).toBeGreaterThan(0.5);
    for (let i = 0; i < 2; i++)
      d = applyUi(d, s, { type: 'map-range', slot: 'leftMfd', delta: -1 });
    // 5 nm (9.3 km): beyond, with its distance.
    expect(marks()[0]!.text).toBe('RWY 07 16 NM');
  });
});
