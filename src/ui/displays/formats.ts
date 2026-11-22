/**
 * Display formats (Proposal 0006, decision 199): pure functions from the
 * snapshot and the display state to a display model. One layout and one set of
 * buttons per format, in every aircraft that carries it; faction skins change
 * labels and units only.
 *
 * Built so far: engines and fuel (fuel, joker and bingo, the throttle and the
 * afterburner), messages (the log of calls and events), and the threat
 * warning's scope (empty until the sensor model of P3 gives it emitters). The
 * moving map comes next; radar, stores, the pod and the hook camera with P3–P5.
 * The bottom row of a large display selects among the formats its slot may
 * show; the top row's right end pins the slot.
 */
import type { FormatId, SlotId } from '../../sim/avionics/profiles';
import type { BezelButton, DisplayModel, DisplayState, ScreenItem, Tone } from './model';
import { BEZEL_BUTTONS, SMALL_BUTTONS } from './model';
import type { AircraftSnapshot, MapBearing } from './snapshot';
import { ACM_CONE } from '../../sim/sensors/sensors';
import { elevationItems } from './elevation';

const LB = 0.453_592_37;

export const FORMAT_TITLES: Record<FormatId, string> = {
  'moving-map': 'MAP',
  stores: 'SMS',
  engines: 'ENG',
  'radar-aa': 'FCR',
  'radar-ag': 'GMR',
  'targeting-pod': 'TGP',
  threat: 'RWR',
  comms: 'COM',
  messages: 'MSG',
  mission: 'MSN',
  crew: 'CREW',
  'hook-camera': 'HOOK',
  'gunner-sight': 'SGT',
  airdrop: 'DROP',
};

type Format = (s: AircraftSnapshot, d: DisplayState, slot: SlotId) => ScreenItem[];

const FORMATS: Partial<Record<FormatId, Format>> = {
  'moving-map': movingMapFormat,
  engines: enginesFormat,
  messages: messagesFormat,
  threat: threatFormat,
  'radar-aa': radarFormat,
  'radar-ag': groundMapFormat,
  stores: storesFormat,
};

/** The moving map's ranges, center to edge (nautical miles; decision 201). */
export const MAP_RANGES_NM = [5, 10, 20, 40, 80, 160] as const;
/** The same steps in round kilometers for Pact skins (decision 227). */
export const MAP_RANGES_KM = [10, 20, 40, 80, 150, 300] as const;
const NM = 1852;

/** The moving map's range (m, center to edge) at step `i` in a skin. */
export function mapRange(skin: 'alliance' | 'pact', i: number): number {
  const k = Math.max(0, Math.min(MAP_RANGES_NM.length - 1, i));
  return skin === 'pact' ? MAP_RANGES_KM[k]! * 1000 : MAP_RANGES_NM[k]! * NM;
}

/** Whether a format is built yet. */
export function implemented(f: FormatId): boolean {
  return FORMATS[f] !== undefined;
}

/** The formats `slot` may show in this aircraft and that are built, in the profile's order. */
export function slotFormats(s: AircraftSnapshot, slot: SlotId): FormatId[] {
  if (slot === 'strip') return [];
  return (s.profile.slots[slot] ?? []).filter(implemented);
}

const large = (slot: SlotId) => slot === 'leftMfd' || slot === 'rightMfd';

