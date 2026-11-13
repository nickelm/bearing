/**
 * Flight-model data (Free Flight, decision 134; Proposal 0002, Flight Model):
 * the tables and constants of one aircraft type. The data lives in a `flight`
 * block of the aircraft's model spec (render/common/models/specs/*.json), next to
 * its geometry; the app and the tests pass the parsed block in, since sim code
 * may not import render.
 *
 * Units in the JSON are SI, except angles, which are in degrees as in the rest of
 * the model spec (sweep, dihedral); `parseFlightSpec` converts them to radians at
 * this boundary. Geometry (CG, wheels, contact points) is in the model frame:
 * meters, +x forward, +y up, +z to starboard. Values are approximate public F-16
 * figures and tuning values; the spec's `notes` say so.
 */
import { DEG } from '../../core/units';

/** A 1-D table: y(x) by linear interpolation, clamped at both ends. */
export interface Table1 {
  x: number[];
  y: number[];
}

/** A 2-D table over altitude (rows) and Mach (columns). */
export interface ThrustTable {
  altitude: number[];
  mach: number[];
  /** Newtons, [altitude][mach]. */
  idle: number[][];
  military: number[][];
  afterburner: number[][];
}

export interface WheelSpec {
  name: 'nose' | 'left' | 'right';
  /** Bottom of the tire with the strut extended and unloaded (model frame, m). */
  at: [number, number, number];
  /** Spring (N/m) and damper (N·s/m) along the local vertical. */
  stiffness: number;
  damping: number;
  /** Strut travel before it bottoms out (m). */
  travel: number;
  steerable: boolean;
  braked: boolean;
}

export interface FlightSpec {
  /** Masses (kg): empty with pilot, internal fuel, and payload (gun ammunition, wingtip missiles). */
  mass: { empty: number; fuel: number; payload: number };
  /** Principal moments of inertia about the body axes (kg·m²): roll, pitch, yaw. */
  inertia: [number, number, number];
  /** Center of gravity (model frame, m). */
  cg: [number, number, number];
  /** Wing reference area (m²), span (m) and mean aerodynamic chord (m). */
  wing: { area: number; span: number; chord: number };
  aero: {
    /** Lift coefficient by angle of attack (radians after parsing; degrees in JSON), −90°..90°. */
    cl: Table1;
    /** Lift increment of the flaps (they follow the gear handle) and where it fades out (rad). */
    flapCl: number;
    flapFadeAlpha: number;
    /** Zero-lift drag by Mach. */
    cd0: Table1;
    /** Induced drag factor k in k·CL². */
    induced: number;
    /** Separated-flow drag at high angle of attack: cdAlpha·sin²α. */
    cdAlpha: number;
    /** Drag increments of the landing gear (down), the flaps and the speedbrake (open). */
    cdGear: number;
    cdFlaps: number;
    cdSpeedbrake: number;
    /** Side force per radian of sideslip (negative opposes it). */
    cyBeta: number;
    /** Weathercock stability: yaw moment per radian of sideslip. */
    cnBeta: number;
    /**
     * Ground effect within about a span of the ground: lift grows by up to
     * `groundEffectLift`·CL and induced drag shrinks by up to `groundEffectDrag`,
     * both fading as exp(−2.5 h / span).
     */
    groundEffectLift: number;
    groundEffectDrag: number;
    /** Damping derivatives (per unit nondimensional rate): roll, pitch, yaw. */
    clp: number;
    cmq: number;
    cnr: number;
  };
  engine: {
    thrust: ThrustTable;
    /** Time constants (s) of the core spooling up and down and of the afterburner. */
    spoolUp: number;
    spoolDown: number;
    afterburner: number;
    /** Thrust-specific fuel consumption (kg/(N·s)) dry and in afterburner. */
    tsfcDry: number;
    tsfcWet: number;
  };
  controls: {
    /** Control moment coefficients at full authority: roll (span), pitch (chord), yaw (span). */
    rollAuthority: number;
    pitchAuthority: number;
    yawAuthority: number;
    /** Commanded limits: roll rate (rad/s), pitch rate in rate mode (rad/s), load factor. */
    maxRollRate: number;
    maxPitchRate: number;
    maxLoad: number;
    minLoad: number;
    /** Angle-of-attack limiter (rad) and the lowest commanded angle of attack (rad). */
    maxAlpha: number;
    minAlpha: number;
    /** Sideslip at full rudder (rad). */
    maxSideslip: number;
    /** Calibrated airspeeds (m/s) over which pitch blends from rate to load-factor command. */
    blendLow: number;
    blendHigh: number;
    /** Loop gains: load factor (rad/s per g), body rates (1/s), sideslip (1/s), α limiter (1/s). */
    loadGain: number;
    rateGain: [number, number, number];
    sideslipGain: number;
    alphaGain: number;
  };
  gear: {
    wheels: WheelSpec[];
    /** Gear transit time (s), and the highest calibrated airspeed with it down (m/s). */
    transit: number;
    maxSpeed: number;
    /** Friction coefficients: rolling, full braking, lateral (cornering) grip. */
    rolling: number;
    braking: number;
    lateral: number;
    /** Tangential stiffness (N/m) and damping (N·s/m) of the tire's grip spring. */
    gripStiffness: number;
    gripDamping: number;
    /** Nosewheel steering at taxi speed and at speed (rad), and the speed of the fade (m/s). */
    steerLow: number;
    steerHigh: number;
    steerFade: number;
  };
  /** Speedbrake transit time (s). */
  speedbrake: { transit: number };
  /** Hard points on the airframe (model frame): any of them touching the ground is a crash. */
  contacts: [number, number, number][];
  /** Notes on the figures (sources, tuning). */
  notes?: string;
}

