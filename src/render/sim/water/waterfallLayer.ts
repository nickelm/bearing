/**
 * Waterfalls in the simulation view (Proposal 0010, *Water*; decision 301): the falls
 * that `worldgen/waterfalls.ts` finds on the terrain world's rivers, each drawn as
 *
 * - a **sheet**: a strip from the lip to the foot, the river's width (a little wider
 *   below), arcing out over the drop as water leaving a ledge does, with bands of white
 *   water that scroll down it, flat-shaded and stepped like the rest of the world;
 * - a **foam pool**: a flat, eight-sided disc of white water at the foot;
 * - a **mist puff**: three crossed, soft quads over the pool. A placeholder for the
 *   effects system of Proposal 0011, which is not in the repository yet.
 *
 * Only falls within `range` of the eye are built, on the CPU into one mesh for the
 * sheets and pools and one for the mist, relative to an anchor at the eye (rule 4),
 * and rebuilt when the eye has moved a few hundred meters or the world changed.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  attribute,
  float,
  fract,
  Fn,
  mix,
  modelWorldMatrix,
  normalize,
  positionLocal,
  positionWorld,
  smoothstep,
  step,
  time,
  uniform,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl';
import { placeCameraRelative } from '../../common/cameraRelative';
import { Vec3d } from '../../../core/vec3d';
import { findWaterfalls } from '../../../worldgen/waterfalls';
import type { Waterfall } from '../../../worldgen/waterfalls';
import type { PlanetLighting } from '../lighting/planetLighting';
import type { TerrainRenderer } from '../terrain/terrainRenderer';

type V3 = Node<'vec3'>;

/** Rows along a sheet, from the lip to the foot. */
const ROWS = 10;
/** Sides of a foam pool. */
const POOL_SIDES = 8;

export class WaterfallLayer {
  readonly group = new Group();
  /** Falls drawn (the art settings' `waterfalls`). */
  enabled = true;
  /** Falls within this distance of the eye are drawn (m). */
  range = 9000;
  /** The world's falls, found once per terrain world. */
  falls: Waterfall[] = [];
  readonly stats = { falls: 0, drawn: 0, triangles: 0 };

  private readonly sheet: Mesh;
  private readonly mist: Mesh;
  private readonly anchor = new Vec3d();
  private builtAt: Vec3d | null = null;
  private lastWorld: unknown = null;
  /** The mist's strength (0 hides it). */
  readonly mistStrength = uniform(1);

  constructor(
    private readonly terrain: TerrainRenderer,
    private readonly lighting: PlanetLighting,
  ) {
    this.sheet = new Mesh(new BufferGeometry(), this.sheetMaterial());
    this.mist = new Mesh(new BufferGeometry(), this.mistMaterial());
    for (const m of [this.sheet, this.mist]) {
      m.frustumCulled = false;
      this.group.add(m);
    }
    this.mist.renderOrder = 2;
  }

