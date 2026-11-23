/**
 * Input profiles (Proposal 0014, decision 365): bindings and axis tuning per device kind
 * (keyboard, gamepad, joystick) and aircraft class (fixed-wing, rotary), kept in
 * `localStorage` under `bearing.input.v1`, exported and imported as JSON.
 *
 * - **Keyboard.** The key tables stay where the code reads them (`FLIGHT_BINDINGS`,
 *   `HELO_BINDINGS`, `DISPLAY_BINDINGS`); each registers here once, the store keeps a copy of
 *   its defaults and writes the saved bindings into it, so every reader (the inputs, the help
 *   card, the tests) sees the same table.
 * - **Gamepad** (standard mapping): the Mode 2 layout of Proposal 0014 for each class.
 * - **Joystick** (any other mapping: flight sticks, throttles): stick on axes 0 and 1, twist
 *   on 2, an absolute throttle on 3, as Free Flight read them before (decision 134).
 * - **Global** gamepad actions act outside the aircraft: menus and the campaign's mission
 *   search and follow view.
 *
 * Stored profiles merge over the defaults, so an action added later gets its default.
 */
import type { AxisTuning } from './axis';
import { PAD, chord, padCode } from './codes';
import type { DeviceKind } from './gamepad';

export type AircraftClass = 'fixed' | 'rotary';

/** The analog controls an aircraft class reads. */
export const AXES: Record<AircraftClass, readonly AxisId[]> = {
  fixed: ['pitch', 'roll', 'yaw', 'throttle', 'lookX', 'lookY'],
  rotary: ['cyclicPitch', 'cyclicRoll', 'pedals', 'collective', 'lookX', 'lookY'],
};

export type AxisId =
  | 'pitch'
  | 'roll'
  | 'yaw'
  | 'throttle'
  | 'cyclicPitch'
  | 'cyclicRoll'
  | 'pedals'
  | 'collective'
  | 'lookX'
  | 'lookY';

export const AXIS_LABELS: Record<AxisId, string> = {
  pitch: 'Pitch (stick back: nose up)',
  roll: 'Roll',
  yaw: 'Rudder',
  throttle: 'Throttle',
  cyclicPitch: 'Cyclic fore and aft (back: nose up)',
  cyclicRoll: 'Cyclic left and right',
  pedals: 'Pedals',
  collective: 'Collective',
  lookX: 'Free look left and right',
  lookY: 'Free look up and down',
};

/** How the throttle or collective axis drives its control. */
export type AxisMode = 'rate' | 'absolute';

export interface AxisSetting extends AxisTuning {
  /** Throttle and collective only: a centering stick as a rate, or a lever's position. */
  mode?: AxisMode;
}

export interface PadOptions {
  /** The left stick's cross-talk guard (decision 362). */
  crossGuard: number;
  /** Yaw on the bumpers, ramping while held; the look modifier moves to the left stick's click. */
  yawOnBumpers: boolean;
  rumble: boolean;
}

export interface PadProfile {
  buttons: Record<string, string[]>;
  axes: Partial<Record<AxisId, AxisSetting>>;
  options: PadOptions;
}

export interface StoredInput {
  version: 1;
  keyboard: Record<string, Record<string, string[]>>;
  gamepad: Record<AircraftClass, PadProfile>;
  joystick: Record<AircraftClass, PadProfile>;
  global: Record<DeviceKind, Record<string, string[]>>;
}

const P = padCode;
const LB = P(PAD.lb);
const L3 = P(PAD.l3);

const ax = (axis: number, o: Partial<AxisSetting> = {}): AxisSetting => ({
  axis,
  invert: false,
  deadzone: 0.1,
  curve: 0,
  sensitivity: 1,
  ...o,
});

