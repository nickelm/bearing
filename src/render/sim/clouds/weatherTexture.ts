/**
 * Live weather for shaders (decision 68): the sim's weather fields on the
 * weather grid, as cube-face array textures of (n + 2)² texels per face (the
 * grid's border samples make bilinear filtering continuous across face seams).
 *
 * Two textures, each read at most once per sample, and only by shaders that
 * use one of its fields:
 *
 * `texture`, both hourly frames, blended in the shader by `blend`, so clouds
 * change smoothly through the game hour:
 *
 *   R  cloud cover of the earlier frame     G  cloud cover of the later frame
 *   B  precipitation of the earlier frame   A  precipitation of the later frame
 *
 * Precipitation is stored as a fraction of PRECIP_FULL.
 *
 * `fields`, the other fields, blended between the frames on the CPU (five
 * fields in two frames would need two more textures and two more reads per
 * sample of the volumetric march). `update` blends them again whenever the
 * blend has moved by FIELD_STEP (every 28 game seconds: about 16,000 half
 * floats, well under a millisecond), so they step by less than 1% of an
 * hour's change:
 *
 *   R  cloud base above sea level (km)
 *   G  fog extinction near the ground (1/km), without the share of dust
 *   B  dust load 0..1
 *   A  storm intensity 0..1 where positive, snow fraction 0..1 where negative
 *
 * - Cloud base: the model's base is above ground. The texture adds the mean
 *   ground height of each weather sample when `setGround` has given it (the
 *   climate input has it), so cloud does not sink into high ground; without
 *   it, the base is taken above sea level. A weather sample covers about
 *   65 km, so this follows plateaus and ranges, not single mountains.
 * - Storm and snow share a channel as storm − snow: the model gives a storm
 *   only above 1.5 °C and snow only below it, so a sample never has both and
 *   each reads back exactly; filtering between a storm sample and a snow
 *   sample passes through neither. If both are given (`fill`), they cancel.
 * - Fog is the quantity WeatherState gives at the camera (weatherState.ts,
 *   `fogAt`): the extinction of each sample in each frame, blended in time
 *   here and in space by the sampler. Blending the visibility instead would
 *   keep the air clear for most of an hour in which fog forms and then close
 *   it in within minutes.
 */