/** The display model of `slot`, or null when it shows nothing. */
export function displayModel(
  s: AircraftSnapshot,
  d: DisplayState,
  slot: SlotId,
): DisplayModel | null {
  const st = d.slots[slot];
  const format = st.format;
  if (slot === 'strip' || !format || !implemented(format)) return null;
  const buttons: (BezelButton | null)[] = new Array<BezelButton | null>(
    large(slot) ? BEZEL_BUTTONS : SMALL_BUTTONS,
  ).fill(null);
  if (format === 'moving-map') {
    // Left side, top: the range up and down; right side, top: north-up or track-up.
    const pic = (delta: 1 | -1) => ({
      to: 'ui' as const,
      command: { type: 'map-range' as const, slot, delta },
    });
    buttons[19] = { label: 'RNG▲', active: false, command: pic(1) };
    buttons[18] = { label: 'RNG▼', active: false, command: pic(-1) };
    buttons[6] = {
      label: d.map.northUp ? 'N-UP' : 'TRK',
      active: false,
      command: { to: 'ui', command: { type: 'map-orient', slot } },
    };
    // Below it: the map's mode, chart, elevation or relative (decision 227).
    buttons[7] = {
      label: d.map.mode === 'chart' ? 'CHRT' : d.map.mode === 'elevation' ? 'ELEV' : 'REL',
      active: d.map.mode !== 'chart',
      command: { to: 'ui', command: { type: 'map-mode', slot } },
    };
  }
  if (format === 'radar-ag') {
    // Left side, top: the ground map's range (decision 226).
    const step = (delta: 1 | -1) => ({
      to: 'avionics' as const,
      command: { type: 'ground-radar-range' as const, delta },
    });
    buttons[19] = { label: 'RNG▲', active: false, command: step(1) };
    buttons[18] = { label: 'RNG▼', active: false, command: step(-1) };
    buttons[0] = { label: 'MAP', active: true, command: null };
  }
  if (format === 'radar-aa' && s.sensors?.radar) {
    const r = s.sensors.radar;
    const av = (command: import('../../sim/avionics/avionics').AvionicsCommand) => ({
      to: 'avionics' as const,
      command,
    });
    // Top row: the search mode and the power; left: the range; right: lock and break.
    buttons[0] = {
      label: r.mode.toUpperCase(),
      active: false,
      // From air combat mode or a lock, the button returns to range-while-search.
      command: av({ type: 'radar-mode', mode: r.mode === 'rws' ? 'tws' : 'rws' }),
    };
    buttons[1] = {
      label: r.on ? 'ON' : 'OFF',
      active: !r.on,
      command: av({ type: 'radar-power', on: !r.on }),
    };
    buttons[19] = { label: 'RNG▲', active: false, command: av({ type: 'radar-range', delta: 1 }) };
    buttons[18] = { label: 'RNG▼', active: false, command: av({ type: 'radar-range', delta: -1 }) };
    const next = lockCandidate(s);
    buttons[5] = {
      label: 'LOCK',
      active: false,
      command: next ? av({ type: 'radar-lock', id: next }) : null,
    };
    buttons[6] = {
      label: 'BRK',
      active: false,
      command: r.lock ? av({ type: 'radar-lock', id: null }) : null,
    };
  }
  if (format === 'stores' && s.stores) {
    // Top row: the weapons aboard; right side: master arm at the top, jettison at the bottom.
    s.stores.weapons.slice(0, 5).forEach((w, i) => {
      buttons[i] = {
        label: w.label,
        active: s.avionics.weapon === w.id,
        command: {
          to: 'avionics',
          command: { type: 'select-weapon', weapon: s.avionics.weapon === w.id ? null : w.id },
        },
      };
    });
    buttons[5] = {
      label: s.avionics.masterArm ? 'ARM' : 'SAFE',
      active: s.avionics.masterArm,
      command: { to: 'avionics', command: { type: 'master-arm', on: !s.avionics.masterArm } },
    };
    buttons[9] = {
      label: 'JETT',
      active: false,
      command: s.stores.tanks > 0 ? { to: 'controls', action: 'jettisonTanks' } : null,
    };
  }
  if (large(slot)) {
    // Bottom row, left to right (positions 14 down to 10): the slot's formats.
    slotFormats(s, slot)
      .slice(0, 5)
      .forEach((f, i) => {
        buttons[14 - i] = {
          label: FORMAT_TITLES[f],
          active: f === format,
          command: { to: 'ui', command: { type: 'select-format', slot, format: f } },
        };
      });
  }
  return {
    slot,
    format,
    title: FORMAT_TITLES[format],
    owner: null,
    pinned: st.pinned,
    buttons,
    items: FORMATS[format]!(s, d, slot),
    alert: false,
  };
}

const text = (
  x: number,
  y: number,
  t: string,
  size: 'small' | 'normal' | 'large' = 'normal',
  align: 'left' | 'center' | 'right' = 'left',
  tone: Tone = 'normal',
): ScreenItem => ({ kind: 'text', x, y, text: t, size, align, tone });

/** Fuel in the skin's unit: pounds for the Alliance, kilograms for the Pact. */
function fuelText(s: AircraftSnapshot, kg: number): string {
  if (s.profile.skin === 'pact') return `${Math.round(kg / 10) * 10} KG`;
  return `${(Math.round(kg / LB / 10) * 10).toLocaleString('en-US')} LB`;
}

/**
 * Engines and fuel: the internal fuel's level with joker, bingo and low fuel marked on it
 * (decision 307), its tone from all the fuel aboard as the strip's, the throttle and power.
 */
