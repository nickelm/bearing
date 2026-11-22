/**
 * The explosions' flash lights (Proposal 0011, decision 324): at most `FLASH_LIGHTS` short
 * point lights a frame, the oldest dropped first when a new one comes. Each lights the
 * ground, the buildings and the puffs around it as `PlanetLighting.flashAt` does for
 * lightning: its color falls off as reach² / (reach² + d²), taken like sky light.
 */
import { Vector4 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { dot, Fn, Loop, uniformArray, vec3 } from 'three/tsl';
import type { Vec3d } from '../../../core/vec3d';

type V3 = Node<'vec3'>;

/** Lights at once (the proposal's small cap). */
export const FLASH_LIGHTS = 4;
/** A light's color at its peak per unit of intensity (linear, display units). */
const FLASH_COLOR: readonly [number, number, number] = [1, 0.62, 0.28];

interface Flash {
  at: Vec3d;
  born: number;
  /** Seconds it lasts. */
  life: number;
  intensity: number;
  reach: number;
}

export class FlashLights {
  /** Per light: (position relative to the eye, reach), then (color, 0). */
  readonly data = uniformArray(
    Array.from({ length: FLASH_LIGHTS * 2 }, () => new Vector4()),
    'vec4',
  );
  private readonly flashes: Flash[] = [];
  /** Lights dropped for the cap since the start. */
  dropped = 0;

  /** A flash at `at` (world) at effect time `now`. */
  add(at: Readonly<Vec3d>, intensity: number, reach: number, now: number, life = 0.25): void {
    if (this.flashes.length >= FLASH_LIGHTS) {
      this.flashes.shift();
      this.dropped++;
    }
    this.flashes.push({ at: at.clone(), born: now, life, intensity, reach });
  }

  /** Lights lit at `now`. */
  get count(): number {
    return this.flashes.length;
  }

  /** Writes the frame's lights, relative to `eye`, at effect time `now`. */
  update(eye: Readonly<Vec3d>, now: number): void {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      if (now - this.flashes[i]!.born > this.flashes[i]!.life) this.flashes.splice(i, 1);
    }
    const v = this.data.array as Vector4[];
    for (let i = 0; i < FLASH_LIGHTS; i++) {
      const f = this.flashes[i];
      if (!f) {
        v[i * 2]!.set(0, 0, 0, 1);
        v[i * 2 + 1]!.set(0, 0, 0, 0);
        continue;
      }
      // A quick rise and a longer fall.
      const k = Math.min(1, Math.max(0, (now - f.born) / f.life));
      const e = f.intensity * (k < 0.1 ? k / 0.1 : (1 - k) ** 2);
      v[i * 2]!.set(f.at.x - eye.x, f.at.y - eye.y, f.at.z - eye.z, f.reach);
      v[i * 2 + 1]!.set(FLASH_COLOR[0] * e, FLASH_COLOR[1] * e, FLASH_COLOR[2] * e, 0);
    }
  }

  clear(): void {
    this.flashes.length = 0;
  }

  /** The lights' sum at a camera-relative point. */
  at(relative: V3): V3 {
    return Fn(() => {
      const sum = vec3(0).toVar();
      Loop(FLASH_LIGHTS, ({ i }) => {
        const p = this.data.element(i.mul(2)) as unknown as Node<'vec4'>;
        const c = this.data.element(i.mul(2).add(1)) as unknown as Node<'vec4'>;
        const d = relative.sub(p.xyz);
        const r2 = p.w.mul(p.w);
        sum.addAssign(c.xyz.mul(r2.div(r2.add(dot(d, d)))));
      });
      return sum;
    })() as V3;
  }
}
