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
 *
 * - **Shape** (decision 332). A contrail condenses some way behind the engine: it shows
 *   from `form` seconds of age, never at the nozzle. Its width varies point to point, so the
 *   trail is lumpy, and it never spans more than about 1.4° from the camera, and dissolves
 *   within `near` of the lens: a chase camera sitting on the trail never sees it as a wall.
 * - **Shading.** The strip is shaded as the tube it stands for: across its width the normal
 *   turns from the side through the camera to the other side, lit in the puffs' three bands
 *   with their rim; only its age and the lens dissolve it, never its edges.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
} from 'three/webgpu';
import type { Group, Node } from 'three/webgpu';
import {
  abs,
  attribute,
  dot,
  float,
  Fn,
  max,
  mix,
  normalize,
  positionWorld,
  smoothstep,
  sqrt,
  vec3,
  vec4,
} from 'three/tsl';
import { Vec3d } from '../../../core/vec3d';
import type { PlanetLighting } from '../lighting/planetLighting';
import { ditherDiscard } from './debris';
import { TOON_BANDS, TOON_EDGES } from './puffMaterial';

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

interface RibbonLook {
  /** Seconds a point lasts. */
  life: number;
  /** Width (m) when it forms and at the end of its life. */
  width: readonly [number, number];
  /** Meters between recorded points. */
  step: number;
  albedo: number;
  /** Age (s) at which it starts to show and is fully formed. */
  form: readonly [number, number];
  /** Distance (m) from the camera within which it dissolves, and beyond which it is whole. */
  near: readonly [number, number];
}

const LOOK: Readonly<Record<RibbonKind, RibbonLook>> = {
  contrail: {
    life: 45,
    width: [1.6, 10],
    step: 12,
    albedo: 0.9,
    form: [0.15, 0.4],
    near: [15, 60],
  },
  vortex: { life: 1.6, width: [0.2, 0.6], step: 3, albedo: 0.95, form: [0, 0.05], near: [4, 15] },
};
/** The widest a ribbon is drawn, as a share of its distance (about 1.4°). */
const MAX_ANGULAR_WIDTH = 0.025;
/** Point-to-point variation of the width, ±. */
const LUMPS = 0.3;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** A fixed hash 0..1 of a number. */
const hash01 = (x: number) => {
  const h = Math.sin(x * 12.9898 + 78.233) * 43758.5453;
  return h - Math.floor(h);
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
  /**
   * Per vertex: coverage, albedo, and −1 or +1 at the strip's two edges (the shader turns it
   * into the tube's normal). One attribute: three separate single floats beside a vec3 came
   * through with the coverage wrong.
   */
  private readonly data = new BufferAttribute(new Float32Array(MAX_POINTS * 2 * 3), 3);
  /** The strip's unit side direction at each point. */
  private readonly sideDir = new BufferAttribute(new Float32Array(MAX_POINTS * 2 * 3), 3);
  private readonly index = new BufferAttribute(new Uint32Array(MAX_POINTS * 6), 1);
  /** Points drawn last frame. */
  points = 0;

  constructor(
    private readonly group: Group,
    lighting: PlanetLighting,
  ) {
    this.geometry.setAttribute('position', this.position);
    this.geometry.setAttribute('ribbonData', this.data);
    this.geometry.setAttribute('ribbonSide', this.sideDir);
    this.geometry.setIndex(this.index);
    this.geometry.setDrawRange(0, 0);
    const m = new MeshBasicNodeMaterial({ side: DoubleSide });
    m.name = 'ribbons';
    const L = lighting;
    m.colorNode = Fn(() => {
      const d = attribute('ribbonData', 'vec3') as V3;
      const a = d.z as F;
      // Only age and the lens dissolve it: a thin strip's dithered edges read as noise.
      ditherDiscard(d.x as F, float(0.2));
      const albedo = vec3(d.y as F);
      // The tube's normal: from the side, through the camera, to the other side.
      const toCamera = normalize(positionWorld.negate());
      const side = normalize(attribute('ribbonSide', 'vec3') as V3);
      const n = normalize(side.mul(a).add(toCamera.mul(sqrt(max(float(1).sub(a.mul(a)), 0)))));
      const at = L.at(positionWorld as V3);
      const ndl = dot(n, L.sunDirection);
      const w = 0.05;
      const band = mix(
        mix(
          float(TOON_BANDS[0]),
          float(TOON_BANDS[1]),
          smoothstep(TOON_EDGES[0] - w, TOON_EDGES[0] + w, ndl),
        ),
        float(TOON_BANDS[2]),
        smoothstep(TOON_EDGES[1] - w, TOON_EDGES[1] + w, ndl),
      );
      // A thin tube scatters light all round: its shadow side stays lighter than a puff's.
      const light = at.sunlight
        .mul(band.mul(0.7).add(0.3))
        .add(at.sky)
        .add(at.moonlight.mul(0.5))
        .add(at.moonSky);
      const rim = smoothstep(0.75, 0.95, abs(a)).mul(0.3);
      return vec4(albedo.mul(light.add(at.sky.mul(rim))), 1);
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
    const DATA = this.data.array as Float32Array;
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
        const age = joint ? r.life : Math.max(0, now - p.born);
        const k = Math.min(1, age / r.life);
        c.copy(p.pos).sub(eye);
        const dist = c.length();
        // Lumpy, never thinner than a pixel and a half (a far contrail is a line, not a dotted
        // one) and never wider than MAX_ANGULAR_WIDTH of its distance.
        const lump = 1 + LUMPS * (2 * hash01(joint ? i : p.born * 7.31) - 1);
        const width = Math.min(
          Math.max(
            (look.width[0] + (look.width[1] - look.width[0]) * Math.sqrt(k)) * lump,
            dist * pixel * 1.5,
          ),
          Math.max(dist * MAX_ANGULAR_WIDTH, dist * pixel * 1.5),
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
        // Forms behind its source, dissolves near the lens and over its last two thirds; a
        // run's joint has none.
        const f = joint
          ? 0
          : Math.min(1, (1 - k) * 1.5) *
            smooth(look.form[0], look.form[1], age) *
            smooth(look.near[0], look.near[1], dist);
        DATA.set([f, look.albedo, 1, f, look.albedo, -1], v * 6);
        const D = this.sideDir.array as Float32Array;
        const sl = side.length() || 1;
        D.set(
          [side.x / sl, side.y / sl, side.z / sl, side.x / sl, side.y / sl, side.z / sl],
          v * 6,
        );
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
    this.data.needsUpdate = true;
    this.sideDir.needsUpdate = true;
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