function enginesFormat(s: AircraftSnapshot): ScreenItem[] {
  const f = s.fuel;
  const frac = f.capacity > 0 ? Math.min(1, f.mass / f.capacity) : 0;
  const all = f.total ?? f.mass;
  const tone: Tone = f.unlimited
    ? 'normal'
    : all < f.bingo
      ? 'warning'
      : all < f.joker
        ? 'caution'
        : 'normal';
  const items: ScreenItem[] = [
    text(0.08, 0.14, 'FUEL', 'small', 'left', 'dim'),
    text(0.08, 0.24, f.unlimited ? 'UNLIMITED' : fuelText(s, f.mass), 'large', 'left', tone),
    { kind: 'bar', x: 0.08, y: 0.32, w: 0.5, h: 0.08, fill: frac, vertical: false, tone },
  ];
  if (!f.unlimited && f.capacity > 0) {
    for (const [v, name] of [
      // Short marks: they sit close (35%, 20% and 10%), and full words collided.
      [f.joker, 'J'],
      [f.bingo, 'B'],
      [f.low, 'L'],
    ] as const) {
      // A mission's joker can be more than the internal tanks hold: at the bar's end.
      const x = 0.08 + 0.5 * Math.max(0, Math.min(1, v / f.capacity));
      items.push({
        kind: 'line',
        points: [
          [x, 0.3],
          [x, 0.42],
        ],
        tone: 'caution',
      });
      items.push(text(x, 0.47, name, 'small', 'center', 'dim'));
    }
  }
  const e = s.engine;
  items.push(
    text(0.08, 0.6, s.kind === 'helicopter' ? 'POWER' : 'THROTTLE', 'small', 'left', 'dim'),
    {
      kind: 'bar',
      x: 0.08,
      y: 0.64,
      w: 0.5,
      h: 0.06,
      fill: e.lever,
      vertical: false,
      tone: 'normal',
    },
    text(0.62, 0.69, `${Math.round(e.power * 100)}%`, 'normal'),
  );
  if (s.kind === 'jet')
    items.push(
      text(
        0.08,
        0.82,
        e.afterburner > 0 ? `AFTERBURNER ${e.afterburner}` : 'AFTERBURNER OFF',
        'normal',
        'left',
        e.afterburner > 0 ? 'normal' : 'dim',
      ),
    );
  return items;
}

/**
 * The stores format (decision 289): master arm across the top, the stations across the
 * screen from the left wing to the right with what each carries (dim once empty), the
 * selected weapon's stations underlined, the selected weapon and how many are left, and
 * the tanks with their fuel.
 */
function storesFormat(s: AircraftSnapshot): ScreenItem[] {
  const st = s.stores;
  const arm = s.avionics.masterArm;
  const items: ScreenItem[] = [
    text(0.5, 0.22, arm ? 'MASTER ARM' : 'SAFE', 'normal', 'center', arm ? 'caution' : 'dim'),
  ];
  if (!st || st.stations.length === 0) {
    items.push(text(0.5, 0.5, 'NO STORES', 'normal', 'center', 'dim'));
    return items;
  }
  // Stations evenly across the wing, left to right (their real spacing crowds the labels).
  const n = st.stations.length;
  const wy = 0.36;
  items.push({
    kind: 'line',
    points: [
      [0.06, wy],
      [0.94, wy],
    ],
    tone: 'dim',
  });
  const selected = s.avionics.weapon;
  st.stations.forEach((x, i) => {
    const px = n === 1 ? 0.5 : 0.1 + (0.8 * i) / (n - 1);
    const low = i % 2 === 1;
    const ly = wy + (low ? 0.17 : 0.1);
    items.push(
      {
        kind: 'line',
        points: [
          [px, wy],
          [px, ly - 0.05],
        ],
        tone: 'dim',
      },
      text(px, ly, x.loaded ? x.label : '—', 'small', 'center', x.loaded ? 'normal' : 'dim'),
    );
    if (x.loaded && x.store === selected)
      items.push({
        kind: 'line',
        points: [
          [px - 0.045, ly + 0.03],
          [px + 0.045, ly + 0.03],
        ],
        tone: 'normal',
        width: 2,
      });
  });
  const w = st.weapons.find((x) => x.id === selected);
  items.push(
    text(
      0.08,
      0.66,
      w ? `WEAPON  ${w.mode === 'air-to-air' ? 'A-A' : 'A-G'}` : 'WEAPON',
      'small',
      'left',
      'dim',
    ),
    text(0.08, 0.75, w ? `${w.label} × ${w.count}` : 'NONE', 'large', 'left', w ? 'normal' : 'dim'),
  );
  if (st.tanks > 0)
    items.push(
      text(0.08, 0.85, `TANKS ${st.tanks} · ${fuelText(s, st.tankFuel)}`, 'small', 'left'),
    );
  return items;
}