export class FlightSpecError extends Error {}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Linear interpolation in a 1-D table, clamped at the ends. */
export function lookup(t: Readonly<Table1>, x: number): number {
  const xs = t.x;
  const ys = t.y;
  const n = xs.length;
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let i = 1;
  while (xs[i]! < x) i++;
  const x0 = xs[i - 1]!;
  const f = (x - x0) / (xs[i]! - x0);
  return ys[i - 1]! + (ys[i]! - ys[i - 1]!) * f;
}

/** Bilinear interpolation of thrust table `rows` at altitude `h` and Mach `m`, clamped. */
export function lookup2(
  alt: readonly number[],
  mach: readonly number[],
  rows: readonly number[][],
  h: number,
  m: number,
): number {
  const find = (xs: readonly number[], x: number): [number, number] => {
    const n = xs.length;
    if (x <= xs[0]!) return [0, 0];
    if (x >= xs[n - 1]!) return [n - 2, 1];
    let i = 1;
    while (xs[i]! < x) i++;
    return [i - 1, (x - xs[i - 1]!) / (xs[i]! - xs[i - 1]!)];
  };
  const [i, fi] = find(alt, h);
  const [j, fj] = find(mach, m);
  const r0 = rows[i]!;
  const r1 = rows[Math.min(i + 1, rows.length - 1)]!;
  const j1 = Math.min(j + 1, mach.length - 1);
  const a = r0[j]! + (r0[j1]! - r0[j]!) * fj;
  const b = r1[j]! + (r1[j1]! - r1[j]!) * fj;
  return a + (b - a) * fi;
}

/**
 * Checks a parsed `flight` block and returns it in SI units (angles in radians);
 * throws FlightSpecError naming the first problem.
 */