/** The display actions every class shares on the D-pad (decision 366). */
function displayButtons(mod: string): Record<string, string[]> {
  return {
    masterMode: [P(PAD.up)],
    dogfight: [P(PAD.down)],
    pageLeft: [P(PAD.left)],
    pageRight: [P(PAD.right)],
    masterCaution: [chord(mod, P(PAD.up))],
    steerpointNext: [chord(mod, P(PAD.down))],
    slotLeft: [chord(mod, P(PAD.left))],
    slotRight: [chord(mod, P(PAD.right))],
    radarLock: [P(PAD.north)],
    radarBreak: [chord(mod, P(PAD.north))],
    weaponNext: [P(PAD.west)],
    masterArm: [chord(mod, P(PAD.rt))],
    displayFocus: [chord(mod, P(PAD.select))],
  };
}

/** The default Mode 2 gamepad profile of a class (Proposal 0014's table). */
export function defaultGamepad(cls: AircraftClass, yawOnBumpers = false): PadProfile {
  // With yaw on the bumpers the look modifier, and with it every chord, moves to L3.
  const mod = yawOnBumpers ? L3 : LB;
  const common: Record<string, string[]> = {
    fire: [P(PAD.rt)],
    secondary: [P(PAD.lt)],
    countermeasures: yawOnBumpers ? [] : [P(PAD.rb)],
    freeLook: [mod],
    padlock: [P(PAD.r3)],
    recenterView: [chord(mod, P(PAD.r3))],
    pause: [P(PAD.start)],
    help: [P(PAD.select)],
    parkingBrake: yawOnBumpers ? [chord(mod, P(PAD.south))] : [L3],
    ...displayButtons(mod),
  };
  const yaw: Record<string, string[]> = yawOnBumpers
    ? { yawLeft: [LB], yawRight: [P(PAD.rb)] }
    : {};
  const stickR = { deadzone: 0.08, curve: 0.35 };
  const left = { deadzone: 0.15 };
  if (cls === 'fixed')
    return {
      buttons: {
        ...common,
        ...yaw,
        gear: [P(PAD.south)],
        speedbrake: [P(PAD.east)],
        jettison: [chord(mod, P(PAD.west))],
        eject: [chord(mod, P(PAD.east))],
      },
      axes: {
        pitch: ax(3, stickR),
        roll: ax(2, stickR),
        yaw: ax(yawOnBumpers ? -1 : 0, left),
        throttle: ax(1, { ...left, invert: true, mode: 'rate' }),
        lookX: ax(2, { deadzone: 0.1 }),
        lookY: ax(3, { deadzone: 0.1 }),
      },
      options: { crossGuard: 0.4, yawOnBumpers, rumble: true },
    };
  return {
    buttons: {
      ...common,
      ...(yawOnBumpers
        ? { pedalLeft: [LB], pedalRight: [P(PAD.rb)] }
        : ({} as Record<string, string[]>)),
      hoverHold: [P(PAD.south)],
      hook: [P(PAD.east)],
      brakes: [chord(mod, P(PAD.east))],
    },
    axes: {
      cyclicPitch: ax(3, stickR),
      cyclicRoll: ax(2, stickR),
      pedals: ax(yawOnBumpers ? -1 : 0, left),
      collective: ax(1, { ...left, invert: true, mode: 'rate' }),
      lookX: ax(2, { deadzone: 0.1 }),
      lookY: ax(3, { deadzone: 0.1 }),
    },
    options: { crossGuard: 0.4, yawOnBumpers, rumble: true },
  };
}

/** The default joystick profile (any non-standard device), as Free Flight read sticks before. */
export function defaultJoystick(cls: AircraftClass): PadProfile {
  const t = { deadzone: 0.08 };
  return cls === 'fixed'
    ? {
        buttons: { fire: [P(0)] },
        axes: {
          pitch: ax(1, t),
          roll: ax(0, t),
          yaw: ax(2, t),
          throttle: ax(3, { deadzone: 0, invert: true, mode: 'absolute' }),
        },
        options: { crossGuard: 0, yawOnBumpers: false, rumble: false },
      }
    : {
        buttons: { fire: [P(0)] },
        axes: {
          cyclicPitch: ax(1, t),
          cyclicRoll: ax(0, t),
          pedals: ax(2, t),
          collective: ax(3, { deadzone: 0.1, invert: true, mode: 'rate' }),
        },
        options: { crossGuard: 0, yawOnBumpers: false, rumble: false },
      };
}

