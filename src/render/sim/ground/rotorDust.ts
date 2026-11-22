/**
 * What a rotor's downwash raises from the ground (G5; decisions 168, 169, 182; Proposal 0011,
 * decision 326): low puffs of dust, grit, snow or spray that roll out from under the rotor,
 * drawn by the effects system (`effects/`) as its `rotor-downwash` emitter.
 *
 * - **Which.** Once the wash has moved a few meters, `washSurface` reads the ground where
 *   the wash meets it: spray over the sea, lakes and rivers; snow powder where snow lies;
 *   ochre dust (in the ground's own color) on deserts, beaches and dry grass and scrub; gray
 *   grit on rock, gravel, tundra, alpine ground and pavement; nothing on green ground,
 *   where the flattened grass is the cue (decision 176). Wet ground raises less dust and
 *   grit.
 * - **Where.** The emitter sits at the wash's center on the ground, scaled by the rotor's
 *   radius: its puffs are thrown out across the ground, slow as the wall jet spreads, rise
 *   into a low billow and drift off with the wind (the puff model's forces).
 * - **How much.** The emitter's rate scales with the wash's strength and the surface's
 *   amount and the particles' quality factor; none without a wash, and none above 50 kt
 *   over the ground (decision 191).
 */
import { Vec3d } from '../../../core/vec3d';
import { directionToCubeFace } from '../../../core/coords';
import { tileForDirection, TILE_TEXELS } from '../../../core/tiles';
import { Biome, TileCover } from '../../../worldgen/biomes';
import { earthElevation, LAPSE_RATE } from '../../../worldgen/climate';
import { NO_LAKE } from '../../../worldgen/gpu/tileSynth';
import { srgbToLinear } from '../../common/palette';
import type { ClimateTexture } from '../../common/climateTexture';
import { WARMEST_PHASE } from '../../common/seasons';
import {
  colorFor,
  lakeSampler,
  mapSample,
  materialAt,
  surfaceSampler,
} from '../../common/terrain/tileMesh';
import { riverStretches, treeDataTile } from '../forest/forestLayer';
import type { InfraScene } from '../infra/infraScene';
import type { LandShading } from '../terrain/landShading';
import type { TerrainRenderer } from '../terrain/terrainRenderer';
import type { EffectsSystem } from '../effects/effectsSystem';
import type { LookId } from '../effects/presets';
import type { GroundDownwash } from './groundCoverLayer';

/** What the wash raises. */
export type WashKind = 'none' | 'dust' | 'grit' | 'snow' | 'spray';

/** The ground under the wash, as `washSurface` reads it. */
export interface WashSite {
  /** Over the sea, a lake or a river. */
  water: boolean;
  /** The tile material's cover (a `Biome` or a `TileCover`). */
  cover: number;
  /** Moisture 0..1 (the climate's). */
  moisture: number;
  /** The surface temperature today (°C). */
  temperature: number;
  /** Ground wetness from rain 0..1. */
  wetness: number;
  /** On pavement (runways, aprons, roads). */
  paved: boolean;
  /** Steep, bare rock. */
  rock: boolean;
}

/** The kind of sprite and how much of it (0..1) the ground gives. */
export interface WashSurface {
  kind: WashKind;
  amount: number;
}

