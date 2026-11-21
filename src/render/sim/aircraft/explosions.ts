/**
 * Explosions where bombs and rockets reach the ground (decision 300; visual-style Part I,
 * Light and Emissives): a warm flash that swells and shrinks within half a second, and a
 * dark smoke cloud that swells, rises and thins away over about ten seconds, both sized by
 * the cube root of the store's mass. Two instanced meshes with shared materials, so a
 * ripple of rockets costs no new pipelines; placed camera-relative each frame (rule 4).
 */
import {
  AdditiveBlending,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import type { Group } from 'three/webgpu';
import { float, positionWorld, vec3 } from 'three/tsl';
import type { Vec3d } from '../../../core/vec3d';
import type { PlanetLighting } from '../lighting/planetLighting';

const MAX = 128;
/** The flash's life and the smoke's (s). */
const FLASH = 0.5;
const SMOKE = 10;

interface Blast {
  at: Vec3d;
  up: Vec3d;
  born: number;
  /** The flash's largest radius (m). */
  size: number;
}

export class Explosions {
  private readonly blasts: Blast[] = [];
  private readonly flash: InstancedMesh;
  private readonly smoke: InstancedMesh;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly s = new Vector3();

  constructor(
    private readonly vehicles: Group,
    lighting: PlanetLighting,
  ) {
    const g = new IcosahedronGeometry(1, 1);
    const fm = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    fm.colorNode = vec3(1.0, 0.6, 0.2).mul(4);
    fm.opacityNode = float(0.9);
    this.flash = new InstancedMesh(g, fm, MAX);
    const sm = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    // Dark brown-gray smoke and dust, lit as a surface turned to the sun.
    sm.colorNode = lighting
      .shadeDiffuse(vec3(0.24, 0.22, 0.2), lighting.sunDirection as never, positionWorld as never)
      .mul(0.8);
    sm.opacityNode = float(0.55);
    this.smoke = new InstancedMesh(g, sm, MAX);
    for (const x of [this.flash, this.smoke]) {
      x.count = 0;
      x.frustumCulled = false;
      vehicles.add(x);
    }
  }

  /** An explosion of a store of `mass` (kg) at `at` (world, m) at game time t. */
  add(at: Readonly<Vec3d>, mass: number, t: number): void {
    if (this.blasts.length >= MAX) this.blasts.shift();
    this.blasts.push({
      at: at.clone(),
      up: at.clone().normalize(),
      born: t,
      size: 2.6 * Math.cbrt(Math.max(1, mass)),
    });
  }

  /** Places the explosions for the frame at game time t from `eye`. */
  place(t: number, eye: Readonly<Vec3d>): void {
    while (this.blasts.length > 0 && t - this.blasts[0]!.born > SMOKE) this.blasts.shift();
    let nf = 0;
    let ns = 0;
    for (const b of this.blasts) {
      const age = t - b.born;
      if (age < 0) continue;
      if (age < FLASH) {
        const k = age / FLASH;
        const r = b.size * Math.sin(Math.PI * Math.min(1, k * 1.4)) + 0.01;
        this.p.set(b.at.x - eye.x, b.at.y - eye.y, b.at.z - eye.z);
        this.s.set(r, r, r);
        this.m.compose(this.p, this.q, this.s);
        this.flash.setMatrixAt(nf++, this.m);
      }
      // Swells to 1.6 × the flash, rises 3 m/s, and thins to nothing over its last 3 s.
      const grow = 1 - Math.exp(-age / 1.5);
      const fade = Math.min(1, (SMOKE - age) / 3);
      const r = b.size * (0.3 + 1.3 * grow) * fade + 0.01;
      const rise = Math.min(age, SMOKE) * 3 + r * 0.6;
      this.p.set(
        b.at.x + b.up.x * rise - eye.x,
        b.at.y + b.up.y * rise - eye.y,
        b.at.z + b.up.z * rise - eye.z,
      );
      this.s.set(r, r, r);
      this.m.compose(this.p, this.q, this.s);
      this.smoke.setMatrixAt(ns++, this.m);
    }
    this.flash.count = nf;
    this.smoke.count = ns;
    this.flash.instanceMatrix.needsUpdate = true;
    this.smoke.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.blasts.length = 0;
    this.flash.count = 0;
    this.smoke.count = 0;
  }

  dispose(): void {
    for (const x of [this.flash, this.smoke]) {
      this.vehicles.remove(x);
      (x.material as MeshBasicNodeMaterial).dispose();
    }
    this.flash.geometry.dispose();
  }
}
