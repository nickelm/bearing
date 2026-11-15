/**
 * A helicopter's flight data (Proposal 0004, Type Parameters; track H1): the
 * `flight` block of its model spec with `"kind": "rotorcraft"`, checked and
 * converted to SI. Angles are in degrees in the JSON, as in the Kestrel's
 * block (decision 134); everything else is SI there too. The sim receives the
 * parsed block, since it may not import render (rule 6).
 *
 * Frames: positions in the model frame (+x forward, +y up, +z starboard, meters,
 * origin on the ground), converted to body axes about the CG with `modelToBody`.
 */
import type { Vec3d } from '../../../core/vec3d';
import { DEG } from '../../../core/units';
import { FlightSpecError } from '../flightSpec';
import type { StrutSpec, TireSpec } from '../contact';
import { modelToBody } from '../rigidBody';

type V3 = [number, number, number];

export type HubType = 'teetering' | 'articulated' | 'hingeless';

/** A rotor as a disc of blades (main or tail). */
export interface RotorDiscSpec {
  /** Hub (model frame, m). */
  at: V3;
  radius: number;
  blades: number;
  chord: number;
  /** Lift-curve slope (per rad), profile drag coefficient, linear twist root to tip (rad, negative washes out). */
  liftSlope: number;
  cd0: number;
  twist: number;
  /** Induced-power factor κ and tip-loss factor B. */
  kappa: number;
  tipLoss: number;
  /** Governed rotor speed (rad/s). */
  speed: number;
  /** +1 counterclockwise seen from above (from the tip of the thrust axis), −1 clockwise. */
  direction: 1 | -1;
}

export interface MainRotorSpec extends RotorDiscSpec {
  hub: HubType;
  /** Hub moment per radian of disc tilt beyond the thrust's own (N·m/rad); 0 for a teetering rotor. */
  hubStiffness: number;
  /** Lock number γ: aerodynamic over inertial flapping forces; sets the flapping time constant 16/(γΩ). */
  lock: number;
  /** Shaft tilt forward (rad). */
  shaftTilt: number;
  /** Rotor's polar moment of inertia about the shaft, drive train included (kg·m²). */
  inertia: number;
  /** Collective: blade pitch at 0.75 R at the stops (rad). */
  collective: [number, number];
  /** Disc tilt at full cyclic, fore-aft and lateral (rad). */
  cyclic: [number, number];
  /** Flapping stop: largest tilt of the disc against the shaft (rad). */
  maxFlap: number;
}

export interface TailRotorSpec extends RotorDiscSpec {
  /** Thrust direction for positive pitch (model frame, unit). */
  axis: V3;
  /** Blade pitch at 0.75 R at full left and full right pedal (rad). */
  pitch: [number, number];
}

export interface EngineSpec {
  /** Power at sea level in the standard atmosphere, all engines (W), and the transmission's limit (W). */
  power: number;
  transmission: number;
  /** Power available ∝ (ρ/ρ₀)^lapse, less `hotLoss` per kelvin above the standard temperature. */
  lapse: number;
  hotLoss: number;
  /** Engine response time constant (s). */
  spool: number;
  /** Specific fuel consumption (kg/J). */
  sfc: number;
}

export interface SurfaceSpec {
  at: V3;
  /** Area (m²), lift slope (per rad), incidence (rad, + leading edge up). */
  area: number;
  slope: number;
  incidence: number;
}

export interface GearPointSpec extends StrutSpec {
  at: V3;
  /** Wheel brakes on this point (wheels); skids always slide on friction. */
  braked: boolean;
  /** A castoring wheel: no side force while it rolls. */
  castor: boolean;
}