/** What the wash raises from a site (see the module comment). */
export function washSurface(s: WashSite): WashSurface {
  if (s.water) return { kind: 'spray', amount: 1 };
  if (s.temperature < -1.5 && s.moisture > 0.03 && !s.paved) return { kind: 'snow', amount: 1 };
  const dry = 1 - Math.min(1, Math.max(0, s.wetness / 0.6));
  if (s.paved || s.rock) return { kind: 'grit', amount: 0.35 * dry };
  switch (s.cover) {
    case Biome.HotDesert:
    case Biome.ColdDesert:
    case Biome.RockyDesert:
    case Biome.RedRockDesert:
    case Biome.FogDesert:
    case TileCover.Beach:
      return { kind: 'dust', amount: dry };
    case TileCover.Gravel:
    case Biome.Alpine:
    case Biome.Tundra:
      return { kind: 'grit', amount: 0.5 * dry };
    case TileCover.Marsh:
    case Biome.Wetland:
    case Biome.Mangrove:
      return { kind: 'spray', amount: 0.35 };
    case Biome.Savanna:
    case Biome.Shrubland:
    case Biome.TemperateGrassland: {
      // Dry grass and scrub lift dust from the bare ground between them.
      const arid = 1 - Math.min(1, Math.max(0, (s.moisture - 0.2) / 0.2));
      return arid > 0 ? { kind: 'dust', amount: 0.7 * arid * dry } : { kind: 'none', amount: 0 };
    }
    default:
      return { kind: 'none', amount: 0 };
  }
}

/** Puffs a second at full strength and quality factor 1 (the preset's rate) and their mean life (s). */
const WASH_RATE = 40;
const WASH_LIFE = 3.1;
/**
 * Dust is raised only by a slow helicopter (the owner's request, decision 191): in full
 * below 30 kt over the ground, none above 50 kt.
 */
const DUST_SLOW = 15.4;
const DUST_FAST = 25.7;
/** The wash moves this far (m) before the ground under it is read again. */
const SURFACE_STEP = 3;
/** The wash's outwash speed (m/s) at which it raises all it can. */
const FULL_WASH = 10;

/** Each kind's look and tint (linear; dust takes the ground's own color). */
const LOOK: Readonly<
  Record<Exclude<WashKind, 'none'>, { look: LookId; tint: [number, number, number] }>
> = {
  dust: { look: 'dust', tint: [0.6, 0.48, 0.33] },
  grit: { look: 'dust', tint: [0.42, 0.4, 0.37] },
  snow: { look: 'snow-dust', tint: [0.98, 0.99, 1] },
  spray: { look: 'snow-dust', tint: [0.84, 0.89, 0.94] },
};

/** What `RotorDust.update` needs each frame. */
export interface RotorDustFrame {
  eye: Readonly<Vec3d>;
  forward: Readonly<Vec3d>;
  up: Readonly<Vec3d>;
  /** Real seconds since the last frame (0 while paused). */
  dt: number;
  /** The downwash, or null. */
  wash: GroundDownwash | null;
  /** The wind at the ground there (world, m/s). */
  wind: Readonly<Vec3d>;
  /** The particles' quality factor (Precipitation.density). */
  density: number;
}

export class RotorDust {
  enabled = true;
  /** What was raised last frame, and about how many puffs it keeps in the air. */
  readonly stats = { kind: 'none' as WashKind, count: 0 };
  private infra: InfraScene | null = null;
  private readonly scratch = new Vec3d();
  /** The ground under the wash as last read, and where. */
  private surface: (WashSurface & { color: [number, number, number] | null }) | null = null;
  private readonly surfaceCenter = new Vec3d();
  private readonly climateSample = new Float32Array(4);

  constructor(
    private readonly terrain: TerrainRenderer,
    private readonly climate: ClimateTexture,
    private readonly land: LandShading,
    private readonly effects: EffectsSystem,
  ) {}

  /** Pavement and towns, for grit on runways and aprons. */
  setInfrastructure(scene: InfraScene | null): void {
    this.infra = scene;
  }