/**
 * The moving map (decision 201): the strategic view's picture under the aircraft,
 * north-up or track-up, the aircraft at the center, a ring at half the range with
 * its figure, and the range and orientation in the corners. Ranges in nautical miles
 * for the Alliance, kilometers for the Pact.
 */
function movingMapFormat(s: AircraftSnapshot, d: DisplayState): ScreenItem[] {
  const pact = s.profile.skin === 'pact';
  const half = mapRange(s.profile.skin, d.map.range);
  const rotation = d.map.northUp ? 0 : s.track;
  const fig = (m: number) => (pact ? `${Math.round(m / 1000)} KM` : `${Math.round(m / NM)} NM`);
  // The aircraft: pointing along its track on a north-up map, straight up on a track-up one.
  const a = d.map.northUp ? s.track : 0;
  const pt = (fwd: number, right: number): [number, number] => [
    0.5 + (Math.sin(a) * fwd + Math.cos(a) * right) * 0.035,
    0.5 - (Math.cos(a) * fwd - Math.sin(a) * right) * 0.035,
  ];
  // The elevation modes (decision 227) draw the snapshot's heights when they were sampled
  // for this range; until then, the chart.
  const t = s.terrain;
  const elevation =
    d.map.mode !== 'chart' && t && Math.abs(t.halfExtent - half) < 1
      ? elevationItems(t, d.map.mode, pact)
      : null;
  return [
    ...(elevation ?? [
      {
        kind: 'map' as const,
        lat: s.position.lat,
        lon: s.position.lon,
        halfExtent: half,
        rotation,
        radius: s.position.radius,
      },
    ]),
    // The fronts: in the chart they are in the picture; the elevation modes draw them.
    ...(elevation ? frontItems(s, half, rotation) : []),
    ...routeItems(s, half, rotation, fig),
    { kind: 'arc', x: 0.5, y: 0.5, r: 0.25, tone: 'normal', dashed: true },
    text(0.5 + 0.25 * 0.72, 0.5 + 0.25 * 0.72 + 0.06, fig(half / 2), 'small', 'left', 'normal'),
    { kind: 'line', points: [pt(1, 0), pt(-1, 0)], tone: 'normal', width: 2 },
    { kind: 'line', points: [pt(0.2, -0.8), pt(0.2, 0.8)], tone: 'normal', width: 2 },
    { kind: 'line', points: [pt(-0.8, -0.35), pt(-0.8, 0.35)], tone: 'normal', width: 2 },
    ...destinationMark(s, half, rotation, fig),
    // The range under the range buttons; the orientation is the TRK / N-UP button's label.
    text(0.04, 0.42, fig(half), 'small', 'left', 'normal'),
  ];
}

/**
 * The destination on the map (decision 202): a diamond at its bearing and distance with its
 * label, or a caret at the map's edge pointing to it with its distance when it lies beyond.
 */
function destinationMark(
  s: AircraftSnapshot,
  half: number,
  rotation: number,
  fig: (m: number) => string,
): ScreenItem[] {
  const d = s.destination;
  if (!d) return [];
  const at: MapBearing = [d.bearing, d.distance];
  const [x, y] = mapPlace(at, s.position.radius, half, rotation);
  if (onMap(x, y)) return [diamondItem(x, y, 0.022, 'normal', 2), label(x, y, d.label)];
  return edgeCaret(at, rotation, `${d.label} ${fig(d.distance)}`);
}

/** The strategic camera's vertical field of view (StrategicScene's 45°): the map picture's. */
export const MAP_FOV_Y = (45 * Math.PI) / 180;
/** How far from the center a place still counts as on the map (screen fractions). */
const MAP_EDGE = 0.44;

/**
 * Where a place lies on the moving map (decision 305), in screen fractions: the picture's
 * own projection, a camera straight down over the aircraft at the height that shows the
 * picture's half extent (√2 × the screen's) at its edge, so a waypoint sits where the
 * picture draws its ground. A place beyond that camera's horizon goes to the horizon,
 * along its bearing (always off the screen).
 */
export function mapPlace(
  at: Readonly<MapBearing>,
  R: number,
  half: number,
  rotation: number,
): [number, number] {
  const H = (half * Math.SQRT2) / Math.tan(MAP_FOV_Y / 2);
  const th = Math.min(at[1] / R, Math.acos(R / (R + H)));
  const m = (H * R * Math.sin(th)) / (H + R * (1 - Math.cos(th)));
  const r = (m / half) * 0.5;
  const rel = at[0] - rotation;
  return [0.5 + r * Math.sin(rel), 0.5 - r * Math.cos(rel)];
}

const onMap = (x: number, y: number) => Math.hypot(x - 0.5, y - 0.5) <= MAP_EDGE;

