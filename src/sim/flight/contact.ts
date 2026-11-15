/**
 * Ground contact shared by every airframe (track H, decision 154): the ground
 * query, the points an aircraft stands on, the wheel's strut and tire, hard
 * points that crash it, and the height of its lowest support. Skids join as a
 * sibling of `wheelForce` built from the same strut and bristle code.
 *
 * - **Strut.** A spring-damper along the local vertical, with a stiff stop past
 *   its travel.
 * - **Tire.** A grip spring per tire, capped by friction (a bristle model): braked
 *   or sideways it sticks until the friction limit and then slides, so a braked
 *   aircraft rests without creeping. At speed the lateral force follows the slip
 *   angle; unbraked wheels roll against rolling resistance (decision 136).
 *
 * Bit-identity with the model before the split (tests/flightLockstep.test.ts):
 * the code is `FlightModel`'s, moved with `this` replaced by the body `b`.
 */
import type { Quatd } from '../../core/quat';
import { Vec3d } from '../../core/vec3d';
import { pointVelocity } from './rigidBody';

export type SurfaceKind = 'runway' | 'field' | 'land' | 'water';

/** The ground the aircraft flies over: the same surface the renderer draws. */
export interface GroundQuery {
  /** Surface height (m above sea level; water at its surface) at a unit direction. */
  height(dir: Readonly<Vec3d>): number;
  /** What the surface is at a unit direction. */
  surface(dir: Readonly<Vec3d>): SurfaceKind;
}

/** The body a contact acts on. */
export interface ContactBody {
  readonly radius: number;
  readonly pos: Readonly<Vec3d>;
  readonly vel: Readonly<Vec3d>;
  readonly q: Readonly<Quatd>;
  readonly omega: Readonly<Vec3d>;
}

/** A point the aircraft stands on: a wheel, later a point on a skid. */
export interface ContactState {
  /** Attachment (tire bottom or skid, strut extended) relative to the CG, body axes. */
  readonly body: Vec3d;
  /** Strut compression (m) and normal load (N). */
  compression: number;
  load: number;
  /** The grip spring's anchor on the ground (world), or null in the air. */
  anchor: Vec3d | null;
  /** Surface under the point while it is loaded. */
  surface: SurfaceKind | null;
}

/** A strut: spring and damper along the local vertical, and its travel. */
export interface StrutSpec {
  /** N/m, N·s/m, m. */
  stiffness: number;
  damping: number;
  travel: number;
}

/** A tire's friction, and the grip spring that holds it to the ground. */
export interface TireSpec {
  /** Rolling, braking and lateral friction coefficients. */
  rolling: number;
  braking: number;
  lateral: number;
  /** Lateral force per radian of slip angle, per newton of load. */
  cornering: number;
  /** Grip spring (N/m) and damping (N·s/m). */
  gripStiffness: number;
  gripDamping: number;
}

/** A wheel's contact: the point, and the angle it is steered to (rad, + right). */
export interface WheelContact extends ContactState {
  steer: number;
}

/** What `wheelForce` returns when the point is on water: no state was written. */
export const ON_WATER = -1;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function smooth01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/** A point in the air: no load and no grip. */
export function release(c: ContactState): void {
  c.load = 0;
  c.anchor = null;
  c.surface = null;
}

/**
 * One wheel's force on body `b`: the strut's normal force along the local
 * vertical `up`, grip and rolling resistance in the ground plane, with `brake`
 * 0..1 on this wheel. Adds the world force to `fw` and the body moment to `mb`;
 * returns the normal load (N), or ON_WATER with nothing written when the tire is
 * in the water (the caller crashes the aircraft).
 */