  /** What the ground under the wash gives (see `washSurface`), or none if its data is not loaded. */
  private surfaceAt(
    center: Readonly<Vec3d>,
  ): WashSurface & { color: [number, number, number] | null } {
    const world = this.terrain.currentWorld;
    const opts = this.terrain.meshOptions();
    const none = { kind: 'none' as WashKind, amount: 0, color: null };
    if (!world || !opts) return none;
    const d = this.scratch.copy(center).normalize();
    const t = tileForDirection(d, 10);
    const key = treeDataTile(t);
    const data = this.terrain.dataTile(key);
    if (!data) {
      this.terrain.requestDataTile(key, 1);
      return none;
    }
    const uv = directionToCubeFace(d);
    const size = TILE_TEXELS * (1 << t.level);
    const sx = uv.u * size - t.x * TILE_TEXELS;
    const sy = uv.v * size - t.y * TILE_TEXELS;
    const h = surfaceSampler(t, t.level, data, opts)(sx, sy, d);
    const lake = lakeSampler(t, data)(sx, sy);
    const [fx, fy] = mapSample(t, data.key, sx, sy);
    const mat = materialAt(data, fx, fy);
    let water = h <= 0 || (lake > NO_LAKE / 2 && lake > h);
    if (!water && world.rivers) {
      const R = opts.radius;
      for (const o of riverStretches(world.rivers, t, R)) {
        const ab = o.b.clone().sub(o.a);
        const k = Math.min(
          1,
          Math.max(0, d.clone().sub(o.a).dot(ab) / Math.max(ab.dot(ab), 1e-30)),
        );
        if (o.a.clone().addScaled(ab, k).distanceTo(d) * R < o.width / 2) water = true;
      }
    }
    const c = this.climate.sampleAt(d, this.climateSample);
    const meanT = c[0]! - earthElevation(Math.max(0, h), c[3]!, opts.reliefScale) * LAPSE_RATE;
    const hemisphere = Math.max(-1, Math.min(1, d.y * 20));
    const seasonal =
      Math.cos((this.land.seasonPhase.value - WARMEST_PHASE) * 2 * Math.PI) * hemisphere;
    const temperature = meanT + c[1]! * seasonal + this.land.temperatureOffset.value;
    const s = washSurface({
      water,
      cover: mat & 0xff,
      moisture: c[2]!,
      temperature,
      wetness: this.land.wetness.value,
      paved: this.infra?.isClear(d, true) ?? false,
      rock: false,
    });
    const rgb = colorFor('biome', Math.max(1, h), mat, t.level, false, opts.reliefScale);
    return { ...s, color: [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])] };
  }

  update(f: RotorDustFrame): void {
    const wash = this.enabled ? f.wash : null;
    let kind: WashKind = 'none';
    let count = 0;
    const slow =
      wash?.groundSpeed === undefined
        ? 1
        : 1 - Math.min(1, Math.max(0, (wash.groundSpeed - DUST_SLOW) / (DUST_FAST - DUST_SLOW)));
    if (wash && wash.speed > 0.5 && slow > 0) {
      // The ground under the wash, read again only when the wash has moved (decision 191).
      if (!this.surface || this.surfaceCenter.distanceTo(wash.center) > SURFACE_STEP) {
        this.surface = this.surfaceAt(wash.center);
        this.surfaceCenter.copy(wash.center);
      }
      const s = this.surface;
      kind = s.kind;
      if (s.kind !== 'none' && s.amount > 0) {
        const strength =
          Math.min(1, wash.speed / FULL_WASH) *
          s.amount *
          slow *
          Math.min(2, Math.max(0, f.density));
        const look = LOOK[s.kind];
        // Dust takes the ground's color, lighter: what it is made of.
        const tint =
          s.kind === 'dust' && s.color
            ? (s.color.map((v, i) => Math.min(1, v * 1.25 * 0.5 + look.tint[i]! * 0.5)) as [
                number,
                number,
                number,
              ])
            : look.tint;
        this.effects.track('rotor-wash', 'rotor-downwash', {
          pos: wash.center,
          scale: wash.radius,
          strength,
          tint,
          look: look.look,
          floor: wash.center.length(),
        });
        count = Math.round(WASH_RATE * strength * WASH_LIFE);
      }
    }
    this.stats.kind = kind;
    this.stats.count = count;
  }

  dispose(): void {
    this.effects.remove('rotor-wash');
  }
}
