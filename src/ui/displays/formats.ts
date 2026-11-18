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
import type { AircraftSnapshot } from './snapshot';

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
};

type Format = (s: AircraftSnapshot, d: DisplayState, slot: SlotId) => ScreenItem[];

const FORMATS: Partial<Record<FormatId, Format>> = {
  'moving-map': movingMapFormat,
  engines: enginesFormat,
  messages: messagesFormat,
  threat: threatFormat,
  'radar-aa': radarFormat,
};

/** The moving map's ranges, center to edge (nautical miles; decision 201). */
export const MAP_RANGES_NM = [5, 10, 20, 40, 80, 160] as const;
const NM = 1852;

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

/** Engines and fuel: the fuel's level against joker and bingo, the throttle and power. */
function enginesFormat(s: AircraftSnapshot): ScreenItem[] {
  const f = s.fuel;
  const frac = f.capacity > 0 ? Math.min(1, f.mass / f.capacity) : 0;
  const tone: Tone = f.unlimited
    ? 'normal'
    : f.mass < f.bingo
      ? 'warning'
      : f.mass < f.joker
        ? 'caution'
        : 'normal';
  const items: ScreenItem[] = [
    text(0.08, 0.14, 'FUEL', 'small', 'left', 'dim'),
    text(0.08, 0.24, f.unlimited ? 'UNLIMITED' : fuelText(s, f.mass), 'large', 'left', tone),
    { kind: 'bar', x: 0.08, y: 0.32, w: 0.5, h: 0.08, fill: frac, vertical: false, tone },
  ];
  if (!f.unlimited && f.capacity > 0) {
    for (const [v, name] of [
      // Short marks: the two sit close (35% and 20%), and full words collided.
      [f.joker, 'J'],
      [f.bingo, 'B'],
    ] as const) {
      const x = 0.08 + 0.5 * (v / f.capacity);
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
 * The moving map (decision 201): the strategic view's picture under the aircraft,
 * north-up or track-up, the aircraft at the center, a ring at half the range with
 * its figure, and the range and orientation in the corners. Ranges in nautical miles
 * for the Alliance, kilometers for the Pact.
 */
function movingMapFormat(s: AircraftSnapshot, d: DisplayState): ScreenItem[] {
  const nm = MAP_RANGES_NM[Math.max(0, Math.min(MAP_RANGES_NM.length - 1, d.map.range))]!;
  const half = nm * NM;
  const rotation = d.map.northUp ? 0 : s.track;
  const pact = s.profile.skin === 'pact';
  const fig = (m: number) => (pact ? `${Math.round(m / 1000)} KM` : `${Math.round(m / NM)} NM`);
  // The aircraft: pointing along its track on a north-up map, straight up on a track-up one.
  const a = d.map.northUp ? s.track : 0;
  const pt = (fwd: number, right: number): [number, number] => [
    0.5 + (Math.sin(a) * fwd + Math.cos(a) * right) * 0.035,
    0.5 - (Math.cos(a) * fwd - Math.sin(a) * right) * 0.035,
  ];
  return [
    {
      kind: 'map',
      lat: s.position.lat,
      lon: s.position.lon,
      halfExtent: half,
      rotation,
      radius: s.position.radius,
    },
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
  const rel = d.bearing - rotation;
  const edge = 0.44;
  const r = (d.distance / half) * 0.5;
  const inside = r <= edge;
  const k = inside ? r : edge;
  const x = 0.5 + k * Math.sin(rel);
  const y = 0.5 - k * Math.cos(rel);
  const q = 0.022;
  if (inside)
    return [
      {
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
      },
      text(x + 0.035, y + 0.012, d.label, 'small', 'left', 'normal'),
    ];
  // A caret at the edge, pointing out along the bearing.
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
    text(
      x,
      y + (Math.cos(rel) > 0 ? 0.07 : -0.045),
      `${d.label} ${fig(d.distance)}`,
      'small',
      'center',
      'normal',
    ),
  ];
}

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
        c.range <= r.rangeNm * NM &&
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
  const scale = r.rangeNm * NM;
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
      pact ? `${Math.round((r.rangeNm * NM) / 1000)} KM` : `${r.rangeNm} NM`,
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
  let locked: (typeof sens.contacts)[number] | null = null;
  for (const c of sens.contacts) {
    if (Math.abs(c.azimuth) > r.azimuth || c.range > scale) continue;
    const x = x0 + ((x1 - x0) * (c.azimuth + r.azimuth)) / (2 * r.azimuth);
    const y = y1 - ((y1 - y0) * c.range) / scale;
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