function diamondItem(x: number, y: number, q: number, tone: Tone, width: number): ScreenItem {
  return {
    kind: 'line',
    points: [
      [x, y - q],
      [x + q, y],
      [x, y + q],
      [x - q, y],
      [x, y - q],
    ],
    tone,
    width,
  };
}

const label = (x: number, y: number, t: string, tone: Tone = 'normal') =>
  text(x + 0.035, y + 0.012, t, 'small', 'left', tone);

/** A caret at the map's edge pointing out along a place's bearing, with its label. */
function edgeCaret(at: Readonly<MapBearing>, rotation: number, t: string): ScreenItem[] {
  const rel = at[0] - rotation;
  const x = 0.5 + MAP_EDGE * Math.sin(rel);
  const y = 0.5 - MAP_EDGE * Math.cos(rel);
  const tip = (a: number, l: number): [number, number] => [
    x + l * Math.sin(rel + a),
    y - l * Math.cos(rel + a),
  ];
  return [
    {
      kind: 'line',
      points: [tip(2.6, 0.035), tip(0, 0), tip(-2.6, 0.035)],
      tone: 'normal',
      width: 2,
    },
    text(x, y + (Math.cos(rel) > 0 ? 0.07 : -0.045), t, 'small', 'center', 'normal'),
  ];
}

/**
 * The flight plan on the map (decision 305): the legs between the waypoints (flown ones
 * dim, the one to the next waypoint wider), each waypoint's symbol with its number and
 * name (a circle; a triangle for the target, a ring around the station's racetrack, a
 * square for a landing field), the next one drawn bold, and a caret at the edge with its
 * distance when it lies beyond the range.
 */
function routeItems(
  s: AircraftSnapshot,
  half: number,
  rotation: number,
  fig: (m: number) => string,
): ScreenItem[] {
  const r = s.route;
  if (!r) return [];
  const R = s.position.radius;
  const place = (at: Readonly<MapBearing>) => mapPlace(at, R, half, rotation);
  const items: ScreenItem[] = [];
  const next = r.next < 0 ? r.waypoints.length : r.next;
  r.legs.forEach((leg, i) => {
    const flown = i + 1 < next;
    items.push({
      kind: 'line',
      points: leg.map(place),
      tone: flown ? 'dim' : 'normal',
      width: i + 1 === next ? 2 : 1.5,
    });
  });
  r.waypoints.forEach((w, i) => {
    const [x, y] = place(w.at);
    if (!onMap(x, y)) return;
    const tone: Tone = i < next ? 'dim' : 'normal';
    const width = i === next ? 3 : 1.5;
    const q = 0.018;
    if (w.kind === 'target')
      items.push({
        kind: 'line',
        points: [
          [x, y - q * 1.3],
          [x + q * 1.15, y + q * 0.7],
          [x - q * 1.15, y + q * 0.7],
          [x, y - q * 1.3],
        ],
        tone,
        width,
      });
    else if (w.kind === 'landing')
      items.push({
        kind: 'line',
        points: [
          [x - q, y - q],
          [x + q, y - q],
          [x + q, y + q],
          [x - q, y + q],
          [x - q, y - q],
        ],
        tone,
        width,
      });
    else {
      items.push({ kind: 'arc', x, y, r: q, tone });
      if (i === next) items.push({ kind: 'arc', x, y, r: q * 0.45, tone });
    }
    if (w.kind === 'station') items.push({ kind: 'arc', x, y, r: q * 2.4, tone, dashed: true });
    items.push(label(x, y, `${w.number} ${w.label}`, tone));
  });
  const n = r.waypoints[r.next];
  if (n) {
    const [x, y] = place(n.at);
    if (!onMap(x, y))
      items.push(...edgeCaret(n.at, rotation, `${n.number} ${n.label} ${fig(n.at[1])}`));
  }
  return items;
}

/**
 * The fronts on the elevation modes (decision 305), as the strategic map draws them: a
 * dark line on a pale casing with teeth in the attacker's color on its side.
 */