export function wheelForce(
  b: ContactBody,
  w: WheelContact,
  strut: Readonly<StrutSpec>,
  tire: Readonly<TireSpec>,
  brake: number,
  ground: GroundQuery,
  up: Readonly<Vec3d>,
  fw: Vec3d,
  mb: Vec3d,
): number {
  const arm = b.q.rotate(w.body, new Vec3d());
  const P = arm.clone().add(b.pos);
  const dir = P.clone().normalize();
  const groundH = ground.height(dir);
  const depth = groundH - (P.length() - b.radius);
  if (depth <= 0) {
    w.load = 0;
    w.compression = 0;
    w.anchor = null;
    w.surface = null;
    return 0;
  }
  const surface = ground.surface(dir);
  if (surface === 'water') return ON_WATER;
  w.surface = surface;
  // Velocity of the tire: v + ω × r (ω in body → world).
  const vP = pointVelocity(b, arm);
  const sinkRate = -vP.dot(up);
  let n = strut.stiffness * depth + strut.damping * sinkRate;
  if (depth > strut.travel) n += 20 * strut.stiffness * (depth - strut.travel);
  n = Math.max(0, n);
  w.compression = Math.min(depth, strut.travel);
  w.load = n;
  const contact = P.addScaled(up, depth);
  // Rolling direction: the body's x axis turned by the steering angle, in the ground plane.
  const fBody = new Vec3d(Math.cos(w.steer), Math.sin(w.steer), 0);
  const f = b.q.rotate(fBody, new Vec3d());
  f.addScaled(up, -f.dot(up)).normalize();
  const l = f.clone().cross(up).normalize();
  const vf = vP.dot(f);
  const vl = vP.dot(l);
  if (!w.anchor) w.anchor = contact.clone();
  const d = contact.clone().sub(w.anchor);
  let df = d.dot(f);
  let dl = d.dot(l);
  const k = tire.gripStiffness;
  const c = tire.gripDamping;
  // Lateral grip: the grip spring at rest and taxi speeds (no creep), and at speed
  // a tire's cornering force from its slip angle (cornering · load per radian),
  // both capped by friction. The spring's damping alone acted like a cornering
  // stiffness some thirty times a tire's at takeoff speed, so any heading change
  // saturated the tires and could roll the jet onto a wingtip (decision 136).
  const capL = tire.lateral * n;
  dl = clamp(dl, -capL / k, capL / k);
  const spring = clamp(-k * dl - c * vl, -capL, capL);
  const slip = Math.atan2(vl, Math.abs(vf));
  const corner = clamp(-tire.cornering * n * slip, -capL, capL);
  const atSpeed = smooth01((Math.abs(vf) - 2) / 4);
  const Fl = spring * (1 - atSpeed) + corner * atSpeed;
  if (atSpeed > 0) dl *= 1 - atSpeed;
  // Rolling: braked wheels grip up to their braking friction; free wheels roll.
  let Ff: number;
  if (brake > 0) {
    const capF = (tire.rolling + tire.braking * brake) * n;
    df = clamp(df, -capF / k, capF / k);
    Ff = clamp(-k * df - c * vf, -capF, capF);
  } else {
    Ff = -tire.rolling * n * Math.tanh(vf / 0.2);
    df = 0;
  }
  w.anchor.copy(contact).addScaled(f, -df).addScaled(l, -dl);
  const F = up.clone().scale(n).addScaled(f, Ff).addScaled(l, Fl);
  fw.add(F);
  // Moment about the CG in body axes: r × F with r from the CG to the contact.
  const rc = contact.sub(b.pos);
  const Mw = rc.cross(F);
  mb.add(b.q.unrotate(Mw, new Vec3d()));
  return n;
}

/**
 * The first of the hard points `points` (body axes, from the CG) that is below
 * the ground, with the surface there, or null.
 */
export function hardPointHit(
  b: ContactBody,
  points: readonly Readonly<Vec3d>[],
  ground: GroundQuery,
): { index: number; surface: SurfaceKind } | null {
  const tmp = new Vec3d();
  for (let i = 0; i < points.length; i++) {
    const P = b.q.rotate(points[i]!, tmp).add(b.pos);
    const dir = P.clone().normalize();
    if (P.length() - b.radius < ground.height(dir))
      return { index: i, surface: ground.surface(dir) };
  }
  return null;
}

/** Height of the CG above the lowest of `points` (attachments, body axes) at the current attitude (m). */
export function supportHeight(b: ContactBody, points: readonly ContactState[]): number {
  const up = b.pos.clone().normalize();
  let h = 0;
  const tmp = new Vec3d();
  for (const w of points) h = Math.max(h, -b.q.rotate(w.body, tmp).dot(up));
  return h;
}
