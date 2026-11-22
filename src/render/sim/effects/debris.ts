/**
 * Debris and ground marks of the explosions (Proposal 0011, decision 323).
 *
 * - **Debris:** a few flat-shaded chunks thrown out on ballistic paths, tumbling, some of
 *   them trailing small smoke puffs; they come to rest on the ground they were thrown from,
 *   lie there a while and sink away. Stepped on the CPU: there are at most `MAX_DEBRIS`.
 * - **Scorch:** a dark, ragged disc on the ground where a blast struck it, lasting minutes.
 * - **Shockwave:** a pale ring that runs out over the ground from a large blast in half a
 *   second.
 *
 * Both marks are flat on the local level at the blast's point and fade by the same ordered
 * dither as the puffs. Everything is placed camera-relative each frame (rule 4).
 */
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import type { Group, Node } from 'three/webgpu';
import {
  abs,
  attribute,
  Discard,
  float,
  floor,
  Fn,
  fract,
  If,
  mod,
  normalWorld,
  positionGeometry,
  positionWorld,
  screenCoordinate,
  smoothstep,
  vec3,
  vec4,
} from 'three/tsl';
import { Vec3d } from '../../../core/vec3d';
import type { PlanetLighting } from '../lighting/planetLighting';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

export const MAX_DEBRIS = 256;
export const MAX_MARKS = 128;
/** Seconds a chunk lies on the ground before it is gone. */
const REST = 8;
/** Seconds a scorch lasts, and the share of it spent fading. */
const SCORCH_LIFE = 300;
const SCORCH_FADE = 0.3;
const RING_LIFE = 0.6;

interface Chunk {
  pos: Vec3d;
  vel: Vec3d;
  axis: Vector3;
  spin: number;
  angle: number;
  size: number;
  /** Distance from the planet's center of the ground it lands on. */
  floor: number;
  rested: number;
  smoking: boolean;
  nextPuff: number;
}

interface Mark {
  at: Vec3d;
  born: number;
  radius: number;
  ring: boolean;
}

/** The 4 × 4 ordered dither: discards where `coverage` is below the pixel's threshold. */
export function ditherDiscard(coverage: F, seed: F): void {
  const px = floor(screenCoordinate.xy);
  const b2 = (a: F, b: F): F => abs(a.sub(b)).mul(2).add(b) as F;
  const t = fract(
    b2(mod(px.x, 2) as F, mod(px.y, 2) as F)
      .mul(4)
      .add(b2(mod(floor(px.x.div(2)), 2) as F, mod(floor(px.y.div(2)), 2) as F))
      .add(0.5)
      .div(16)
      .add(fract(seed.mul(7.31))),
  );
  If(coverage.lessThan(t), () => {
    Discard();
  });
}

/** Geometry of triangles in the xz plane, facing up. */
function flat(pos: number[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  const n = new Float32Array(pos.length);
  for (let i = 1; i < n.length; i += 3) n[i] = 1;
  g.setAttribute('normal', new BufferAttribute(n, 3));
  return g;
}

/** A ragged disc of `n` sides, radius about 1, in the xz plane. */
function raggedDisc(n: number): BufferGeometry {
  const pos: number[] = [];
  const r = (i: number) => 0.8 + 0.25 * Math.abs(Math.sin(i * 2.399 + 0.7) * Math.sin(i * 1.3));
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * 2 * Math.PI;
    const a1 = ((i + 1) / n) * 2 * Math.PI;
    pos.push(0, 0, 0, Math.cos(a0) * r(i), 0, Math.sin(a0) * r(i));
    pos.push(Math.cos(a1) * r((i + 1) % n), 0, Math.sin(a1) * r((i + 1) % n));
  }
  return flat(pos);
}

/** A thin annulus of radius 1 in the xz plane. */
function ring(n: number, inner: number): BufferGeometry {
  const pos: number[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * 2 * Math.PI;
    const a1 = ((i + 1) / n) * 2 * Math.PI;
    const p = (a: number, r: number) => [Math.cos(a) * r, 0, Math.sin(a) * r];
    pos.push(
      ...p(a0, inner),
      ...p(a0, 1),
      ...p(a1, 1),
      ...p(a0, inner),
      ...p(a1, 1),
      ...p(a1, inner),
    );
  }
  return flat(pos);
}