function frontItems(s: AircraftSnapshot, half: number, rotation: number): ScreenItem[] {
  const R = s.position.radius;
  const items: ScreenItem[] = [];
  for (const f of s.fronts ?? []) {
    const pts = f.points.map((p) => mapPlace(p, R, half, rotation));
    items.push({
      kind: 'line',
      points: pts,
      tone: 'normal',
      width: 2,
      color: FRONT_INK,
      casing: FRONT_CASING,
    });
    // Teeth every TOOTH_PERIOD along the line, on its attacker's side. The screen's y runs
    // down, so the left of a direction (dx, dy) is (dy, −dx).
    let carry = TOOTH_PERIOD / 2;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i]!;
      const [bx, by] = pts[i + 1]!;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-9) continue;
      const ux = (bx - ax) / len;
      const uy = (by - ay) / len;
      const nx = uy * f.teeth;
      const ny = -ux * f.teeth;
      for (let d = carry; d < len; d += TOOTH_PERIOD) {
        const cx = ax + ux * d;
        const cy = ay + uy * d;
        if (Math.abs(cx - 0.5) > 0.5 || Math.abs(cy - 0.5) > 0.5) continue;
        const b = TOOTH_BASE / 2;
        items.push({
          kind: 'line',
          points: [
            [cx - ux * b, cy - uy * b],
            [cx + nx * TOOTH_HEIGHT, cy + ny * TOOTH_HEIGHT],
            [cx + ux * b, cy + uy * b],
          ],
          tone: 'normal',
          color: f.color,
          fill: true,
        });
      }
      carry = (((carry - len) % TOOTH_PERIOD) + TOOTH_PERIOD) % TOOTH_PERIOD;
    }
  }
  return items;
}

/** The front's ink and casing, as Part II's (militaryModel.ts FRONT_COLOR, CASING_COLOR). */
const FRONT_INK = '#2a2a2a';
const FRONT_CASING = '#f4efe4';
/** Its teeth (screen fractions): base, height and spacing. */
const TOOTH_BASE = 0.034;
const TOOTH_HEIGHT = 0.026;
const TOOTH_PERIOD = 0.075;

/**
 * The contact LOCK takes (and the L key): the nearest radar contact in the scope, or
 * with a lock, the next one out by range after it, back to the nearest after the last.
 */
export function lockCandidate(s: AircraftSnapshot): string | null {
  const r = s.sensors?.radar;
  if (!r || !r.on) return null;
  const inScope = s
    .sensors!.contacts.filter(
      (c) =>
        c.source === 'radar' &&
        Math.abs(c.azimuth) <= r.azimuth &&
        c.range <= r.range &&
        c.side !== 'alliance',
    )
    .sort((a, b) => a.range - b.range);
  if (inScope.length === 0) return null;
  const at = inScope.findIndex((c) => c.id === r.lock);
  return inScope[(at + 1) % inScope.length]!.id;
}

/**
 * The air-to-air radar (decision 218): a B-scope, azimuth across and range up, over
 * the radar's scan limits and the display range. Radar contacts are filled squares,
 * datalink tracks hollow ones, visual contacts small circles; a friend (by datalink)
 * is a circle, a known hostile a diamond. Each has a stick along its heading as seen
 * from the nose, and its altitude in thousands of feet (hundreds of meters for the
 * Pact); the locked contact is ringed and its range, altitude, speed and closing speed
 * are written along the top.
 */
