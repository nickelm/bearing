/**
 * Model specifications (visual-style Part I, Procedural Model Builders; decision 106):
 * small JSON documents that the builder (builder.ts) turns into flat-shaded meshes.
 *
 * Frame: meters, +x forward (the nose), +y up, +z to starboard (right), the model's
 * origin on the ground or at its reference point. Every part names a color group; the
 * spec's `groups` map gives each group a color: a hex string, a named model color
 * (palettes.ts MODEL_COLORS), or "camo" for the spec's camouflage scheme. A group not
 * in `groups` that is itself a model color name (e.g. "canopy") takes that color.
 *
 * Parts:
 * - `loft`: a fuselage or hull lofted through cross-sections (`stations`) along x,
 *   each an ellipse-like ring of `sides` (4–8) points with half width `w` and half
 *   height `h` about (y, z); `square` (0..1) squares the ring off. A station with
 *   w = h = 0 is a point (a nose tip). Open ends get a flat cap.
 * - `wing`: an extruded planform: leading edge at `root`, chords at root and tip,
 *   `span` outward (+z, or +y when `vertical`), leading-edge `sweep` and `dihedral`
 *   (or cant) in degrees, a thin diamond section `thickness` × chord deep with a sharp
 *   leading edge. Wings are usually mirrored.
 * - `box`: a box at `center` of `size` [x, y, z], optionally `bevel`ed along its top
 *   edges and turned by `yaw` (deg).
 * - `frustum`: a four-sided frustum (pyramid when the top is 0) standing on `center`.
 * - `cylinder`: from `from` to `to`, radius `radius` (and `radius2` at `to`), `sides`.
 * - `blob`: an icosphere (detail 0 or 1) at `center` with radii [x, y, z]; `half` keeps
 *   the upper half (a dome).
 * - `arch`: an arched shell along x (hangars, shelters): `length`, `width`, `height`,
 *   `sides` around the arch; a closed back wall and a front wall in group `door`.
 * - `house`: a box with a gable roof (`roof` m high, ridge along x), walls in `group`
 *   and roof in `roofGroup`.
 * - `mast`: a lattice mast of four legs and X braces, `height` tall, `base` and `top`
 *   widths.
 *
 * Any part may set `mirror: true` to add its reflection across z = 0, and `yaw` (deg)
 * to turn it about the y axis through `center` (box, frustum, house, arch). Parts of
 * the controlled aircraft may set `anim` to turn about a hinge (decision 134).
 */
import { EMISSIVE_COLORS, MODEL_COLORS, SCHEMES } from './palettes';

export type Vec3 = [number, number, number];

/** Model classes and their triangle budgets (Part I, Polygon Budgets). */
export const MODEL_BUDGETS = {
  fighter: [300, 800],
  strike: [300, 800],
  bomber: [600, 1500],
  helicopter: [300, 800],
  tank: [150, 400],
  truck: [80, 200],
  person: [60, 150],
  building: [12, 200],
  carrier: [2000, 5000],
  ship: [400, 2000],
} as const satisfies Record<string, readonly [number, number]>;
export type ModelClass = keyof typeof MODEL_BUDGETS;

export interface Station {
  x: number;
  /** Center height (default 0). */
  y?: number;
  /** Half width and half height (m). */
  w: number;
  h: number;
  /** 0: elliptical, 1: square (default 0). */
  square?: number;
}

/**
 * Animation channels of the controlled aircraft's parts (decision 134), driven by
 * the flight model: control surfaces by the control laws' deflections, the gear
 * and speedbrake by their positions.
 */
export const ANIM_CHANNELS = ['stabilator', 'flaperon', 'rudder', 'speedbrake', 'gear'] as const;
export type AnimChannel = (typeof ANIM_CHANNELS)[number];

/**
 * A part that turns about a hinge: the axis from `hinge[0]` to `hinge[1]` (model
 * frame), by up to `angle` degrees (right-handed about the axis). A mirrored part
 * turns about the mirrored axis, symmetrically (the gear folds both legs inward;
 * differential channels such as roll take the side into account).
 */
export interface PartAnim {
  channel: AnimChannel;
  hinge: [Vec3, Vec3];
  angle: number;
}

interface PartBase {
  group: string;
  mirror?: boolean;
  anim?: PartAnim;
}

