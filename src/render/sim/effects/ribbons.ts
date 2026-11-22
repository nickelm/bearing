/**
 * Contrails and wingtip vortices (Proposal 0011, decision 325): thin ribbons, strips that
 * face the camera along a recorded path, widening and dissolving with age by the puffs'
 * ordered dither.
 *
 * - **Contrails** form above the contrail altitude, where the air is cold enough for an
 *   engine's exhaust to freeze: about −40 °C, from the surface temperature down the standard
 *   lapse rate (`contrailAltitude`). Moist air (more cloud) keeps them longer.
 * - **Wingtip vortices** form above a load factor, lower in humid air (`vortexForms`), and
 *   last a second or two.
 *
 * The owner of a source calls `trail` each frame with each point that trails (an engine, a
 * wingtip) and whether it forms now; the path is recorded every few meters. The strip is
 * built on the CPU each frame, camera-relative (rule 4): there are at most `MAX_POINTS`.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
} from 'three/webgpu';
import type { Group, Node } from 'three/webgpu';
import { attribute, float, Fn, normalWorld, positionWorld, vec3, vec4 } from 'three/tsl';
import { Vec3d } from '../../../core/vec3d';
import type { PlanetLighting } from '../lighting/planetLighting';
import { ditherDiscard } from './debris';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

export const MAX_POINTS = 8192;
/** The standard lapse rate (K/m). */
const LAPSE = 0.0065;
/** The temperature (°C) below which an exhaust trail freezes. */
const CONTRAIL_TEMPERATURE = -40;
/** The load factor above which vortices form in dry air, and in saturated air. */
export const VORTEX_G: readonly [number, number] = [6, 3.5];

/** The contrail altitude (m above sea level) for a surface temperature (°C). */
export function contrailAltitude(surfaceTemperature: number): number {
  return Math.max(4000, (surfaceTemperature - CONTRAIL_TEMPERATURE) / LAPSE);
}

/** Whether a contrail forms at an altitude (m) over a surface temperature (°C). */
export function contrailForms(altitude: number, surfaceTemperature: number): boolean {
  return altitude >= contrailAltitude(surfaceTemperature);
}

/** Whether wingtip vortices form at a load factor in air of a humidity 0..1. */
export function vortexForms(loadFactor: number, humidity: number): boolean {
  const h = Math.min(1, Math.max(0, humidity));
  return loadFactor >= VORTEX_G[0] + (VORTEX_G[1] - VORTEX_G[0]) * h;
}

export type RibbonKind = 'contrail' | 'vortex';

const LOOK: Readonly<
  Record<
    RibbonKind,
    { life: number; width: readonly [number, number]; step: number; albedo: number }
  >
> = {
  contrail: { life: 45, width: [1.2, 14], step: 12, albedo: 0.9 },
  vortex: { life: 1.6, width: [0.25, 0.8], step: 3, albedo: 0.95 },
};

interface Point {
  pos: Vec3d;
  born: number;
}

interface Ribbon {
  kind: RibbonKind;
  points: Point[];
  /** The ribbon's current run ended (it stopped forming); the next point starts a new one. */
  broken: boolean;
  touched: number;
  /** Life of its points (s): a contrail in moist air lasts longer. */
  life: number;
  /** Where the source is now, between recorded points. */
  head: Point | null;
}

export class Ribbons {
  private readonly ribbons = new Map<string, Ribbon>();
  private readonly geometry = new BufferGeometry();
  private readonly mesh: Mesh;
  private readonly position = new BufferAttribute(new Float32Array(MAX_POINTS * 2 * 3), 3);
  private readonly fade = new BufferAttribute(new Float32Array(MAX_POINTS * 2), 1);
  private readonly shade = new BufferAttribute(new Float32Array(MAX_POINTS * 2), 1);
  private readonly index = new BufferAttribute(new Uint32Array(MAX_POINTS * 6), 1);
  /** Points drawn last frame. */
  points = 0;

  constructor(
    private readonly group: Group,
    lighting: PlanetLighting,
  ) {
    this.geometry.setAttribute('position', this.position);
    this.geometry.setAttribute('ribbonFade', this.fade);
    this.geometry.setAttribute('ribbonShade', this.shade);
    this.geometry.setIndex(this.index);
    this.geometry.setDrawRange(0, 0);
    const m = new MeshBasicNodeMaterial({ side: DoubleSide });
    m.name = 'ribbons';
    m.colorNode = Fn(() => {
      ditherDiscard(attribute('ribbonFade', 'float') as F, float(0.2));
      const albedo = vec3(attribute('ribbonShade', 'float') as F);
      // Lit as a surface facing the sun half way: flat, a little brighter on the sun's side.
      return vec4(
        lighting
          .shadeDiffuse(albedo, lighting.sunDirection as unknown as V3, positionWorld as V3)
          .mul(0.8)
          .add(lighting.shadeDiffuse(albedo, normalWorld as V3, positionWorld as V3).mul(0.2)),
        1,
      );
    })();
    this.mesh = new Mesh(this.geometry, m);
    this.mesh.name = 'ribbons';
    this.mesh.frustumCulled = false;
    group.add(this.mesh);
  }