function radarFormat(s: AircraftSnapshot): ScreenItem[] {
  const sens = s.sensors;
  const r = sens?.radar;
  if (!sens || !r) return [text(0.5, 0.5, 'NO RADAR', 'normal', 'center', 'dim')];
  const pact = s.profile.skin === 'pact';
  const x0 = 0.14;
  const x1 = 0.86;
  const y0 = 0.16;
  // The scope ends above two lines for the locked contact, clear of the side buttons' labels.
  const y1 = 0.78;
  const scale = r.range;
  const items: ScreenItem[] = [
    {
      kind: 'line',
      points: [
        [x0, y1],
        [x1, y1],
      ],
      tone: 'dim',
    },
    {
      kind: 'line',
      points: [
        [0.5, y1],
        [0.5, y1 + 0.02],
      ],
      tone: 'dim',
    },
    text(
      0.04,
      0.42,
      pact ? `${Math.round(r.range / 1000)} KM` : `${Math.round(r.range / NM)} NM`,
      'small',
      'left',
      'normal',
    ),
  ];
  for (const f of [0.25, 0.5, 0.75]) {
    const y = y1 - (y1 - y0) * f;
    items.push({
      kind: 'line',
      points: [
        [x0, y],
        [x0 + 0.025, y],
      ],
      tone: 'dim',
    });
    items.push({
      kind: 'line',
      points: [
        [x1 - 0.025, y],
        [x1, y],
      ],
      tone: 'dim',
    });
  }
  if (!r.on) {
    items.push(text(0.5, 0.5, 'RADAR OFF', 'normal', 'center', 'dim'));
    return items;
  }
  const xAt = (az: number) => x0 + ((x1 - x0) * (az + r.azimuth)) / (2 * r.azimuth);
  if (r.mode === 'acm') {
    // Air combat mode's cone about the nose (decision 223).
    for (const az of [-ACM_CONE, ACM_CONE])
      items.push({
        kind: 'line',
        points: [
          [xAt(az), y0],
          [xAt(az), y1],
        ],
        tone: 'dim',
      });
  }
  let locked: (typeof sens.contacts)[number] | null = null;
  for (const c of sens.contacts) {
    if (Math.abs(c.azimuth) > r.azimuth || c.range > scale) continue;
    const x = xAt(c.azimuth);
    const y = y1 - ((y1 - y0) * c.range) / scale;
    // A click on a radar contact not a friend locks it (decision 223).
    if (c.source === 'radar' && c.side !== 'alliance' && !c.locked)
      items.push({
        kind: 'hit',
        x,
        y,
        r: 0.05,
        command: { to: 'avionics', command: { type: 'radar-lock', id: c.id } },
      });
    const q = 0.018;
    const tone: Tone = c.source === 'datalink' ? 'dim' : 'normal';
    if (c.side === 'alliance') items.push({ kind: 'arc', x, y, r: q, tone });
    else if (c.side === 'pact')
      items.push({
        kind: 'line',
        points: [
          [x, y - q * 1.3],
          [x + q * 1.3, y],
          [x, y + q * 1.3],
          [x - q * 1.3, y],
          [x, y - q * 1.3],
        ],
        tone,
        width: 2,
      });
    else if (c.source === 'visual') items.push({ kind: 'arc', x, y, r: q * 0.6, tone });
    else
      items.push({
        kind: 'bar',
        x: x - q,
        y: y - q,
        w: 2 * q,
        h: 2 * q,
        fill: c.source === 'radar' ? 1 : 0,
        vertical: false,
        tone,
      });
    // The heading stick, as seen from the nose (up the scope is the nose's direction).
    const rel = c.heading - s.heading;
    items.push({
      kind: 'line',
      points: [
        [x, y],
        [x + 0.05 * Math.sin(rel), y - 0.05 * Math.cos(rel)],
      ],
      tone,
    });
    const alt = pact ? Math.round(c.altitude / 100) : Math.round(c.altitude / 0.3048 / 1000);
    items.push(text(x, y + 0.055, String(Math.max(0, alt)), 'small', 'center', tone));
    if (c.locked) {
      items.push({ kind: 'arc', x, y, r: 0.04, tone: 'normal' });
      locked = c;
    }
  }
  if (locked) {
    const rng = pact
      ? `${(locked.range / 1000).toFixed(0)} KM`
      : `${(locked.range / NM).toFixed(0)} NM`;
    const alt = pact
      ? `${Math.round(locked.altitude / 10) * 10} M`
      : `${(Math.round(locked.altitude / 0.3048 / 100) * 100).toLocaleString('en-US')} FT`;
    const spd = pact
      ? `${Math.round(locked.speed * 3.6)} KMH`
      : `${Math.round(locked.speed / 0.514_444)} KT`;
    const vc = pact ? Math.round(locked.closing * 3.6) : Math.round(locked.closing / 0.514_444);
    items.push(text(0.5, 0.845, `${rng}  VC ${vc}`, 'small', 'center', 'normal'));
    items.push(text(0.5, 0.905, `${alt}  ${spd}`, 'small', 'center', 'normal'));
  }
  return items;
}

/**
 * The air-to-ground radar's ground map (decision 226): a B-scope of the ground ahead,
 * azimuth across and ground range up, the returns as phosphor intensity: slopes facing
 * the aircraft bright, water and radar shadow dark. The destination is a diamond where it
 * lies in the picture. Ranges in nautical miles, kilometers for the Pact.
 */