export interface RotorcraftSpec {
  kind: 'rotorcraft';
  /** Masses (kg): empty with crew, internal fuel, payload. */
  mass: { empty: number; fuel: number; payload: number };
  /** Principal moments of inertia (kg·m²): roll, pitch, yaw. */
  inertia: [number, number, number];
  /** Center of gravity (model frame, m). */
  cg: V3;
  main: MainRotorSpec;
  tail: TailRotorSpec;
  engine: EngineSpec;
  /** Fuselage drag areas along body x, y, z (m², f = C_D·S), and the tail surfaces. */
  fuselage: { drag: V3; fin: SurfaceSpec; stabilizer: SurfaceSpec };
  gear: { kind: 'skids' | 'wheels'; points: GearPointSpec[]; tire: TireSpec };
  /** Hard points (model frame): touching the ground is a crash. */
  contacts: V3[];
  limits: {
    /** Never-exceed speed (m/s, true airspeed), landing sink rate that crashes (m/s), slope limit (rad). */
    vne: number;
    crashSink: number;
    slope: number;
  };
  /** The control layer's figures (heloLaws.ts), per type. */
  controls: {
    /** Below `hoverSpeed` the mouse turns the nose; above `turnSpeed` it banks (m/s). */
    hoverSpeed: number;
    turnSpeed: number;
    /** Attitude limits of the Assisted preset are in assists.ts; these are the type's rates. */
    maxYawRate: number;
    maxClimbRate: number;
    maxSideSpeed: number;
  };
  notes?: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Checks and converts a rotorcraft flight block; throws FlightSpecError naming the first problem. */
export function parseRotorcraftSpec(raw: unknown, id = '?'): RotorcraftSpec {
  const fail = (path: string, msg: string): never => {
    throw new FlightSpecError(`rotorcraft ${id}: ${path}: ${msg}`);
  };
  const obj = (v: unknown, path: string): Record<string, unknown> => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'must be an object');
    return v as Record<string, unknown>;
  };
  const num = (o: Record<string, unknown>, k: string, path: string, min = -Infinity): number => {
    const v = o[k];
    if (!isNum(v)) fail(`${path}.${k}`, 'must be a number');
    if ((v as number) < min) fail(`${path}.${k}`, `must be at least ${min}`);
    return v as number;
  };
  const pos = (o: Record<string, unknown>, k: string, path: string): number => {
    const v = num(o, k, path);
    if (!(v > 0)) fail(`${path}.${k}`, 'must be positive');
    return v;
  };
  const vec = (v: unknown, path: string): V3 => {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) fail(path, 'must be [x, y, z]');
    return [...(v as V3)];
  };
  const pair = (v: unknown, path: string, scale = 1): [number, number] => {
    if (!Array.isArray(v) || v.length !== 2 || !v.every(isNum)) fail(path, 'must be [a, b]');
    const p = v as [number, number];
    if (!(p[0] < p[1])) fail(path, 'must rise: [low, high]');
    return [p[0] * scale, p[1] * scale];
  };
  const disc = (o: Record<string, unknown>, path: string): RotorDiscSpec => {
    const dir = o.direction;
    if (dir !== 1 && dir !== -1) fail(`${path}.direction`, 'must be 1 or -1');
    const blades = num(o, 'blades', path, 2);
    if (!Number.isInteger(blades)) fail(`${path}.blades`, 'must be an integer');
    const tipLoss = pos(o, 'tipLoss', path);
    if (tipLoss > 1) fail(`${path}.tipLoss`, 'must be at most 1');
    return {
      at: vec(o.at, `${path}.at`),
      radius: pos(o, 'radius', path),
      blades,
      chord: pos(o, 'chord', path),
      liftSlope: pos(o, 'liftSlope', path),
      cd0: pos(o, 'cd0', path),
      twist: num(o, 'twist', path) * DEG,
      kappa: num(o, 'kappa', path, 1),
      tipLoss,
      speed: pos(o, 'speed', path),
      direction: dir as 1 | -1,
    };
  };

  const r = obj(raw, '');
  if (r.kind !== 'rotorcraft') fail('kind', 'must be "rotorcraft"');
  const mass = obj(r.mass, 'mass');
  const inertia = vec(r.inertia, 'inertia');
  if (!inertia.every((x) => x > 0)) fail('inertia', 'must be positive');

  const m = obj(r.main, 'main');
  const hub = m.hub;
  if (hub !== 'teetering' && hub !== 'articulated' && hub !== 'hingeless')
    fail('main.hub', 'must be teetering, articulated or hingeless');
  const main: MainRotorSpec = {
    ...disc(m, 'main'),
    hub: hub as HubType,
    hubStiffness: num(m, 'hubStiffness', 'main', 0),
    lock: pos(m, 'lock', 'main'),
    shaftTilt: num(m, 'shaftTilt', 'main') * DEG,
    inertia: pos(m, 'inertia', 'main'),
    collective: pair(m.collective, 'main.collective', DEG),
    cyclic: [pos(m, 'cyclicLon', 'main') * DEG, pos(m, 'cyclicLat', 'main') * DEG],
    maxFlap: pos(m, 'maxFlap', 'main') * DEG,
  };
  if (hub === 'teetering' && main.hubStiffness !== 0)
    fail('main.hubStiffness', 'a teetering rotor has none: 0');

  const t = obj(r.tail, 'tail');
  const axis = vec(t.axis, 'tail.axis');
  const al = Math.hypot(...axis);
  if (!(al > 0.5 && al < 1.5)) fail('tail.axis', 'must be a unit vector');
  const tail: TailRotorSpec = {
    ...disc(t, 'tail'),
    axis: [axis[0] / al, axis[1] / al, axis[2] / al],
    pitch: pair(t.pitch, 'tail.pitch', DEG),
  };

  const e = obj(r.engine, 'engine');
  const engine: EngineSpec = {
    power: pos(e, 'power', 'engine'),
    transmission: pos(e, 'transmission', 'engine'),
    lapse: num(e, 'lapse', 'engine', 0),
    hotLoss: num(e, 'hotLoss', 'engine', 0),
    spool: pos(e, 'spool', 'engine'),
    sfc: pos(e, 'sfc', 'engine'),
  };

  const f = obj(r.fuselage, 'fuselage');
  const surface = (v: unknown, path: string): SurfaceSpec => {
    const s = obj(v, path);
    return {
      at: vec(s.at, `${path}.at`),
      area: num(s, 'area', path, 0),
      slope: num(s, 'slope', path, 0),
      incidence: num(s, 'incidence', path) * DEG,
    };
  };
  const drag = vec(f.drag, 'fuselage.drag');
  if (!drag.every((x) => x > 0)) fail('fuselage.drag', 'must be positive');

  const g = obj(r.gear, 'gear');
  if (g.kind !== 'skids' && g.kind !== 'wheels') fail('gear.kind', 'must be skids or wheels');
  if (!Array.isArray(g.points) || g.points.length < 3) fail('gear.points', 'needs 3 or more');
  const points = (g.points as unknown[]).map((p, i): GearPointSpec => {
    const path = `gear.points[${i}]`;
    const q = obj(p, path);
    return {
      at: vec(q.at, `${path}.at`),
      stiffness: pos(q, 'stiffness', path),
      damping: pos(q, 'damping', path),
      travel: pos(q, 'travel', path),
      braked: q.braked === true,
      castor: q.castor === true,
    };
  });
  const tr = obj(g.tire, 'gear.tire');
  const tire: TireSpec = {
    rolling: num(tr, 'rolling', 'gear.tire', 0),
    braking: num(tr, 'braking', 'gear.tire', 0),
    lateral: pos(tr, 'lateral', 'gear.tire'),
    cornering: pos(tr, 'cornering', 'gear.tire'),
    gripStiffness: pos(tr, 'gripStiffness', 'gear.tire'),
    gripDamping: pos(tr, 'gripDamping', 'gear.tire'),
  };
  if (!Array.isArray(r.contacts)) fail('contacts', 'must be a list');
  const contacts = (r.contacts as unknown[]).map((c, i) => vec(c, `contacts[${i}]`));

  const l = obj(r.limits, 'limits');
  const c = obj(r.controls, 'controls');
  const out: RotorcraftSpec = {
    kind: 'rotorcraft',
    mass: {
      empty: pos(mass, 'empty', 'mass'),
      fuel: num(mass, 'fuel', 'mass', 0),
      payload: num(mass, 'payload', 'mass', 0),
    },
    inertia,
    cg: vec(r.cg, 'cg'),
    main,
    tail,
    engine,
    fuselage: {
      drag,
      fin: surface(f.fin, 'fuselage.fin'),
      stabilizer: surface(f.stabilizer, 'fuselage.stabilizer'),
    },
    gear: { kind: g.kind as 'skids' | 'wheels', points, tire },
    contacts,
    limits: {
      vne: pos(l, 'vne', 'limits'),
      crashSink: pos(l, 'crashSink', 'limits'),
      slope: pos(l, 'slope', 'limits') * DEG,
    },
    controls: {
      hoverSpeed: pos(c, 'hoverSpeed', 'controls'),
      turnSpeed: pos(c, 'turnSpeed', 'controls'),
      maxYawRate: pos(c, 'maxYawRate', 'controls') * DEG,
      maxClimbRate: pos(c, 'maxClimbRate', 'controls'),
      maxSideSpeed: pos(c, 'maxSideSpeed', 'controls'),
    },
  };
  if (typeof r.notes === 'string') out.notes = r.notes;
  if (!(out.controls.turnSpeed > out.controls.hoverSpeed))
    fail('controls.turnSpeed', 'must be above hoverSpeed');
  return out;
}

/** A model-frame point of the spec in body axes about its CG. */
export function specToBody(spec: Readonly<RotorcraftSpec>, p: Readonly<V3>): Vec3d {
  return modelToBody(p, spec.cg);
}

/** Main rotor solidity σ = N c / (π R). */
export function solidity(d: Readonly<RotorDiscSpec>): number {
  return (d.blades * d.chord) / (Math.PI * d.radius);
}
