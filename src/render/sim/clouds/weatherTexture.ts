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
import { WEATHER_RESOLUTION, WeatherGrid } from '../../../sim/weather/grid';
import type { Vec3d } from '../../../core/vec3d';
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

function newExtent(): WeatherExtent {
  return { cover: 0, precip: 0, baseMin: 0, baseMax: 0, fog: 0, dust: 0, storm: 0, ground: 0 };
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

/**
 * The most the weather holds within an angle of a direction: what the
 * volumetric march needs to know before it starts (decision 141).
 */
export interface WeatherExtent {
  /** Largest cloud cover fraction. */
  cover: number;
  /** Largest precipitation, as a fraction of 4 mm/h (not capped). */
  precip: number;
  /** Lowest and highest cloud base above sea level (m); both 0 without cloud. */
  baseMin: number;
  baseMax: number;
  /** Largest fog extinction (1/m), dust load and storm intensity. */
  fog: number;
  dust: number;
  storm: number;
  /** Highest mean ground above sea level (m); 0 without ground heights. */
  ground: number;
}

export class WeatherTexture {
  /** Cover and precipitation of both frames (see the file comment). */
  readonly texture: DataArrayTexture;
  /** Cloud base, fog, dust, and storm or snow, blended at the current time. */
  readonly fields: DataArrayTexture;
  /** Mean ground height above sea level per sample, in km (R); see `setGround`. */
  readonly terrain: DataArrayTexture;
  /** 0 shows the earlier frame, 1 the later. */
  readonly blend = uniform(0);
  /** Counts uploads of new frames, so baked fields know when the frames changed. */
  version = 0;
  /** Counts rebuilds of the CPU-blended fields (cloud base, storm), for the same purpose. */
  fieldVersion = 0;
  private readonly m: number;
  private frames: [WeatherFrame, WeatherFrame] | null = null;
  /** Fog extinction per sample of the two frames (1/m). */
  private readonly fog: [Float32Array, Float32Array];
  private ground: ArrayLike<number> | null = null;
  /** Blend the field texture was last built at. */
  private fieldBlend = Number.NaN;
  /** The values `fill` wrote, while no frames are set. */
  private filled: Required<WeatherFill> & { cover: number; precip: number } = {
    cover: 0,
    precip: 0,
    base: DEFAULT_BASE,
    fog: 0,
    snow: 0,
    dust: 0,
    storm: 0,
  };
  /** The samples' directions, for the CPU's queries. */
  private grid: WeatherGrid | null = null;
  private readonly index = new Int32Array(4);
  private readonly weight = new Float64Array(4);

  constructor(private readonly n = WEATHER_RESOLUTION) {
    this.m = n + 2;
    this.texture = this.arrayTexture();
    this.fields = this.arrayTexture();
    this.terrain = this.arrayTexture();
    const count = 6 * this.m * this.m;
    this.fog = [new Float32Array(count), new Float32Array(count)];
    this.fillFields({});
  }

  /** Frees both textures on the GPU. */
  dispose(): void {
    this.texture.dispose();
    this.fields.dispose();
    this.terrain.dispose();
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
    const half = this.terrain.image.data as Uint16Array;
    for (let s = 0; s < half.length / 4; s++) {
      half[s * 4] = DataUtils.toHalfFloat((ground ? ground[s]! : 0) / KM);
    }
    this.terrain.needsUpdate = true;
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
    this.filled = {
      cover,
      precip,
      base: extra.base ?? DEFAULT_BASE,
      fog: extra.fog ?? 0,
      snow: extra.snow ?? 0,
      dust: extra.dust ?? 0,
      storm: extra.storm ?? 0,
    };
    this.fillFields(extra);
    this.version++;
  }

  /**
   * The most of each field within `angle` (rad) of a direction from the planet
   * center (unit length), in either hourly frame: an upper bound of what a
   * shader can sample there at any blend. About 4,000 dot products.
   */
  extent(dir: Readonly<Vec3d>, angle: number, out: WeatherExtent = newExtent()): WeatherExtent {
    out.cover = out.precip = out.fog = out.dust = out.storm = out.ground = 0;
    out.baseMin = Infinity;
    out.baseMax = -Infinity;
    if (!this.frames) {
      const f = this.filled;
      if (this.ground)
        for (let s = 0; s < this.ground.length; s++) {
          if (this.ground[s]! > out.ground) out.ground = this.ground[s]!;
        }
      out.cover = f.cover;
      out.precip = f.precip;
      out.baseMin = out.baseMax = f.base;
      out.fog = f.fog;
      out.dust = f.dust;
      out.storm = f.storm;
      return out;
    }
    const grid = (this.grid ??= new WeatherGrid(this.n));
    const [a, b] = this.frames;
    const count = grid.count;
    // A sample's values reach half a cell past it (bilinear filtering).
    const cosine = Math.cos(Math.min(Math.PI, angle + 1.5 / this.n));
    const d = grid.directions;
    const ground = this.ground;
    const [fogA, fogB] = this.fog;
    for (let s = 0; s < count; s++) {
      if (d[s * 3]! * dir.x + d[s * 3 + 1]! * dir.y + d[s * 3 + 2]! * dir.z < cosine) continue;
      for (const data of a === b ? [a.data] : [a.data, b.data]) {
        const cover = data[Channel.Cover * count + s]!;
        if (cover > out.cover) out.cover = cover;
        const precip = data[Channel.Precipitation * count + s]! / PRECIP_FULL;
        if (precip > out.precip) out.precip = precip;
        const base = data[Channel.CloudBase * count + s]! + (ground ? ground[s]! : 0);
        if (base < out.baseMin) out.baseMin = base;
        if (base > out.baseMax) out.baseMax = base;
        const dust = data[Channel.Dust * count + s]!;
        if (dust > out.dust) out.dust = dust;
        const storm = data[Channel.Storm * count + s]!;
        if (storm > out.storm) out.storm = storm;
      }
      const fog = Math.max(fogA[s]!, fogB[s]!);
      if (fog > out.fog) out.fog = fog;
      if (ground && ground[s]! > out.ground) out.ground = ground[s]!;
    }
    if (out.baseMin > out.baseMax) out.baseMin = out.baseMax = 0;
    return out;
  }

  /**
   * Mean ground height above sea level (m) around a direction from the planet
   * center (unit length), from the heights `setGround` was given; 0 without them.
   */
  groundAt(dir: Readonly<Vec3d>): number {
    if (!this.ground) return 0;
    const grid = (this.grid ??= new WeatherGrid(this.n));
    grid.bilinear(dir, this.index, this.weight);
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += this.weight[k]! * this.ground[this.index[k]!]!;
    return sum;
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

  /**
   * Mean ground height above sea level (m) at a direction (need not be
   * normalized), from the heights `setGround` was given; 0 without them. One
   * read; what fog and dust lie on (decision 141).
   */
  sampleGround(dir: V3): F {
    const { face, uv } = cubeFaceUv(dir);
    const st = uv.mul(this.n).add(1).div(this.m) as Node<'vec2'>;
    return texture(this.terrain, vec2(st.x, st.y)).depth(face).level(int(0)).x.mul(KM) as F;
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
    this.fieldVersion++;
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
    this.fieldVersion++;
  }
}