export function parseFlightSpec(raw: unknown, id = '?'): FlightSpec {
  const fail = (path: string, msg: string): never => {
    throw new FlightSpecError(`flight model ${id}: ${path}: ${msg}`);
  };
  if (typeof raw !== 'object' || raw === null) fail('', 'not an object');
  const s = structuredClone(raw) as Record<string, Record<string, unknown>>;
  const num = (obj: Record<string, unknown> | undefined, key: string, path: string): number => {
    const v = obj?.[key];
    if (!isNum(v)) fail(`${path}.${key}`, 'missing or not a number');
    return v as number;
  };
  const pos = (obj: Record<string, unknown> | undefined, key: string, path: string): number => {
    const v = num(obj, key, path);
    if (!(v > 0)) fail(`${path}.${key}`, 'must be positive');
    return v;
  };
  const vec = (v: unknown, path: string): [number, number, number] => {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) fail(path, 'must be [x, y, z]');
    return v as [number, number, number];
  };
  const table = (v: unknown, path: string, scaleX = 1): Table1 => {
    const t = v as Table1 | undefined;
    if (!t || !Array.isArray(t.x) || !Array.isArray(t.y) || t.x.length < 2)
      fail(path, 'must be { x: [...], y: [...] } with 2+ points');
    if (t!.x.length !== t!.y.length) fail(path, 'x and y differ in length');
    if (![...t!.x, ...t!.y].every(isNum)) fail(path, 'non-numeric entry');
    for (let i = 1; i < t!.x.length; i++)
      if (!(t!.x[i]! > t!.x[i - 1]!)) fail(`${path}.x`, 'must increase');
    return { x: t!.x.map((x) => x * scaleX), y: [...t!.y] };
  };

  const mass = s.mass;
  pos(mass, 'empty', 'mass');
  num(mass, 'fuel', 'mass');
  num(mass, 'payload', 'mass');
  const inertia = vec(s.inertia, 'inertia');
  if (!inertia.every((x) => x > 0)) fail('inertia', 'must be positive');
  vec(s.cg, 'cg');
  for (const k of ['area', 'span', 'chord']) pos(s.wing, k, 'wing');

  const aero = s.aero ?? fail('aero', 'missing');
  aero.cl = table(aero.cl, 'aero.cl', DEG);
  aero.cd0 = table(aero.cd0, 'aero.cd0');
  for (const k of [
    'flapCl',
    'induced',
    'cdAlpha',
    'cdGear',
    'cdFlaps',
    'cdSpeedbrake',
    'cyBeta',
    'cnBeta',
    'groundEffectLift',
    'groundEffectDrag',
    'clp',
    'cmq',
    'cnr',
  ])
    num(aero, k, 'aero');
  aero.flapFadeAlpha = num(aero, 'flapFadeAlpha', 'aero') * DEG;

  const engine = s.engine ?? fail('engine', 'missing');
  const th = engine.thrust as unknown as ThrustTable | undefined;
  if (!th || !Array.isArray(th.altitude) || !Array.isArray(th.mach))
    fail('engine.thrust', 'needs altitude and mach');
  for (const k of ['idle', 'military', 'afterburner'] as const) {
    const rows = th![k];
    if (!Array.isArray(rows) || rows.length !== th!.altitude.length)
      fail(`engine.thrust.${k}`, 'needs one row per altitude');
    rows.forEach((r, i) => {
      if (!Array.isArray(r) || r.length !== th!.mach.length || !r.every(isNum))
        fail(`engine.thrust.${k}[${i}]`, 'needs one number per Mach');
    });
  }
  for (const k of ['spoolUp', 'spoolDown', 'afterburner', 'tsfcDry', 'tsfcWet'])
    pos(engine, k, 'engine');

  const c = s.controls ?? fail('controls', 'missing');
  for (const k of ['rollAuthority', 'pitchAuthority', 'yawAuthority', 'maxLoad', 'loadGain'])
    pos(c, k, 'controls');
  num(c, 'minLoad', 'controls');
  for (const k of ['blendLow', 'blendHigh', 'sideslipGain', 'alphaGain']) pos(c, k, 'controls');
  for (const k of ['maxRollRate', 'maxPitchRate', 'maxAlpha', 'minAlpha', 'maxSideslip'])
    c[k] = num(c, k, 'controls') * DEG;
  const rg = vec(c.rateGain, 'controls.rateGain');
  if (!rg.every((x) => x > 0)) fail('controls.rateGain', 'must be positive');

  const g = s.gear ?? fail('gear', 'missing');
  const wheels = g.wheels as unknown;
  if (!Array.isArray(wheels) || wheels.length !== 3) fail('gear.wheels', 'needs three wheels');
  (wheels as Record<string, unknown>[]).forEach((w, i) => {
    const p = `gear.wheels[${i}]`;
    if (w.name !== 'nose' && w.name !== 'left' && w.name !== 'right')
      fail(`${p}.name`, 'must be nose, left or right');
    vec(w.at, `${p}.at`);
    for (const k of ['stiffness', 'damping', 'travel']) pos(w, k, p);
    if (typeof w.steerable !== 'boolean' || typeof w.braked !== 'boolean')
      fail(p, 'needs steerable and braked flags');
  });
  for (const k of [
    'transit',
    'maxSpeed',
    'rolling',
    'braking',
    'lateral',
    'gripStiffness',
    'gripDamping',
    'steerFade',
  ])
    pos(g, k, 'gear');
  g.steerLow = num(g, 'steerLow', 'gear') * DEG;
  g.steerHigh = num(g, 'steerHigh', 'gear') * DEG;
  pos(s.speedbrake, 'transit', 'speedbrake');
  if (!Array.isArray(s.contacts) || s.contacts.length === 0)
    fail('contacts', 'needs at least one point');
  (s.contacts as unknown as unknown[]).forEach((p, i) => vec(p, `contacts[${i}]`));
  return s as unknown as FlightSpec;
}