export type PartSpec =
  | (PartBase & { type: 'loft'; sides: number; stations: Station[] })
  | (PartBase & {
      type: 'wing';
      root: Vec3;
      rootChord: number;
      tipChord: number;
      span: number;
      sweep: number;
      dihedral?: number;
      thickness?: number;
      vertical?: boolean;
    })
  | (PartBase & { type: 'box'; center: Vec3; size: Vec3; bevel?: number; yaw?: number })
  | (PartBase & {
      type: 'frustum';
      center: Vec3;
      base: [number, number];
      top: [number, number];
      height: number;
      yaw?: number;
    })
  | (PartBase & {
      type: 'cylinder';
      from: Vec3;
      to: Vec3;
      radius: number;
      radius2?: number;
      sides: number;
      caps?: boolean;
    })
  | (PartBase & { type: 'blob'; center: Vec3; radius: Vec3; detail?: number; half?: boolean })
  | (PartBase & {
      type: 'arch';
      center: Vec3;
      length: number;
      width: number;
      height: number;
      sides: number;
      yaw?: number;
    })
  | (PartBase & {
      type: 'house';
      center: Vec3;
      size: Vec3;
      roof: number;
      roofGroup: string;
      yaw?: number;
    })
  | (PartBase & { type: 'mast'; center: Vec3; height: number; base: number; top: number });

export type PartType = PartSpec['type'];

export interface EmissiveSpec {
  kind: keyof typeof EMISSIVE_COLORS;
  at: Vec3;
  /** Also at the mirror image across z = 0 (same kind). */
  mirror?: boolean;
}

export interface ModelSpec {
  /** Identifier (file name without .json). */
  id: string;
  /** Display name, e.g. "F-21 Kestrel". */
  name: string;
  class: ModelClass;
  /** Default camouflage scheme (palettes.ts SCHEMES) for `camo` groups. */
  scheme?: string;
  /** Color per group: hex, a MODEL_COLORS name, or "camo". */
  groups: Record<string, string>;
  parts: PartSpec[];
  emissives?: EmissiveSpec[];
  /** Darken faces near y = 0 (models standing on the ground). Default true for buildings. */
  ground?: boolean;
  /**
   * Flight-model tables (decision 134), checked by sim/flight/flightSpec.ts's
   * parseFlightSpec; the builder ignores them.
   */
  flight?: unknown;
}

export class ModelSpecError extends Error {}

const FIELDS: Record<
  PartType,
  Record<string, 'number' | 'vec3' | 'vec2' | 'string' | 'stations'>
> = {
  loft: { sides: 'number', stations: 'stations' },
  wing: {
    root: 'vec3',
    rootChord: 'number',
    tipChord: 'number',
    span: 'number',
    sweep: 'number',
  },
  box: { center: 'vec3', size: 'vec3' },
  frustum: { center: 'vec3', base: 'vec2', top: 'vec2', height: 'number' },
  cylinder: { from: 'vec3', to: 'vec3', radius: 'number', sides: 'number' },
  blob: { center: 'vec3', radius: 'vec3' },
  arch: { center: 'vec3', length: 'number', width: 'number', height: 'number', sides: 'number' },
  house: { center: 'vec3', size: 'vec3', roof: 'number', roofGroup: 'string' },
  mast: { center: 'vec3', height: 'number', base: 'number', top: 'number' },
};

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (v: unknown, n: number) =>
  Array.isArray(v) && v.length === n && v.every((x) => isNum(x));

