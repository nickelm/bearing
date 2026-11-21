/**
 * Valley mist and zone height fog (Proposal 0010, *Air*; decision 300): two thin
 * exponential layers of fog over the ground, folded into the aerial perspective that
 * every material already computes, so terrain, trees, buildings, props and rock
 * dressing all sit in the same fog at no extra pass.
 *
 * - **Height fog** takes the zone's haze color and density (ZoneRecipe.haze,
 *   hazeDensity) and thickens toward the low ground of the camera's area: its base
 *   is the area's mean ground, its scale height a few hundred meters. Separate from
 *   the distance haze of the sky model, which it adds to.
 * - **Valley mist** pools in the low ground: its base is the lowest ground around the
 *   camera, its scale height tens of meters, so it lies as a flat, soft-topped sheet in
 *   valley floors. It is thick at dawn and after rain and burns off through the morning
 *   (`mistAmount`).
 *
 * Along a ray from height h0 to h1 over length L, a layer of density d·exp(−(h − b)/H)
 * has optical depth d·L·e^(−(h0 − b)/H)·(1 − e^(−k))/k with k = (h1 − h0)/H; heights
 * below the base count as at the base, so the layer never grows without bound in deep
 * valleys. The fog's light is the sky's light on a horizontal surface plus the sun's
 * through the air, both per unit sun illuminance like the rest of the aerial
 * perspective, tinted by the layer's color. Clear air (both densities 0) costs a
 * uniform branch.
 */
import { Vector3 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { abs, exp, float, max, mix, select, uniform, vec3 } from 'three/tsl';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

export class GroundFog {
  /** Height fog: density at its base (1/m), base height (m above the sea), scale height (m), tint. */
  readonly fogDensity = uniform(0);
  readonly fogBase = uniform(0);
  readonly fogScale = uniform(400);
  readonly fogColor = uniform(new Vector3(0.75, 0.8, 0.88));
  /** Valley mist: density at its base (1/m), base height (m), scale height (m), tint. */
  readonly mistDensity = uniform(0);
  readonly mistBase = uniform(0);
  readonly mistScale = uniform(45);
  readonly mistColor = uniform(new Vector3(0.9, 0.92, 0.95));
  /** Brightness of the fog's light against a white surface's (a tuning knob). */
  readonly gain = uniform(1);
  /** The camera's height above the sea (m), from the float64 eye. */
  readonly eyeHeight = uniform(0);

  /** Optical depth of one layer between heights h0 and h1 over length L. */
  private static depth(d: F, base: F, scale: F, h0: F, h1: F, L: F): F {
    const a = max(h0, base);
    const b = max(h1, base);
    const k = b.sub(a).div(scale);
    // (1 − e^(−k))/k, its series near 0.
    const f = select(
      abs(k).lessThan(1e-3),
      float(1).sub(k.mul(0.5)),
      float(1).sub(exp(k.negate())).div(k),
    );
    return d
      .mul(L)
      .mul(exp(a.sub(base).div(scale).negate()))
      .mul(f) as F;
  }

  /**
   * The fog between the camera and a point `relative` (camera-relative, m) whose height
   * above the sea is `pointHeight`: in-scattered light (per unit sun illuminance) and the
   * transmittance, gray.
   */
  between(dist: F, pointHeight: F, light: V3): { inscatter: V3; transmittance: F } {
    const h0 = this.eyeHeight as unknown as F;
    const fog = GroundFog.depth(
      this.fogDensity as unknown as F,
      this.fogBase as unknown as F,
      this.fogScale as unknown as F,
      h0,
      pointHeight,
      dist,
    );
    const mist = GroundFog.depth(
      this.mistDensity as unknown as F,
      this.mistBase as unknown as F,
      this.mistScale as unknown as F,
      h0,
      pointHeight,
      dist,
    );
    const tau = fog.add(mist);
    const t = exp(tau.negate()) as F;
    // The scattered light's tint: the two layers by their share of the depth.
    const tint = mix(
      this.fogColor as unknown as V3,
      this.mistColor as unknown as V3,
      mist.div(max(tau, 1e-6)),
    );
    const inscatter = tint.mul(light).mul(this.gain).mul(float(1).sub(t)) as V3;
    return { inscatter, transmittance: t };
  }

  /** Whether any fog is on (a uniform test for branches). */
  get on(): Node<'bool'> {
    return (this.fogDensity as unknown as F).add(this.mistDensity).greaterThan(0) as Node<'bool'>;
  }

  /** A vec3 of the transmittance, for multiplying the sky model's. */
  static gray(t: F): V3 {
    return vec3(t) as V3;
  }
}
