/**
 * Live weather for shaders (decision 68): the sim's cloud cover and
 * precipitation on the weather grid, as a cube-face array texture of
 * (n + 2)² texels per face (the grid's border samples make bilinear filtering
 * continuous across face seams).
 *
 *   R  cloud cover of the earlier frame     G  cloud cover of the later frame
 *   B  precipitation of the earlier frame   A  precipitation of the later frame
 *
 * Precipitation is stored as a fraction of PRECIP_FULL. `blend` moves between
 * the two frames, so clouds change smoothly through the game hour.
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
import { int, mix, texture, uniform, vec2 } from 'three/tsl';
import { HOUR } from '../../../core/units';
import { Channel } from '../../../sim/weather/frame';
import type { WeatherView } from '../../../sim/weather/frame';
import { WEATHER_RESOLUTION } from '../../../sim/weather/grid';
import { cubeFaceUv } from '../../common/climateTexture';

type V3 = Node<'vec3'>;
type F = Node<'float'>;

/** Precipitation rate drawn as fully dark cloud (m/s of water, 4 mm/h). */
const PRECIP_FULL = 0.004 / HOUR;

export class WeatherTexture {
  readonly texture: DataArrayTexture;
  /** 0 shows the earlier frame, 1 the later. */
  readonly blend = uniform(0);
  /** Counts uploads, so baked fields know when the frames changed. */
  version = 0;
  private readonly m: number;

  constructor(private readonly n = WEATHER_RESOLUTION) {
    this.m = n + 2;
    const t = new DataArrayTexture(new Uint16Array(6 * this.m * this.m * 4), this.m, this.m, 6);
    t.format = RGBAFormat;
    t.type = HalfFloatType;
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    t.wrapS = ClampToEdgeWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.generateMipmaps = false;
    this.texture = t;
  }

  /** Uploads the view's two frames (the later one doubles the earlier if missing). */
  setFrames(view: WeatherView): void {
    const [a, b] = view.frames;
    if (!a) return;
    const count = 6 * this.m * this.m;
    if (a.data.length < Channel.Precipitation * count + count) {
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
    this.version++;
  }

  /** Fills every texel with one cover and precipitation fraction (tests, and before the sim runs). */
  fill(cover: number, precip = 0): void {
    const half = this.texture.image.data as Uint16Array;
    const c = DataUtils.toHalfFloat(cover);
    const p = DataUtils.toHalfFloat(precip);
    for (let s = 0; s < half.length / 4; s++) half.set([c, c, p, p], s * 4);
    this.texture.needsUpdate = true;
    this.version++;
  }

  /** Sets the blend for game time t from the view's frame hours. */
  update(view: WeatherView, t: number): void {
    this.blend.value = view.blend(t);
  }

  /** Cloud cover (x) and precipitation fraction (y) at a direction (need not be normalized). */
  sample(dir: V3): { cover: F; precip: F } {
    const { face, uv } = cubeFaceUv(dir);
    // Texel i of the bordered lattice is centered at u = (i − 0.5) / n.
    const st = uv.mul(this.n).add(1).div(this.m) as Node<'vec2'>;
    const w = texture(this.texture, vec2(st.x, st.y)).depth(face).level(int(0));
    return {
      cover: mix(w.x, w.y, this.blend) as F,
      precip: mix(w.z, w.w, this.blend) as F,
    };
  }
}