export class Debris {
  readonly chunks: Chunk[] = [];
  readonly marks: Mark[] = [];
  private readonly mesh: InstancedMesh;
  private readonly scorch: InstancedMesh;
  private readonly rings: InstancedMesh;
  private readonly scorchFade: InstancedBufferAttribute;
  private readonly ringFade: InstancedBufferAttribute;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private readonly y = new Vector3(0, 1, 0);
  private readonly n = new Vector3();

  constructor(
    private readonly group: Group,
    lighting: PlanetLighting,
  ) {
    const g = new IcosahedronGeometry(1, 0);
    g.scale(1, 0.55, 0.8);
    // Flat facets: one normal per face.
    g.computeVertexNormals();
    const mat = new MeshBasicNodeMaterial();
    mat.name = 'debris';
    mat.colorNode = lighting.shadeDiffuse(
      vec3(0.07, 0.06, 0.05),
      normalWorld as V3,
      positionWorld as V3,
    );
    this.mesh = new InstancedMesh(g, mat, MAX_DEBRIS);
    const disc = raggedDisc(14);
    this.scorchFade = new InstancedBufferAttribute(new Float32Array(MAX_MARKS), 1);
    disc.setAttribute('markFade', this.scorchFade);
    const sm = new MeshBasicNodeMaterial({
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    sm.name = 'scorch';
    const fade = attribute('markFade', 'float') as F;
    sm.colorNode = Fn(() => {
      // Darkest at the middle, a little lighter toward the ragged edge.
      const r = positionGeometry.xz.length();
      ditherDiscard(fade.mul(smoothstep(1.05, 0.6, r).mul(0.5).add(0.5)), float(0.3));
      return vec4(
        lighting.shadeDiffuse(
          vec3(0.025, 0.022, 0.02).mul(r.mul(0.6).add(0.7)),
          normalWorld as V3,
          positionWorld as V3,
        ),
        1,
      );
    })();
    this.scorch = new InstancedMesh(disc, sm, MAX_MARKS);
    const rg = ring(40, 0.86);
    this.ringFade = new InstancedBufferAttribute(new Float32Array(MAX_MARKS), 1);
    rg.setAttribute('markFade', this.ringFade);
    const rm = new MeshBasicNodeMaterial({
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
    });
    rm.name = 'shockwave';
    rm.colorNode = Fn(() => {
      ditherDiscard(attribute('markFade', 'float') as F, float(0.6));
      return vec4(
        lighting.shadeDiffuse(vec3(0.75, 0.72, 0.66), normalWorld as V3, positionWorld as V3),
        1,
      );
    })();
    this.rings = new InstancedMesh(rg, rm, MAX_MARKS);
    for (const x of [this.mesh, this.scorch, this.rings]) {
      x.count = 0;
      x.frustumCulled = false;
      group.add(x);
    }
  }

  /** Throws `count` chunks from `at` (world); `smoking` of them trail puffs. */
  throw(
    at: Readonly<Vec3d>,
    floor: number,
    count: number,
    speed: readonly [number, number],
    size: number,
    smoking: number,
    rand: () => number,
  ): void {
    const up = at.clone().normalize();
    for (let i = 0; i < count; i++) {
      if (this.chunks.length >= MAX_DEBRIS) this.chunks.shift();
      // Up and out, in a cone about 50° off the vertical.
      const az = rand() * 2 * Math.PI;
      const el = (0.35 + 0.6 * rand()) * (Math.PI / 2);
      const t = new Vec3d(0, 1, 0).cross(up);
      if (t.length() < 1e-6) t.set(1, 0, 0);
      t.normalize();
      const b = up.clone().cross(t);
      const v = speed[0] + (speed[1] - speed[0]) * rand();
      const dir = t
        .clone()
        .scale(Math.cos(az) * Math.cos(el))
        .addScaled(b, Math.sin(az) * Math.cos(el))
        .addScaled(up, Math.sin(el));
      this.chunks.push({
        pos: at.clone().addScaled(up, 0.5),
        vel: dir.scale(v),
        axis: new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
        spin: 4 + 10 * rand(),
        angle: rand() * 6.28,
        size: size * (0.5 + rand()),
        floor,
        rested: -1,
        smoking: i < smoking,
        nextPuff: 0,
      });
    }
  }

  /** A scorch where a blast struck the ground, and its ring if `ring` > 0. */
  mark(at: Readonly<Vec3d>, scorch: number, ringRadius: number, now: number): void {
    if (scorch > 0) {
      if (this.marks.filter((m) => !m.ring).length >= MAX_MARKS) {
        const i = this.marks.findIndex((m) => !m.ring);
        this.marks.splice(i, 1);
      }
      this.marks.push({ at: at.clone(), born: now, radius: scorch, ring: false });
    }
    if (ringRadius > 0)
      this.marks.push({ at: at.clone(), born: now, radius: ringRadius, ring: true });
  }

  /**
   * Steps the chunks by `dt` and places everything from `eye`. `puff(pos, size)` sheds a
   * smoke puff behind a smoking chunk.
   */
  update(
    dt: number,
    now: number,
    eye: Readonly<Vec3d>,
    puff: (pos: Readonly<Vec3d>, size: number) => void,
  ): void {
    let n = 0;
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i]!;
      if (c.rested >= 0 && now - c.rested > REST) {
        this.chunks.splice(i, 1);
        continue;
      }
      const up = c.pos.clone().normalize();
      if (c.rested < 0) {
        c.vel.addScaled(up, -9.81 * dt).scale(Math.max(0, 1 - 0.08 * dt));
        c.pos.addScaled(c.vel, dt);
        c.angle += c.spin * dt;
        if (c.pos.length() <= c.floor + c.size * 0.3) {
          c.pos.copy(up).scale(c.floor + c.size * 0.3);
          c.rested = now;
        } else if (c.smoking && now >= c.nextPuff) {
          puff(c.pos, c.size * 1.6);
          c.nextPuff = now + 0.07;
        }
      }
    }
    for (const c of this.chunks) {
      // Sinks into the ground over its last two seconds.
      const sink = c.rested >= 0 ? Math.max(0, (now - c.rested - (REST - 2)) / 2) : 0;
      const up = c.pos.clone().normalize();
      this.p.set(
        c.pos.x - up.x * sink * c.size - eye.x,
        c.pos.y - up.y * sink * c.size - eye.y,
        c.pos.z - up.z * sink * c.size - eye.z,
      );
      this.q.setFromAxisAngle(c.axis, c.angle);
      this.s.setScalar(c.size);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(n++, this.m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;

    let ns = 0;
    let nr = 0;
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const m = this.marks[i]!;
      const age = now - m.born;
      if (age > (m.ring ? RING_LIFE : SCORCH_LIFE)) this.marks.splice(i, 1);
    }
    for (const m of this.marks) {
      const age = now - m.born;
      const up = m.at.clone().normalize();
      this.n.set(up.x, up.y, up.z);
      this.q.setFromUnitVectors(this.y, this.n);
      this.p.set(
        m.at.x - eye.x + up.x * 0.15,
        m.at.y - eye.y + up.y * 0.15,
        m.at.z - eye.z + up.z * 0.15,
      );
      if (m.ring) {
        const k = age / RING_LIFE;
        this.s.setScalar(m.radius * Math.sqrt(k) + 0.1);
        this.m.compose(this.p, this.q, this.s);
        this.rings.setMatrixAt(nr, this.m);
        this.ringFade.setX(nr++, (1 - k) * 0.9);
      } else {
        // Grows to its size in the first half second.
        this.s.setScalar(m.radius * Math.min(1, 0.3 + age * 1.4));
        this.m.compose(this.p, this.q, this.s);
        this.scorch.setMatrixAt(ns, this.m);
        const fadeStart = SCORCH_LIFE * (1 - SCORCH_FADE);
        this.scorchFade.setX(
          ns++,
          age < fadeStart ? 1 : 1 - (age - fadeStart) / (SCORCH_LIFE - fadeStart),
        );
      }
    }
    this.scorch.count = ns;
    this.rings.count = nr;
    this.scorch.instanceMatrix.needsUpdate = true;
    this.rings.instanceMatrix.needsUpdate = true;
    this.scorchFade.needsUpdate = true;
    this.ringFade.needsUpdate = true;
  }

  clear(): void {
    this.chunks.length = 0;
    this.marks.length = 0;
    this.mesh.count = this.scorch.count = this.rings.count = 0;
  }

  dispose(): void {
    for (const x of [this.mesh, this.scorch, this.rings]) {
      this.group.remove(x);
      x.geometry.dispose();
      (x.material as MeshBasicNodeMaterial).dispose();
    }
  }
}