  /**
   * A trailing point at `pos` (world) at effect time `now`; `forms` whether it leaves a
   * trail now. `humidity` 0..1 lengthens a contrail's life.
   */
  trail(
    key: string,
    kind: RibbonKind,
    pos: Readonly<Vec3d>,
    forms: boolean,
    now: number,
    humidity = 0.3,
  ): void {
    let r = this.ribbons.get(key);
    if (!r) {
      r = { kind, points: [], broken: true, touched: now, life: LOOK[kind].life, head: null };
      this.ribbons.set(key, r);
    }
    r.touched = now;
    r.life =
      LOOK[kind].life * (kind === 'contrail' ? 0.4 + 1.2 * Math.min(1, Math.max(0, humidity)) : 1);
    if (!forms) {
      r.broken = true;
      r.head = null;
      return;
    }
    const last = r.points[r.points.length - 1];
    if (r.broken || !last || last.pos.distanceTo(pos) >= LOOK[kind].step) {
      // A run starts with a joint (a point of no coverage) at the old run's end, so no strip
      // joins the two runs.
      if (r.broken && last) r.points.push({ pos: last.pos.clone(), born: Number.NaN });
      if (r.broken && last) r.points.push({ pos: pos.clone(), born: Number.NaN });
      r.points.push({ pos: pos.clone(), born: now });
      r.broken = false;
      r.head = null;
    } else r.head = { pos: pos.clone(), born: now };
  }

  /** Builds the strips for the frame; `pixel` is the view's radians per pixel. */
  update(now: number, eye: Readonly<Vec3d>, pixel = 0.0012): void {
    let v = 0;
    let n = 0;
    const P = this.position.array as Float32Array;
    const A = this.fade.array as Float32Array;
    const S = this.shade.array as Float32Array;
    const I = this.index.array as Uint32Array;
    const c = new Vec3d();
    const t = new Vec3d();
    const side = new Vec3d();
    for (const [key, r] of this.ribbons) {
      const look = LOOK[r.kind];
      // Points older than their life go; a ribbon whose source left and that is empty goes.
      while (r.points.length > 0 && !(now - r.points[0]!.born <= r.life)) r.points.shift();
      if (r.points.length === 0 && now - r.touched > 1) {
        this.ribbons.delete(key);
        continue;
      }
      const pts = r.head ? [...r.points, r.head] : r.points;
      for (let i = 0; i < pts.length && v < MAX_POINTS; i++) {
        const p = pts[i]!;
        const joint = Number.isNaN(p.born);
        const k = joint ? 1 : Math.min(1, Math.max(0, now - p.born) / r.life);
        c.copy(p.pos).sub(eye);
        // Never thinner than a pixel and a half: a far contrail is a line, not a dotted one.
        const width = Math.max(
          look.width[0] + (look.width[1] - look.width[0]) * Math.sqrt(k),
          c.length() * pixel * 1.5,
        );
        const a = pts[Math.max(0, i - 1)]!.pos;
        const b = pts[Math.min(pts.length - 1, i + 1)]!.pos;
        t.copy(b).sub(a);
        side.copy(t).cross(c);
        const len = side.length();
        if (len > 1e-9) side.scale(width / 2 / len);
        else side.set(0, 0, 0);
        P.set(
          [c.x + side.x, c.y + side.y, c.z + side.z, c.x - side.x, c.y - side.y, c.z - side.z],
          v * 6,
        );
        // Dissolves over its last two thirds; a run's joint has none.
        const f = joint ? 0 : Math.min(1, (1 - k) * 1.5);
        A[v * 2] = A[v * 2 + 1] = f;
        S[v * 2] = S[v * 2 + 1] = look.albedo;
        if (i > 0) {
          const o = (v - 1) * 2;
          I.set([o, o + 1, o + 2, o + 2, o + 1, o + 3], n);
          n += 6;
        }
        v++;
      }
    }
    this.points = v;
    this.position.needsUpdate = true;
    this.fade.needsUpdate = true;
    this.shade.needsUpdate = true;
    this.index.needsUpdate = true;
    this.geometry.setDrawRange(0, n);
    this.mesh.visible = n > 0;
  }

  clear(): void {
    this.ribbons.clear();
    this.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.group.remove(this.mesh);
    this.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
  }
}