/** Checks a parsed spec and returns it typed; throws ModelSpecError naming the first problem. */
export function validateSpec(raw: unknown, id = '?'): ModelSpec {
  const fail = (path: string, msg: string): never => {
    throw new ModelSpecError(`model ${id}: ${path}: ${msg}`);
  };
  if (typeof raw !== 'object' || raw === null) fail('', 'not an object');
  const s = raw as Record<string, unknown>;
  if (typeof s.name !== 'string' || !s.name) fail('name', 'missing');
  if (typeof s.class !== 'string' || !(s.class in MODEL_BUDGETS))
    fail('class', `must be one of ${Object.keys(MODEL_BUDGETS).join(', ')}`);
  if (s.scheme !== undefined && (typeof s.scheme !== 'string' || !(s.scheme in SCHEMES)))
    fail('scheme', `unknown scheme "${String(s.scheme)}"`);
  if (typeof s.groups !== 'object' || s.groups === null) fail('groups', 'missing');
  const groups = s.groups as Record<string, unknown>;
  for (const [g, c] of Object.entries(groups)) {
    if (typeof c !== 'string') fail(`groups.${g}`, 'must be a string');
    const color = c as string;
    if (color === 'camo') {
      if (!s.scheme) fail(`groups.${g}`, '"camo" needs a scheme');
    } else if (!/^#[0-9a-fA-F]{6}$/.test(color) && !(color in MODEL_COLORS)) {
      fail(`groups.${g}`, `unknown color "${color}"`);
    }
  }
  if (!Array.isArray(s.parts) || s.parts.length === 0) fail('parts', 'must be a non-empty list');
  (s.parts as unknown[]).forEach((p, i) => {
    const path = `parts[${i}]`;
    if (typeof p !== 'object' || p === null) fail(path, 'not an object');
    const part = p as Record<string, unknown>;
    const type = part.type as PartType;
    const fields = FIELDS[type];
    if (!fields) fail(`${path}.type`, `unknown part type "${String(part.type)}"`);
    const known = (g: unknown) => typeof g === 'string' && (g in groups || g in MODEL_COLORS);
    if (!known(part.group))
      fail(`${path}.group`, `group "${String(part.group)}" has no color in groups`);
    for (const [k, kind] of Object.entries(fields)) {
      const v = part[k];
      const ok =
        kind === 'number'
          ? isNum(v)
          : kind === 'vec3'
            ? isVec(v, 3)
            : kind === 'vec2'
              ? isVec(v, 2)
              : kind === 'string'
                ? typeof v === 'string'
                : Array.isArray(v) && v.length >= 2;
      if (!ok)
        fail(
          `${path}.${k}`,
          `missing or not a ${kind === 'stations' ? 'list of 2+ stations' : kind}`,
        );
    }
    if (type === 'house' && !known(part.roofGroup))
      fail(`${path}.roofGroup`, `group "${String(part.roofGroup)}" has no color in groups`);
    if (
      (type === 'loft' || type === 'cylinder' || type === 'arch') &&
      !(isNum(part.sides) && part.sides >= 3 && part.sides <= 16)
    )
      fail(`${path}.sides`, 'must be 3–16');
    if (type === 'loft') {
      (part.stations as unknown[]).forEach((st, j) => {
        const q = st as Record<string, unknown>;
        if (!isNum(q.x) || !isNum(q.w) || !isNum(q.h) || (q.w as number) < 0 || (q.h as number) < 0)
          fail(`${path}.stations[${j}]`, 'needs x, w ≥ 0 and h ≥ 0');
      });
    }
    if (part.anim !== undefined) {
      const a = part.anim as Record<string, unknown>;
      if (!(ANIM_CHANNELS as readonly string[]).includes(a.channel as string))
        fail(`${path}.anim.channel`, `must be one of ${ANIM_CHANNELS.join(', ')}`);
      const h = a.hinge as unknown[];
      if (!Array.isArray(h) || h.length !== 2 || !isVec(h[0], 3) || !isVec(h[1], 3))
        fail(`${path}.anim.hinge`, 'must be two points [[x, y, z], [x, y, z]]');
      if (!isNum(a.angle)) fail(`${path}.anim.angle`, 'must be a number (degrees)');
    }
    for (const k of ['size', 'radius'] as const) {
      const v = part[k];
      if (Array.isArray(v) && v.some((x) => !(x > 0))) fail(`${path}.${k}`, 'must be positive');
    }
    for (const k of ['length', 'width', 'height', 'span', 'rootChord'] as const) {
      if (part[k] !== undefined && !((part[k] as number) > 0))
        fail(`${path}.${k}`, 'must be positive');
    }
  });
  if (s.emissives !== undefined) {
    if (!Array.isArray(s.emissives)) fail('emissives', 'must be a list');
    (s.emissives as unknown[]).forEach((e, i) => {
      const q = e as Record<string, unknown>;
      if (typeof q.kind !== 'string' || !(q.kind in EMISSIVE_COLORS))
        fail(`emissives[${i}].kind`, `unknown kind "${String(q.kind)}"`);
      if (!isVec(q.at, 3)) fail(`emissives[${i}].at`, 'must be [x, y, z]');
    });
  }
  return { ...(s as unknown as ModelSpec), id };
}
