/**
 * Geographic glyphs on the strategic map (visual-style Part II, Geographic Glyphs;
 * decision 97): mountains, hill mounds, forest tokens and dunes, instanced from
 * glyphLayout.ts with the models of glyphGeometry.ts.
 *
 * - **Placement.** One instanced mesh per glyph kind and band (eight draw calls).
 *   The group is planet-centered (placed at −eye, rule 4); each instance sits on
 *   the displayed terrain (raw height × the relief's exaggeration), turned to its
 *   heading in the local east–north frame and scaled by its width.
 * - **Shading.** Flat: the face normal from screen-space derivatives, lit from the
 *   screen's upper left like the hillshade, so glyphs and relief read the same way.
 *   Snow-capped faces take the snow fill; forest tokens drop trees past their count.
 * - **Day and night.** The map's night tint and twilight warmth (decision 87), then
 *   the paper finish (decision 92), from the relief's uniforms.
 * - **Bands.** Each mesh's opacity is its band's fade factor, so glyphs fade in and
 *   out with the Theater and Region bands.
 */
import {
  BufferAttribute,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
} from 'three/webgpu';
import type { Node, UniformNode, Vector3 } from 'three/webgpu';
import {
  attribute,
  cos,
  cross,
  dot,
  float,
  max,
  mix,
  normalFlat,
  normalize,
  sin,
  step,
  varying,
  vec3,
} from 'three/tsl';
import type { Vec3d } from '../../core/vec3d';
import { placePlanetCentered } from '../common/cameraRelative';
import { srgbToLinear } from '../common/palette';
import { duneModel, forestModel, moundModel, mountainModel } from './glyphGeometry';
import type { GlyphModel } from './glyphGeometry';
import type { GlyphBand, GlyphKind, GlyphSet } from './glyphLayout';
import { daylightNode } from './mapDaylight';
import { paperFinish } from './mapFinish';

type F = Node<'float'>;

/** Glyph colors (sRGB hex): body and accent (snow cap, or a dune's slip face). */
export const GLYPH_COLORS: Record<GlyphKind, [number, number]> = {
  mountain: [0x8c8379, 0xf1f3f2],
  mound: [0xa99b73, 0xa99b73],
  forest: [0x4e6a48, 0x4e6a48],
  dune: [0xd8bd8c, 0xc4a473],
};
/** Lift above the terrain under the glyph's center (m), so its base does not sink. */
const LIFT = 150;
/** View-space light: from the screen's upper left, toward the viewer (as the hillshade). */
const LIGHT = (() => {
  const v = [-1, 1, 0.8];
  const l = Math.hypot(...v);
  return v.map((x) => x / l) as [number, number, number];
})();

const MODELS: Record<GlyphKind, () => GlyphModel> = {
  mountain: mountainModel,
  mound: moundModel,
  forest: forestModel,
  dune: duneModel,
};

export interface GlyphUniforms {
  exaggeration: Node<'float'>;
  sunDirection: UniformNode<'vec3', Vector3>;
  nightStrength: Node<'float'>;
  twilightStrength: Node<'float'>;
  finish: Node<'float'>;
  bandFade: Record<GlyphBand, Node<'float'>>;
}

function linear(hex: number) {
  return vec3(
    srgbToLinear(((hex >> 16) & 255) / 255),
    srgbToLinear(((hex >> 8) & 255) / 255),
    srgbToLinear((hex & 255) / 255),
  );
}

export class GlyphLayer {
  readonly group = new Group();
  private readonly materials = new Map<string, MeshBasicNodeMaterial>();
  private readonly models = new Map<GlyphKind, GlyphModel>();
  private meshes: Mesh[] = [];

  constructor(
    private readonly radius: number,
    private readonly u: GlyphUniforms,
  ) {}

  private material(kind: GlyphKind, band: GlyphBand): MeshBasicNodeMaterial {
    const key = `${kind}:${band}`;
    const cached = this.materials.get(key);
    if (cached) return cached;
    const u = this.u;
    const m = new MeshBasicNodeMaterial({ transparent: true, side: DoubleSide });
    m.name = band;
    const local = attribute('position', 'vec3');
    const part = attribute('part', 'float');
    const ip = attribute('iPos', 'vec4');
    const is = attribute('iShape', 'vec4');
    const dir = normalize(ip.xyz);
    // Local east and north; the tiny x keeps east defined at the poles.
    const east = normalize(vec3(dir.z, 0, dir.x.negate().add(1e-6)));
    const north = cross(dir, east);
    const c = cos(is.y);
    const s = sin(is.y);
    const ax = east.mul(c).add(north.mul(s));
    const ay = north.mul(c).sub(east.mul(s));
    // Forest tokens keep the first `variant` trees.
    const keep = kind === 'forest' ? step(part.add(0.5), is.w) : float(1);
    const p = local.mul(keep);
    const base = dir.mul(float(this.radius).add(ip.w.mul(u.exaggeration)).add(LIFT));
    m.positionNode = base.add(ax.mul(p.x).add(ay.mul(p.y)).add(dir.mul(p.z)).mul(is.x));

    const [body, accent] = GLYPH_COLORS[kind];
    // Snow on mountain caps where the instance is snowy; dunes always show their slip face.
    const accentShare =
      kind === 'mountain' ? varying(part.mul(is.z)) : kind === 'dune' ? varying(part) : float(0);
    const albedo = mix(linear(body), linear(accent), accentShare as F);
    const shade = float(0.42).add(max(dot(normalFlat, vec3(...LIGHT)), 0).mul(0.9));
    const mu = dot(varying(dir), u.sunDirection) as F;
    const lit = daylightNode(albedo.mul(shade), mu, u.nightStrength as F, u.twilightStrength as F);
    m.colorNode = paperFinish(lit, u.finish as F);
    m.opacityNode = u.bandFade[band];
    this.materials.set(key, m);
    return m;
  }

  private model(kind: GlyphKind): GlyphModel {
    let g = this.models.get(kind);
    if (!g) this.models.set(kind, (g = MODELS[kind]()));
    return g;
  }

  /** Replaces the glyphs (or removes them with null). */
  setGlyphs(sets: readonly GlyphSet[] | null): void {
    for (const mesh of this.meshes) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes = [];
    for (const set of sets ?? []) {
      if (set.count === 0) continue;
      const model = this.model(set.kind);
      const g = new InstancedBufferGeometry();
      g.setAttribute('position', new BufferAttribute(model.position, 3));
      g.setAttribute('part', new BufferAttribute(model.part, 1));
      g.setAttribute('iPos', new InstancedBufferAttribute(set.position, 4));
      g.setAttribute('iShape', new InstancedBufferAttribute(set.shape, 4));
      g.instanceCount = set.count;
      const mesh = new Mesh(g, this.material(set.kind, set.band));
      mesh.frustumCulled = false;
      // Glyphs draw after the relief, theater before region.
      mesh.renderOrder = set.band === 'theater' ? 2 : 3;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  /** Places the glyphs camera-relative and hides bands that have faded out. */
  update(eye: Readonly<Vec3d>, fade: Record<GlyphBand, number>): void {
    placePlanetCentered(this.group, eye);
    for (const mesh of this.meshes) {
      const band = (mesh.material as MeshBasicNodeMaterial).name as GlyphBand;
      mesh.visible = fade[band] > 0.001;
    }
  }

  dispose(): void {
    this.setGlyphs(null);
    for (const m of this.materials.values()) m.dispose();
  }
}
