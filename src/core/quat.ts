/**
 * Float64 unit quaternions for orientations (Free Flight, decision 134). A
 * quaternion here rotates body-frame vectors into the world frame:
 * v_world = q ⊗ v_body ⊗ q*. Components are (w, x, y, z).
 */
import { Vec3d } from './vec3d';

export class Quatd {
  constructor(
    public w = 1,
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}

  set(w: number, x: number, y: number, z: number): this {
    this.w = w;
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  copy(q: Readonly<Quatd>): this {
    return this.set(q.w, q.x, q.y, q.z);
  }

  clone(): Quatd {
    return new Quatd(this.w, this.x, this.y, this.z);
  }

  normalize(): this {
    const n = Math.hypot(this.w, this.x, this.y, this.z) || 1;
    return this.set(this.w / n, this.x / n, this.y / n, this.z / n);
  }

  /** this = this ⊗ q (apply q first, then this). */
  multiply(q: Readonly<Quatd>): this {
    const { w, x, y, z } = this;
    return this.set(
      w * q.w - x * q.x - y * q.y - z * q.z,
      w * q.x + x * q.w + y * q.z - z * q.y,
      w * q.y - x * q.z + y * q.w + z * q.x,
      w * q.z + x * q.y - y * q.x + z * q.w,
    );
  }

  /** Rotates `v` (body) into `out` (world). */
  rotate(v: Readonly<Vec3d>, out = new Vec3d()): Vec3d {
    const { w, x, y, z } = this;
    // t = 2 (q.xyz × v); v' = v + w t + q.xyz × t
    const tx = 2 * (y * v.z - z * v.y);
    const ty = 2 * (z * v.x - x * v.z);
    const tz = 2 * (x * v.y - y * v.x);
    return out.set(
      v.x + w * tx + (y * tz - z * ty),
      v.y + w * ty + (z * tx - x * tz),
      v.z + w * tz + (x * ty - y * tx),
    );
  }

  /** Rotates `v` (world) into `out` (body): the inverse rotation. */
  unrotate(v: Readonly<Vec3d>, out = new Vec3d()): Vec3d {
    const { w, x, y, z } = this;
    const tx = 2 * (-y * v.z + z * v.y);
    const ty = 2 * (-z * v.x + x * v.z);
    const tz = 2 * (-x * v.y + y * v.x);
    return out.set(
      v.x + w * tx + (-y * tz + z * ty),
      v.y + w * ty + (-z * tx + x * tz),
      v.z + w * tz + (-x * ty + y * tx),
    );
  }

  /**
   * Integrates body rates ω (rad/s, body frame) over dt: q ← q ⊗ exp(ω dt / 2),
   * exactly for constant ω.
   */
  integrateBodyRates(wx: number, wy: number, wz: number, dt: number): this {
    const rate = Math.hypot(wx, wy, wz);
    const half = 0.5 * rate * dt;
    if (half < 1e-12) return this;
    const s = Math.sin(half) / rate;
    const dq = new Quatd(Math.cos(half), wx * s, wy * s, wz * s);
    return this.multiply(dq).normalize();
  }

  /**
   * The rotation whose body axes are `fwd`, `right` and `down` in world
   * coordinates (an orthonormal, right-handed triad).
   */
  static fromAxes(fwd: Readonly<Vec3d>, right: Readonly<Vec3d>, down: Readonly<Vec3d>): Quatd {
    // Rotation matrix columns: body x, y, z in world.
    const m00 = fwd.x,
      m01 = right.x,
      m02 = down.x;
    const m10 = fwd.y,
      m11 = right.y,
      m12 = down.y;
    const m20 = fwd.z,
      m21 = right.z,
      m22 = down.z;
    const tr = m00 + m11 + m22;
    let q: Quatd;
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      q = new Quatd(0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s);
    } else if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      q = new Quatd((m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s);
    } else if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      q = new Quatd((m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s);
    } else {
      const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      q = new Quatd((m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s);
    }
    return q.normalize();
  }
}