function groundMapFormat(s: AircraftSnapshot): ScreenItem[] {
  const map = s.sensors?.groundMap ?? null;
  const pact = s.profile.skin === 'pact';
  const x0 = 0.14;
  const x1 = 0.86;
  const y0 = 0.14;
  const y1 = 0.86;
  const items: ScreenItem[] = [];
  if (!map) return [text(0.5, 0.5, 'GMR STBY', 'normal', 'center', 'dim')];
  items.push({
    kind: 'raster',
    x: x0,
    y: y0,
    w: x1 - x0,
    h: y1 - y0,
    cols: map.cols,
    rows: map.rows,
    values: map.values,
  });
  // Range marks at quarters, the aircraft at the bottom center.
  for (const f of [0.25, 0.5, 0.75]) {
    const y = y1 - (y1 - y0) * f;
    items.push({
      kind: 'line',
      points: [
        [x0 - 0.025, y],
        [x0, y],
      ],
      tone: 'dim',
    });
  }
  items.push({
    kind: 'line',
    points: [
      [0.47, y1 + 0.035],
      [0.5, y1 + 0.005],
      [0.53, y1 + 0.035],
    ],
    tone: 'normal',
    width: 2,
  });
  items.push(
    text(
      0.04,
      0.42,
      pact ? `${Math.round(map.range / 1000)} KM` : `${Math.round(map.range / NM)} NM`,
      'small',
      'left',
      'normal',
    ),
  );
  const d = s.destination;
  if (d) {
    const az = Math.atan2(Math.sin(d.bearing - s.heading), Math.cos(d.bearing - s.heading));
    if (Math.abs(az) <= map.azimuth && d.distance <= map.range) {
      const x = x0 + ((x1 - x0) * (az + map.azimuth)) / (2 * map.azimuth);
      const y = y1 - ((y1 - y0) * d.distance) / map.range;
      const q = 0.022;
      items.push({
        kind: 'line',
        points: [
          [x, y - q],
          [x + q, y],
          [x, y + q],
          [x - q, y],
          [x, y - q],
        ],
        tone: 'normal',
        width: 2,
      });
      items.push(text(x + 0.035, y + 0.012, d.label, 'small', 'left', 'normal'));
    }
  }
  if (map.age > 6) items.push(text(0.5, 0.93, 'NO UPDATE', 'small', 'center', 'caution'));
  return items;
}

/** The log of calls and events, newest at the bottom; older lines dim. */
function messagesFormat(s: AircraftSnapshot): ScreenItem[] {
  const lines: { t: string; warn: boolean; age: number }[] = [];
  for (const m of s.messages)
    for (const t of m.text) lines.push({ t, warn: m.warn, age: s.time - m.at });
  return [
    text(0.03, 0.1, 'MSG', 'small', 'left', 'dim'),
    {
      kind: 'log',
      lines: lines.slice(-12).map((l) => ({
        // A warning carries a mark as well as its color (check 13: color is never the only cue).
        text: `${clock(s.time - l.age)} ${l.warn ? '▲ ' : ''}${l.t}`,
        tone: l.warn ? 'caution' : l.age > 20 ? 'dim' : 'normal',
      })),
    },
  ];
}

const clock = (t: number) => {
  const m = Math.floor(t / 60);
  const sec = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

/**
 * The threat warning (decision 218): the aircraft at the center, its nose up; each
 * emitter heard by its kind at its bearing, close in when it tracks the aircraft
 * (boxed) or launches (inverse), farther out while it searches; ground radars carry
 * a short bar beneath.
 */
function threatFormat(s: AircraftSnapshot): ScreenItem[] {
  const items: ScreenItem[] = [
    text(0.04, 0.1, 'RWR', 'small', 'left', 'dim'),
    { kind: 'arc', x: 0.5, y: 0.55, r: 0.4, tone: 'dim' },
    { kind: 'arc', x: 0.5, y: 0.55, r: 0.22, tone: 'dim', dashed: true },
    {
      kind: 'line',
      points: [
        [0.46, 0.55],
        [0.54, 0.55],
      ],
      tone: 'normal',
    },
    {
      kind: 'line',
      points: [
        [0.5, 0.51],
        [0.5, 0.6],
      ],
      tone: 'normal',
    },
  ];
  // Symbols that would overlap move outward, the tracking and launching ones placed first.
  const placed: [number, number][] = [];
  const order = [...(s.sensors?.threats ?? [])].sort(
    (a, b) => (a.state === 'search' ? 1 : 0) - (b.state === 'search' ? 1 : 0),
  );
  for (const t of order) {
    let rr = t.state === 'search' ? 0.31 : 0.15;
    let x = 0.5 + rr * Math.sin(t.azimuth);
    let y = 0.55 - rr * Math.cos(t.azimuth);
    while (
      rr < 0.4 &&
      placed.some(([px, py]) => Math.abs(px - x) < 0.13 && Math.abs(py - y) < 0.07)
    ) {
      rr += 0.05;
      x = 0.5 + rr * Math.sin(t.azimuth);
      y = 0.55 - rr * Math.cos(t.azimuth);
    }
    placed.push([x, y]);
    const tone: Tone =
      t.state === 'launch' ? 'warning' : t.state === 'track' ? 'caution' : 'normal';
    items.push(text(x, y + 0.03, t.kind, 'small', 'center', tone));
    if (t.ground)
      items.push({
        kind: 'line',
        points: [
          [x - 0.03, y + 0.06],
          [x + 0.03, y + 0.06],
        ],
        tone,
      });
  }
  return items;
}
