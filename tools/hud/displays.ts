/**
 * The displays and the status strip over the stand-in scene (decision 200), for
 * Part I's acceptance checks 12 and 13: `composite.html?hover=<case>&displays=<mode>`
 * draws the real `DisplaySystem` with a made-up snapshot in master mode `mode`, for
 * `aircraft` (`kestrel`, `utility`) in `skin` (`alliance`, `pact`). The HUD under it is
 * the helicopter's (the stand-in scene is a hover); for the Kestrel it is left out.
 */
import type { MasterMode } from '../../src/sim/avionics/avionics';
import { initialAvionics } from '../../src/sim/avionics/avionics';
import { AVIONICS_PROFILES } from '../../src/sim/avionics/profiles';
import type { AircraftSnapshot } from '../../src/ui/displays/snapshot';
import { DisplaySystem } from '../../src/ui/displays/system';

export function drawDisplays(q: URLSearchParams): void {
  const mode = (q.get('displays') ?? 'navigation') as MasterMode;
  const helo = q.get('aircraft') === 'utility';
  const base = AVIONICS_PROFILES[helo ? 'alliance-utility-helo' : 'alliance-fighter']!;
  const profile = {
    ...base,
    skin: q.get('skin') === 'pact' ? ('pact' as const) : ('alliance' as const),
  };
  const ground = mode === 'ground';
  const approach = mode === 'approach';
  // `&alerts=1`: a caution and a warning in the strip, for the color-vision views (check 13).
  const alerts = q.get('alerts') === '1';
  const snap: AircraftSnapshot = {
    time: 412,
    kind: helo ? 'helicopter' : 'jet',
    name: helo ? 'UH-68 Buzzard' : 'F-21 Kestrel',
    profile,
    avionics: initialAvionics(ground),
    onGround: ground,
    cas: ground ? 0 : approach ? 75 : 210,
    groundSpeed: ground ? 0 : 210,
    radarAltitude: ground ? 0 : approach ? 400 : 3000,
    fuel: { mass: alerts ? 400 : 1600, capacity: 2630, unlimited: false, joker: 920, bingo: 526 },
    engine: {
      lever: alerts ? 0.9 : ground ? 0 : 0.72,
      power: ground ? 0.1 : 0.8,
      afterburner: mode === 'dogfight' ? 3 : 0,
    },
    gear: {
      position: ground || approach || helo ? 1 : 0,
      down: ground || approach || helo,
      fixed: helo,
      overspeed: false,
    },
    speedbrake: approach && !helo ? 1 : 0,
    brakes: false,
    parkingBrake: ground,
    rotor: helo ? { torque: 0.82, rpm: 1, margin: 0.18 } : null,
    holds: helo && mode === 'hover' ? ['hover hold'] : [],
    control: helo ? 'fly-by-mouse' : 'mouse aim',
    mouseFree: false,
    messages: [
      { at: 380, text: ['Airborne'], warn: false },
      { at: 395, text: ['Climbing through 3,000 ft, heading 095'], warn: false },
      { at: 405, text: ['Joker fuel in 6 minutes at this setting'], warn: true },
    ],
  };
  const sys = new DisplaySystem();
  sys.edits = {};
  sys.uiScale = Number(q.get('scale') ?? 1);
  sys.avionics = { ...sys.avionics, masterMode: mode, manual: !ground };
  sys.visible = true;
  sys.update(snap);
}
