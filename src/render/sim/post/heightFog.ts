/**
 * A height fog for testing the pipeline's volumetric path before the real
 * clouds and fog exist (clouds/volumetrics.ts): density falling exponentially
 * with altitude above the planet's sphere, one constant color. Marched in a
 * few jittered steps that grow with the distance, so it exercises the ray, the scene distance and the
 * jitter of `VolumetricContext` as the real source will.
 *
 * With a constant source color the in-scattered light is `color · (1 − T)`
 * exactly, whatever the density along the ray.
 */
import type { Node } from 'three/webgpu';
import { exp, float, Fn, length, Loop, max, min, vec3, vec4 } from 'three/tsl';
import type { VolumetricSource } from './simPipeline';

type V3 = Node<'vec3'>;

export interface HeightFogOptions {
  /** Planet-centered camera position (m): `PlanetLighting.eye`. */
  eye: V3;
  /** Planet radius (m). */
  radius: number;
  /** Extinction at sea level (1/m); default 1.5e-4, a visibility of about 26 km. */
  density?: number;
  /** Altitude over which the density falls by e (m); default 600. */
  scaleHeight?: number;
  /** Linear radiance of fully fogged air; default a pale blue gray. */
  color?: [number, number, number];
  /** March steps; default 12. */
  steps?: number;
  /** Farthest distance marched (m); default 80 km. */
  range?: number;
}

/** A uniform height fog as a volumetric source (preview: `VOLTEST=1`). */
export function heightFogTestSource(options: HeightFogOptions): VolumetricSource {
  const {
    eye,
    radius,
    density = 1.5e-4,
    scaleHeight = 600,
    color = [0.55, 0.62, 0.7],
    steps = 12,
    range = 80_000,
  } = options;
  return {
    build: (ctx) =>
      Fn(() => {
        const reach = min(ctx.sceneDistance, range).toVar();
        const depth = float(0).toVar();
        // Steps grow with the distance: t = reach · (k / steps)², sampled at a jittered k.
        Loop(steps, ({ i }) => {
          const k = float(i).add(ctx.jitter).div(steps).toVar();
          const p = eye.add(ctx.rayDirection.mul(reach.mul(k).mul(k)));
          const h = max(length(p).sub(radius), 0);
          const dt = reach.mul(float(i).mul(2).add(1)).div(steps * steps);
          depth.addAssign(exp(h.div(-scaleHeight)).mul(density).mul(dt));
        });
        const transmittance = exp(depth.negate()).toVar();
        return vec4(vec3(...color).mul(transmittance.oneMinus()), transmittance);
      })() as Node<'vec4'>,
  };
}