/** Gamepad actions outside the aircraft: menus and the campaign (decision 366). */
export function defaultGlobal(kind: DeviceKind): Record<string, string[]> {
  if (kind === 'joystick') return {};
  return {
    missionSearch: [P(PAD.select)],
    takeControl: [P(PAD.south)],
    handBack: [chord(LB, P(PAD.start))],
    backToMap: [P(PAD.east), P(PAD.start)],
    nextAircraft: [P(PAD.right)],
    nextPanels: [P(PAD.left)],
    recenterView: [P(PAD.r3)],
  };
}

export function defaultStored(): StoredInput {
  return {
    version: 1,
    keyboard: {},
    gamepad: { fixed: defaultGamepad('fixed'), rotary: defaultGamepad('rotary') },
    joystick: { fixed: defaultJoystick('fixed'), rotary: defaultJoystick('rotary') },
    global: { gamepad: defaultGlobal('gamepad'), joystick: defaultGlobal('joystick') },
  };
}

const KEY = 'bearing.input.v1';

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function stringLists(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!isObj(v)) return out;
  for (const [k, l] of Object.entries(v))
    if (Array.isArray(l)) out[k] = l.filter((x): x is string => typeof x === 'string');
  return out;
}

function mergePad(def: PadProfile, v: unknown): PadProfile {
  if (!isObj(v)) return def;
  const axes = { ...def.axes };
  if (isObj(v.axes))
    for (const [k, a] of Object.entries(v.axes)) {
      if (!isObj(a)) continue;
      const base = axes[k as AxisId] ?? ax(-1);
      const num = (x: unknown, d: number, lo: number, hi: number) =>
        typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
      axes[k as AxisId] = {
        axis: Math.round(num(a.axis, base.axis, -1, 31)),
        invert: typeof a.invert === 'boolean' ? a.invert : base.invert,
        deadzone: num(a.deadzone, base.deadzone, 0, 0.9),
        curve: num(a.curve, base.curve, 0, 1),
        sensitivity: num(a.sensitivity, base.sensitivity, 0.1, 2),
        ...(base.mode || a.mode
          ? { mode: a.mode === 'absolute' || a.mode === 'rate' ? a.mode : base.mode }
          : {}),
      };
    }
  const o = isObj(v.options) ? v.options : {};
  return {
    buttons: { ...def.buttons, ...stringLists(v.buttons) },
    axes,
    options: {
      crossGuard:
        typeof o.crossGuard === 'number'
          ? Math.min(0.9, Math.max(0, o.crossGuard))
          : def.options.crossGuard,
      yawOnBumpers: typeof o.yawOnBumpers === 'boolean' ? o.yawOnBumpers : def.options.yawOnBumpers,
      rumble: typeof o.rumble === 'boolean' ? o.rumble : def.options.rumble,
    },
  };
}

/** A stored or imported profile set merged over the defaults; throws on what is not one. */
export function parseStored(json: string): StoredInput {
  const v: unknown = JSON.parse(json);
  if (!isObj(v) || v.version !== 1) throw new Error('not a Bearing input profile (version 1)');
  const d = defaultStored();
  const keyboard: Record<string, Record<string, string[]>> = {};
  if (isObj(v.keyboard))
    for (const [k, t] of Object.entries(v.keyboard)) keyboard[k] = stringLists(t);
  const g = isObj(v.gamepad) ? v.gamepad : {};
  const j = isObj(v.joystick) ? v.joystick : {};
  const gl = isObj(v.global) ? v.global : {};
  // A profile saved with yaw on the bumpers merges over that variant's defaults.
  const padDefault = (cls: AircraftClass) => {
    const p = g[cls];
    const bumpers = isObj(p) && isObj(p.options) && p.options.yawOnBumpers === true;
    return defaultGamepad(cls, bumpers);
  };
  return {
    version: 1,
    keyboard,
    gamepad: {
      fixed: mergePad(padDefault('fixed'), g.fixed),
      rotary: mergePad(padDefault('rotary'), g.rotary),
    },
    joystick: {
      fixed: mergePad(d.joystick.fixed, j.fixed),
      rotary: mergePad(d.joystick.rotary, j.rotary),
    },
    global: {
      gamepad: { ...d.global.gamepad, ...stringLists(gl.gamepad) },
      joystick: { ...d.global.joystick, ...stringLists(gl.joystick) },
    },
  };
}

