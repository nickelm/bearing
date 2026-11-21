/**
 * Gun tracers (decision 295; visual-style Part I, Light and Emissives): every tracer
 * round in flight is a short streak along its velocity, warm and additive so the bloom
 * picks it up, at least about two pixels wide at any range so a burst reads from the
 * chase camera. One instanced mesh, placed camera-relative each frame (rule 4).
 */
import {
  AdditiveBlending,
  BoxGeometry,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { float, positionLocal, vec3 } from 'three/tsl';
import type { Vec3d } from '../../../core/vec3d';
import type { Round } from '../../../sim/flight/gun';

/** Tracers drawn at most. */
export const MAX_TRACERS = 128;
/** A streak's length per m/s of speed (s): about 25 m at the muzzle. */
const STREAK = 0.025;
/** Its least width (m) and its width in pixels at range. */
const MIN_WIDTH = 0.12;
const PIXELS = 2.2;

export class Tracers {
  readonly mesh: InstancedMesh;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private readonly dir = new Vector3();
  private readonly x = new Vector3(1, 0, 0);

  constructor() {
    const g = new BoxGeometry(1, 1, 1);
    // The streak's tail at its origin, its head forward along +x.
    g.translate(-0.5, 0, 0);
    const mat = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    // Hotter at the head (#FFB347 core, as the afterburner's).
    const along = positionLocal.x.add(1).clamp(0, 1);
    mat.colorNode = vec3(1.0, 0.62, 0.22).mul(float(1.2).add(along.mul(2.4)));
    mat.opacityNode = along.mul(0.8).add(0.2);
    this.mesh = new InstancedMesh(g, mat, MAX_TRACERS);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  /**
   * Places the tracer rounds of `rounds` relative to `eye`, `radPerPixel` setting their least
   * width. A streak trails its round, but never further back than the round has flown from
   * the muzzle at `muzzleVelocity` (m/s): a fresh round's streak starts at the gun, not
   * behind the aircraft (owner, decision 295).
   */
  place(
    rounds: Iterable<Readonly<Round>>,
    eye: Readonly<Vec3d>,
    radPerPixel: number,
    muzzleVelocity = 1000,
  ): void {
    let n = 0;
    for (const r of rounds) {
      if (!r.tracer || n >= MAX_TRACERS) continue;
      const speed = r.vel.length();
      if (speed < 1) continue;
      this.p.set(r.pos.x - eye.x, r.pos.y - eye.y, r.pos.z - eye.z);
      const w = Math.max(MIN_WIDTH, this.p.length() * radPerPixel * PIXELS);
      this.dir.set(r.vel.x / speed, r.vel.y / speed, r.vel.z / speed);
      this.q.setFromUnitVectors(this.x, this.dir);
      this.s.set(Math.min(speed * STREAK, r.age * muzzleVelocity), w, w);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(n++, this.m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
  }
}
