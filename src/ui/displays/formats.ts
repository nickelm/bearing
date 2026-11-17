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
  engines: enginesFormat,
  messages: messagesFormat,
  threat: threatFormat,
};

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
  // Top row, right end: the pin.
  buttons[4] = {
    label: st.pinned ? 'PIN' : 'pin',
    active: st.pinned,
    command: { to: 'ui', command: { type: 'pin', slot, pinned: !st.pinned } },
  };
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

/** The threat warning's scope: rings, the aircraft at the center; emitters come with P3's sensor model. */
function threatFormat(): ScreenItem[] {
  return [
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
}