/** The profile store: one per app (`profiles()`), tests make their own. */
export class ProfileStore {
  data: StoredInput;
  private readonly tables = new Map<
    string,
    { table: Record<string, string[]>; defaults: Record<string, string[]> }
  >();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage(),
  ) {
    this.data = defaultStored();
    try {
      const raw = this.storage?.getItem(KEY);
      if (raw) this.data = parseStored(raw);
    } catch {
      /* unreadable or blocked: the defaults */
    }
  }

  /** Called after every change (the inputs rebuild their resolvers). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Registers a key table under `name` (`fixed`, `rotary`, `displays`): its defaults are
   * copied once and the saved bindings written into it. Idempotent.
   */
  registerKeys(name: string, table: Record<string, string[]>): void {
    if (this.tables.has(name)) return;
    const defaults: Record<string, string[]> = {};
    for (const [a, l] of Object.entries(table)) defaults[a] = [...l];
    this.tables.set(name, { table, defaults });
    this.applyKeys(name);
  }

  /** The registered key tables' names. */
  get keyTables(): string[] {
    return [...this.tables.keys()];
  }

  keyTable(name: string): Record<string, string[]> | undefined {
    return this.tables.get(name)?.table;
  }

  keyDefaults(name: string): Record<string, string[]> | undefined {
    return this.tables.get(name)?.defaults;
  }

  private applyKeys(name: string): void {
    const t = this.tables.get(name);
    if (!t) return;
    const saved = this.data.keyboard[name] ?? {};
    for (const a of Object.keys(t.table)) t.table[a] = [...(saved[a] ?? t.defaults[a] ?? [])];
  }

  /** Binds keys (or mouse buttons) to an action of a key table. */
  setKeys(name: string, action: string, codes: string[]): void {
    const t = this.tables.get(name);
    if (!t) return;
    const saved = (this.data.keyboard[name] ??= {});
    saved[action] = [...codes];
    t.table[action] = [...codes];
    this.save();
  }

  /** A device profile of a class. */
  pad(kind: DeviceKind, cls: AircraftClass): PadProfile {
    return this.data[kind][cls];
  }

  setPad(kind: DeviceKind, cls: AircraftClass, p: PadProfile): void {
    this.data[kind][cls] = p;
    this.save();
  }

  global(kind: DeviceKind): Record<string, string[]> {
    return this.data.global[kind];
  }

  /** Back to the defaults: one device kind (and class), or everything. */
  reset(kind?: 'keyboard' | DeviceKind, cls?: AircraftClass): void {
    const d = defaultStored();
    if (!kind || kind === 'keyboard') {
      this.data.keyboard = {};
      for (const name of this.tables.keys()) this.applyKeys(name);
    }
    if (!kind || kind === 'gamepad' || kind === 'joystick')
      for (const k of kind ? [kind] : (['gamepad', 'joystick'] as const)) {
        for (const c of cls ? [cls] : (['fixed', 'rotary'] as const)) this.data[k][c] = d[k][c];
        if (!cls) this.data.global[k] = d.global[k];
      }
    this.save();
  }

  /** The whole set as JSON, for a file. */
  export(): string {
    return JSON.stringify(this.data, null, 2);
  }

  /** Replaces the set with an exported one; throws, changing nothing, if it is not one. */
  import(json: string): void {
    this.data = parseStored(json);
    for (const name of this.tables.keys()) this.applyKeys(name);
    this.save();
  }

  save(): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage blocked: the bindings last for this visit */
    }
    for (const fn of [...this.listeners]) fn();
  }
}

function safeStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

let shared: ProfileStore | null = null;

export function profiles(): ProfileStore {
  return (shared ??= new ProfileStore());
}

/** Replaces the shared store (tests). */
export function setProfiles(s: ProfileStore | null): void {
  shared = s;
}