  /** White water bands scroll down the sheet; the pool is white; lit by the planet's light. */
  private sheetMaterial(): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ side: DoubleSide });
    const L = this.lighting;
    // x: meters down the sheet; y: 0 on the sheet, 1 in the pool; z: the drop's speed (m/s).
    const flow = attribute('flow', 'vec3');
    const apIn = varyingProperty('vec3', 'vFallInscatter');
    const apT = varyingProperty('vec3', 'vFallTransmittance');
    m.positionNode = Fn(() => {
      const ap = L.atmosphere.aerialPerspective(
        modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz as V3,
        3,
      );
      apIn.assign(ap.inscatter);
      apT.assign(ap.transmittance);
      return positionLocal;
    })();
    const band = fract(flow.x.div(7).sub(time.mul(flow.z).div(7)));
    // Three stepped tones: blue-green water, pale streaks, white foam (no smooth gradient).
    const water = vec3(0.32, 0.46, 0.5);
    const streak = vec3(0.62, 0.72, 0.76);
    const white = vec3(0.86, 0.9, 0.92);
    const sheet = mix(mix(water, streak, step(0.45, band)), white, step(0.8, band));
    const pool = mix(streak, white, step(0.5, fract(flow.x.mul(0.08).sub(time.mul(0.3)))));
    const albedo = mix(sheet, pool, flow.y) as V3;
    const normal = normalize(attribute('normal', 'vec3')) as V3;
    m.colorNode = L.applyAerial(
      L.shadeDiffuse(albedo, normal, positionWorld as V3),
      apIn as V3,
      apT as V3,
    );
    return m;
  }

  /** Soft, pale puffs; the alpha falls off toward a quad's edges and top. */
  private mistMaterial(): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
    const L = this.lighting;
    const uv = attribute('mistUv', 'vec2');
    const apIn = varyingProperty('vec3', 'vMistInscatter');
    const apT = varyingProperty('vec3', 'vMistTransmittance');
    m.positionNode = Fn(() => {
      const ap = L.atmosphere.aerialPerspective(
        modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz as V3,
        3,
      );
      apIn.assign(ap.inscatter);
      apT.assign(ap.transmittance);
      return positionLocal;
    })();
    const across = uv.x.mul(2).sub(1);
    const soft = float(1)
      .sub(smoothstep(0.3, 1, across.mul(across)))
      .mul(float(1).sub(smoothstep(0.35, 1, uv.y)))
      .mul(smoothstep(0, 0.1, uv.y));
    const light = L.shadeDiffuse(
      vec3(0.85, 0.88, 0.9) as V3,
      normalize(positionWorld.negate()) as V3,
      positionWorld as V3,
    );
    m.colorNode = vec4(
      L.applyAerial(light, apIn as V3, apT as V3),
      soft.mul(0.55).mul(this.mistStrength),
    );
    return m;
  }

  update(eye: Readonly<Vec3d>): void {
    const world = this.terrain.currentWorld;
    const opts = this.terrain.meshOptions();
    if (world !== this.lastWorld) {
      this.lastWorld = world;
      this.falls = world?.rivers
        ? findWaterfalls(world.rivers, world.radius, world.seed).falls
        : [];
      this.stats.falls = this.falls.length;
      this.builtAt = null;
    }
    const show =
      this.enabled &&
      world !== null &&
      opts !== null &&
      opts.mode === 'biome' &&
      this.falls.length > 0;
    this.group.visible = show;
    if (!show) return;
    if (!this.builtAt || this.builtAt.distanceTo(eye) > 300) this.build(eye, world!.radius);
    placeCameraRelative(this.sheet, this.anchor, eye);
    placeCameraRelative(this.mist, this.anchor, eye);
  }

  private build(eye: Readonly<Vec3d>, radius: number): void {
    this.builtAt = (this.builtAt ?? new Vec3d()).copy(eye);
    this.anchor.copy(eye);
    const ex = this.terrain.exaggerationUniform.value;
    const pos: number[] = [];
    const nrm: number[] = [];
    const flow: number[] = [];
    const idx: number[] = [];
    const mPos: number[] = [];
    const mUv: number[] = [];
    const mIdx: number[] = [];
    const up = new Vec3d();
    const lip = new Vec3d();
    const foot = new Vec3d();
    const along = new Vec3d();
    const across = new Vec3d();
    const p = new Vec3d();
    const q = new Vec3d();
    let drawn = 0;
    // A point `h` m above the sea over unit direction d, relative to the anchor.
    const at = (d: Readonly<Vec3d>, h: number, out: Vec3d) =>
      out
        .copy(d)
        .scale(radius + h * ex)
        .sub(this.anchor);
    for (const f of this.falls) {
      // A sheet for a steep fall only: a long cascade is the river's white water and rapids,
      // and a sheet arcing over its run would float above the channel.
      if (f.run > 1.5 * (f.top - f.bottom)) continue;
      lip.set(...f.lip);
      if (lip.clone().scale(radius).distanceTo(eye) > this.range) continue;
      foot.set(...f.foot);
      up.copy(lip).add(foot).normalize();
      along.copy(foot).sub(lip);
      along.addScaled(up, -along.dot(up));
      let run = along.length() * radius;
      if (run < 1) along.set(0, 1, 0).cross(up);
      along.normalize();
      run = Math.max(run, 4);
      across.copy(up).cross(along).normalize();
      const drop = f.top - f.bottom;
      const speed = 4 + Math.sqrt(drop);
      // Sheet: rows from the lip to the foot on a parabola (a ledge's outflow), 1.5 m proud.
      const base = pos.length / 3;
      let s = 0;
      let prev: Vec3d | null = null;
      for (let k = 0; k <= ROWS; k++) {
        const t = k / ROWS;
        const half = (f.width / 2) * (1 + 0.25 * t);
        const h = f.top - drop * t * t + 1.5;
        p.copy(lip)
          .addScaled(along, (run * t) / radius)
          .normalize();
        at(p, h, q);
        if (prev) s += prev.distanceTo(q);
        prev = q.clone();
        for (const side of [-1, 1]) {
          const v = q.clone().addScaled(across, side * half);
          pos.push(v.x, v.y, v.z);
          // Facing out over the drop: the flow direction tilted up by the fall's slope.
          const n = along
            .clone()
            .scale(2 * drop * t)
            .addScaled(up, run)
            .normalize();
          nrm.push(n.x, n.y, n.z);
          flow.push(s, 0, speed);
        }
        if (k > 0) {
          const a = base + (k - 1) * 2;
          idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
        }
      }
      // Foam pool at the foot.
      const center = pos.length / 3;
      at(foot, f.bottom + 0.6, q);
      pos.push(q.x, q.y, q.z);
      nrm.push(up.x, up.y, up.z);
      flow.push(0, 1, speed);
      const r = f.width * 0.9 + 4;
      for (let k = 0; k < POOL_SIDES; k++) {
        const a = (k / POOL_SIDES) * 2 * Math.PI;
        p.copy(foot)
          .addScaled(along, (r * Math.cos(a)) / radius)
          .addScaled(across, (r * Math.sin(a)) / radius)
          .normalize();
        at(p, f.bottom + 0.6, q);
        pos.push(q.x, q.y, q.z);
        nrm.push(up.x, up.y, up.z);
        flow.push(r, 1, speed);
        idx.push(center, center + 1 + k, center + 1 + ((k + 1) % POOL_SIDES));
      }
      // Mist: three crossed quads over the pool (placeholder for Proposal 0011's effects).
      const tall = Math.min(70, 8 + 0.6 * drop);
      const wide = 1.6 * f.width + 10;
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI;
        const dir = along.clone().scale(Math.cos(a)).addScaled(across, Math.sin(a));
        const m0 = mPos.length / 3;
        for (const [u, v] of [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ] as const) {
          p.copy(foot)
            .addScaled(dir, ((u - 0.5) * wide) / radius)
            .normalize();
          at(p, f.bottom + v * tall - 2, q);
          mPos.push(q.x, q.y, q.z);
          mUv.push(u, v);
        }
        mIdx.push(m0, m0 + 1, m0 + 2, m0, m0 + 2, m0 + 3);
      }
      drawn++;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('flow', new BufferAttribute(new Float32Array(flow), 3));
    g.setIndex(idx);
    this.sheet.geometry.dispose();
    this.sheet.geometry = g;
    const mg = new BufferGeometry();
    mg.setAttribute('position', new BufferAttribute(new Float32Array(mPos), 3));
    mg.setAttribute('mistUv', new BufferAttribute(new Float32Array(mUv), 2));
    mg.setIndex(mIdx);
    this.mist.geometry.dispose();
    this.mist.geometry = mg;
    // Nothing in range: no empty draws.
    this.sheet.visible = idx.length > 0;
    this.mist.visible = mIdx.length > 0;
    this.stats.drawn = drawn;
    this.stats.triangles = idx.length / 3 + mIdx.length / 3;
  }

  dispose(): void {
    this.sheet.geometry.dispose();
    this.mist.geometry.dispose();
    (this.sheet.material as MeshBasicNodeMaterial).dispose();
    (this.mist.material as MeshBasicNodeMaterial).dispose();
  }
}