import {
  ClampToEdgeWrapping,
  DataArrayTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { int, max, mix, texture, uniform, vec2 } from 'three/tsl';
import { HOUR, KM } from '../../../core/units';
import { Channel } from '../../../sim/weather/frame';
import type { WeatherFrame, WeatherView } from '../../../sim/weather/frame';
import { WEATHER_RESOLUTION } from '../../../sim/weather/grid';
import { cubeFaceUv } from '../../common/climateTexture';
import { frameFog } from '../weather/weatherState';

type V3 = Node<'vec3'>;
type F = Node<'float'>;

/** Precipitation rate drawn as fully dark cloud (m/s of water, 4 mm/h). */
const PRECIP_FULL = 0.004 / HOUR;
/** Change of the blend after which the CPU-blended fields are blended again. */
const FIELD_STEP = 1 / 128;
/** Cloud base before any weather arrives (m above sea level). */
const DEFAULT_BASE = 1500;

/** The fields of one weather sample in shaders. */
export interface WeatherSample {
  /** Cloud cover fraction 0..1. */
  cover: F;
  /** Precipitation as a fraction of 4 mm/h, 0..1. */
  precip: F;
  /** Cloud base above sea level (m). */
  base: F;
  /** Fog extinction near the ground (1/m), without dust. */
  fog: F;
  /** Snow fraction of the precipitation, 0..1. */
  snow: F;
  /** Dust load 0..1. */
  dust: F;
  /** Thunderstorm intensity 0..1. */
  storm: F;
}

/** Values for `fill` beyond cover and precipitation. */
export interface WeatherFill {
  /** Cloud base above sea level (m). */
  base?: number;
  /** Fog extinction near the ground (1/m). */
  fog?: number;
  snow?: number;
  dust?: number;
  storm?: number;
}

export class WeatherTexture {
  /** Cover and precipitation of both frames (see the file comment). */
  readonly texture: DataArrayTexture;
  /** Cloud base, fog, dust, and storm or snow, blended at the current time. */
  readonly fields: DataArrayTexture;
  /** 0 shows the earlier frame, 1 the later. */
  readonly blend = uniform(0);
  /** Counts uploads of new frames, so baked fields know when the frames changed. */
  version = 0;
  private readonly m: number;
  private frames: [WeatherFrame, WeatherFrame] | null = null;
  /** Fog extinction per sample of the two frames (1/m). */
  private readonly fog: [Float32Array, Float32Array];
  private ground: ArrayLike<number> | null = null;
  /** Blend the field texture was last built at. */
  private fieldBlend = Number.NaN;

  constructor(private readonly n = WEATHER_RESOLUTION) {
    this.m = n + 2;
    this.texture = this.arrayTexture();
    this.fields = this.arrayTexture();
    const count = 6 * this.m * this.m;
    this.fog = [new Float32Array(count), new Float32Array(count)];
    this.fillFields({});
  }

  /** Frees both textures on the GPU. */
  dispose(): void {
    this.texture.dispose();
    this.fields.dispose();
  }

  private arrayTexture(): DataArrayTexture {
    const t = new DataArrayTexture(new Uint16Array(6 * this.m * this.m * 4), this.m, this.m, 6);
    t.format = RGBAFormat;
    t.type = HalfFloatType;
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    t.wrapS = ClampToEdgeWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.generateMipmaps = false;
    return t;
  }

  /**
   * Mean ground height above sea level per weather sample (m), e.g. the
   * climate input's `ground`: cloud bases are raised by it. Null takes bases
   * above sea level.
   */
  setGround(ground: ArrayLike<number> | null): void {
    if (ground && ground.length !== 6 * this.m * this.m) {
      throw new RangeError('Ground heights do not match the weather texture');
    }
    this.ground = ground;
    if (this.frames) this.blendFields(this.blend.value);
  }

  /** Uploads the view's two frames (the later one doubles the earlier if missing). */
  setFrames(view: WeatherView): void {
    const [a, b] = view.frames;
    if (!a) return;
    const count = 6 * this.m * this.m;
    if (a.data.length < Channel.Storm * count + count) {
      throw new RangeError('Weather frame does not match the weather texture');
    }
    const later = (b ?? a).data;
    const half = this.texture.image.data as Uint16Array;
    const cover = Channel.Cover * count;
    const precip = Channel.Precipitation * count;
    for (let s = 0; s < count; s++) {
      half[s * 4] = DataUtils.toHalfFloat(a.data[cover + s]!);
      half[s * 4 + 1] = DataUtils.toHalfFloat(later[cover + s]!);
      half[s * 4 + 2] = DataUtils.toHalfFloat(Math.min(1, a.data[precip + s]! / PRECIP_FULL));
      half[s * 4 + 3] = DataUtils.toHalfFloat(Math.min(1, later[precip + s]! / PRECIP_FULL));
    }
    this.texture.needsUpdate = true;
    this.frames = [a, b ?? a];
    frameFog(a.data, count, this.fog[0]);
    if (b) frameFog(b.data, count, this.fog[1]);
    else this.fog[1].set(this.fog[0]);
    this.blendFields(this.blend.value);
    this.version++;
  }

  /**
   * Fills every texel with one cover and precipitation fraction, and the
   * other fields with `extra` (tests, and before the sim runs). Without
   * `extra`: a base of 1,500 m, no fog, snow, dust or storm.
   */
  fill(cover: number, precip = 0, extra: WeatherFill = {}): void {
    const half = this.texture.image.data as Uint16Array;
    const c = DataUtils.toHalfFloat(cover);
    const p = DataUtils.toHalfFloat(precip);
    for (let s = 0; s < half.length / 4; s++) half.set([c, c, p, p], s * 4);
    this.texture.needsUpdate = true;
    this.frames = null;
    this.fillFields(extra);
    this.version++;
  }

  /** Sets the blend for game time t from the view's frame hours. */
  update(view: WeatherView, t: number): void {
    const blend = view.blend(t);
    this.blend.value = blend;
    if (this.frames && !(Math.abs(blend - this.fieldBlend) < FIELD_STEP)) this.blendFields(blend);
  }

  /** The weather fields at a direction (need not be normalized). */
  sample(dir: V3): WeatherSample {
    const { face, uv } = cubeFaceUv(dir);
    // Texel i of the bordered lattice is centered at u = (i − 0.5) / n.
    const st = uv.mul(this.n).add(1).div(this.m) as Node<'vec2'>;
    const w = texture(this.texture, vec2(st.x, st.y)).depth(face).level(int(0));
    const f = texture(this.fields, vec2(st.x, st.y)).depth(face).level(int(0));
    return {
      cover: mix(w.x, w.y, this.blend) as F,
      precip: mix(w.z, w.w, this.blend) as F,
      base: f.x.mul(KM) as F,
      fog: f.y.div(KM) as F,
      dust: f.z as F,
      storm: max(f.w, 0) as F,
      snow: max(f.w.negate(), 0) as F,
    };
  }

  private fillFields(extra: WeatherFill): void {
    const half = this.fields.image.data as Uint16Array;
    const storm = extra.storm ?? 0;
    const snow = extra.snow ?? 0;
    const texel = [
      DataUtils.toHalfFloat((extra.base ?? DEFAULT_BASE) / KM),
      DataUtils.toHalfFloat((extra.fog ?? 0) * KM),
      DataUtils.toHalfFloat(extra.dust ?? 0),
      DataUtils.toHalfFloat(storm - snow),
    ];
    for (let s = 0; s < half.length / 4; s++) half.set(texel, s * 4);
    this.fields.needsUpdate = true;
    this.fieldBlend = Number.NaN;
  }

  /** Builds the field texture from the two frames at a blend 0..1. */
  private blendFields(blend: number): void {
    if (!this.frames) return;
    const [a, b] = this.frames;
    const count = 6 * this.m * this.m;
    const half = this.fields.image.data as Uint16Array;
    const ground = this.ground;
    const f = a === b ? 0 : blend;
    const at = (channel: number, s: number) => {
      const va = a.data[channel * count + s]!;
      return f === 0 ? va : va + (b.data[channel * count + s]! - va) * f;
    };
    const [fogA, fogB] = this.fog;
    for (let s = 0; s < count; s++) {
      const base = at(Channel.CloudBase, s) + (ground ? ground[s]! : 0);
      const fog = fogA[s]! + (fogB[s]! - fogA[s]!) * f;
      half[s * 4] = DataUtils.toHalfFloat(base / KM);
      half[s * 4 + 1] = DataUtils.toHalfFloat(fog * KM);
      half[s * 4 + 2] = DataUtils.toHalfFloat(at(Channel.Dust, s));
      half[s * 4 + 3] = DataUtils.toHalfFloat(at(Channel.Storm, s) - at(Channel.Snow, s));
    }
    this.fields.needsUpdate = true;
    this.fieldBlend = blend;
  }
}
