/**
 * Map labels on screen (visual-style Part II, Labels; decision 98): SDF text from
 * fontAtlas.ts, placed by labelPlacement.ts, drawn as one instanced mesh of glyph
 * quads in screen space.
 *
 * - **Shader.** Each quad's vertex shader writes clip space directly from its pixel
 *   rectangle and rotation. The fragment shader reads the distance field and draws
 *   the letter with an antialiased edge (the field's screen-space derivative) over
 *   a halo whose width is set in pixels per style.
 * - **When placement runs.** The collision pass runs when the camera settles
 *   (still for `SETTLE_TIME`), when the band changes, and when the labels change.
 *   Between passes, placed labels are laid out again every frame with the
 *   candidate they won, so they follow the camera.
 * - **Fades.** A label fades in when placed and out when dropped, over
 *   `LABEL_FADE_TIME`, times the fade of its zoom bands, so labels never pop.
 */
import {
  BufferAttribute,
  NoToneMapping,
  DataTexture,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  RedFormat,
  UnsignedByteType,
  Vector2,
} from 'three/webgpu';
import type { Camera, Scene, WebGPURenderer } from 'three/webgpu';
import {
  attribute,
  cos,
  float,
  fwidth,
  max,
  mix,
  sin,
  smoothstep,
  texture,
  uniform,
  varying,
  vec2,
  vec4,
} from 'three/tsl';
import { srgbToLinear } from '../../common/palette';
import type { ZoomBand } from '../zoomBands';
import { EM_PX, SPREAD } from './fontAtlas';
import type { FontAtlas } from './fontAtlas';
import type { MapLabel } from './labelModel';
import { layoutLabel, placeLabels } from './labelPlacement';
import type { Candidate, GlyphQuad, LabelView, Placement } from './labelPlacement';
import { LABEL_STYLES } from './labelStyles';

/** Real time for a label to fade fully in or out (s). */
export const LABEL_FADE_TIME = 0.3;
/** The camera counts as settled after this long without moving (s). */
export const SETTLE_TIME = 0.15;
/** Instance attributes, four floats each. */
const ATTRS = ['iRect', 'iMisc', 'iUv', 'iText', 'iHalo'] as const;

function linear(hex: number): [number, number, number] {
  return [
    srgbToLinear(((hex >> 16) & 255) / 255),
    srgbToLinear(((hex >> 8) & 255) / 255),
    srgbToLinear((hex & 255) / 255),
  ];
}

/**
 * Draws an overlay scene over the frame already rendered, without tone mapping, so
 * labels keep Part II's exact colors while the map beneath keeps the renderer's tone
 * curve (the simulation view's AgX applies to the whole frame; decision 98).
 */
export function drawOverlay(renderer: WebGPURenderer, overlay: Scene, camera: Camera): void {
  const toneMapping = renderer.toneMapping;
  const autoClear = renderer.autoClear;
  renderer.toneMapping = NoToneMapping;
  renderer.autoClear = false;
  try {
    renderer.render(overlay, camera);
  } finally {
    renderer.toneMapping = toneMapping;
    renderer.autoClear = autoClear;
  }
}

export class LabelLayer {
  readonly group = new Group();
  /** Last collision pass's duration (ms), for the stats overlay. */
  lastPassMs = 0;
  /** Labels placed in the last pass. */
  placedCount = 0;
  private atlas: FontAtlas | null = null;
  private texture: DataTexture | null = null;
  private labels: MapLabel[] = [];
  private placements = new Map<number, Placement>();
  /** Every label that is on screen or fading out: its candidate and opacity. */
  private readonly live = new Map<
    number,
    { candidate: Candidate; opacity: number; target: number }
  >();
  private readonly viewport = uniform(new Vector2(1, 1));
  private readonly material: MeshBasicNodeMaterial;
  private readonly geometry = new InstancedBufferGeometry();
  private readonly mesh: Mesh;
  private capacity = 0;
  private arrays: Float32Array[] = [];
  private attrs: InstancedBufferAttribute[] = [];
  private readonly atlasNode = texture(new DataTexture(new Uint8Array(1), 1, 1, RedFormat));
  private dirty = true;
  private band: ZoomBand | null = null;

  constructor() {
    this.geometry.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        3,
      ),
    );
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.allocate(256);
    // Double-sided: pixel y runs down and clip y up, which flips the quads' winding.
    const m = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    const corner = attribute('position', 'vec3');
    const rect = attribute('iRect', 'vec4'); // center x, y; width, height (px)
    const misc = attribute('iMisc', 'vec4'); // angle, opacity, halo threshold, halo opacity
    const uvr = attribute('iUv', 'vec4'); // u0, v0, u1, v1
    const text = attribute('iText', 'vec4'); // text rgb
    const halo = attribute('iHalo', 'vec4'); // halo rgb
    const c = cos(misc.x);
    const s = sin(misc.x);
    const local = corner.xy.mul(rect.zw);
    const px = rect.xy.add(
      vec2(local.x.mul(c).sub(local.y.mul(s)), local.x.mul(s).add(local.y.mul(c))),
    );
    const ndc = vec2(
      px.x.div(this.viewport.x).mul(2).sub(1),
      float(1).sub(px.y.div(this.viewport.y).mul(2)),
    );
    m.vertexNode = vec4(ndc, 0, 1);
    const uv = varying(mix(uvr.xy, uvr.zw, corner.xy.add(0.5)));
    const d = this.atlasNode.sample(uv).r;
    const w = max(fwidth(d), 1e-4).mul(0.75);
    const ink = smoothstep(float(0.5).sub(w), float(0.5).add(w), d);
    const haloT = varying(misc.z);
    const haloA = smoothstep(haloT.sub(w), haloT.add(w), d).mul(varying(misc.w));
    m.colorNode = mix(varying(halo.xyz), varying(text.xyz), ink);
    m.opacityNode = max(ink, haloA).mul(varying(misc.y));
    this.material = m;
    this.mesh = new Mesh(this.geometry, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.group.add(this.mesh);
  }

  /** (Re)creates the instance attributes for `capacity` glyphs, keeping their contents. */
  private allocate(capacity: number): void {
    const old = this.arrays;
    this.capacity = capacity;
    this.arrays = ATTRS.map((_, i) => {
      const a = new Float32Array(capacity * 4);
      if (old[i]) a.set(old[i]!);
      return a;
    });
    this.attrs = ATTRS.map((name, i) => {
      const attr = new InstancedBufferAttribute(this.arrays[i]!, 4);
      this.geometry.setAttribute(name, attr);
      return attr;
    });
  }

  get hasFonts(): boolean {
    return this.atlas !== null;
  }

  setFonts(atlas: FontAtlas): void {
    this.atlas = atlas;
    this.texture?.dispose();
    const t = new DataTexture(atlas.data, atlas.width, atlas.height, RedFormat, UnsignedByteType);
    t.minFilter = LinearFilter;
    t.magFilter = LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    this.texture = t;
    this.atlasNode.value = t;
    this.dirty = true;
  }

  setLabels(labels: MapLabel[] | null): void {
    this.labels = labels ?? [];
    this.placements.clear();
    this.live.clear();
    this.dirty = true;
  }

  /** Forces a collision pass on the next update. */
  invalidate(): void {
    this.dirty = true;
  }

  /**
   * Runs the collision pass if due, advances fades by `dt` real seconds (≤ 0
   * snaps them) and rebuilds the glyph instances for `view`.
   */
  update(
    view: LabelView,
    band: ZoomBand,
    bandFade: (b: ZoomBand) => number,
    dt: number,
    settled: boolean,
  ): void {
    this.viewport.value.set(view.width, view.height);
    const atlas = this.atlas;
    if (!atlas) {
      this.geometry.instanceCount = 0;
      return;
    }
    if (band !== this.band) {
      this.band = band;
      this.dirty = true;
    }
    let fresh: Map<number, Placement> | null = null;
    if (this.dirty && (settled || dt <= 0)) {
      const t0 = performance.now();
      const active = this.labels.filter((l) => l.bands.includes(band));
      fresh = placeLabels(atlas, active, view, this.placements);
      this.lastPassMs = performance.now() - t0;
      this.placedCount = fresh.size;
      this.placements = fresh;
      this.dirty = false;
      for (const [id, e] of this.live) if (!fresh.has(id)) e.target = 0;
      for (const [id, p] of fresh) {
        const e = this.live.get(id);
        if (e) {
          e.candidate = p.candidate;
          e.target = 1;
        } else this.live.set(id, { candidate: p.candidate, opacity: 0, target: 1 });
      }
    }
    const step = dt > 0 ? dt / LABEL_FADE_TIME : Infinity;
    let n = 0;
    for (const [id, e] of this.live) {
      e.opacity =
        e.target > e.opacity
          ? Math.min(e.target, e.opacity + step)
          : Math.max(e.target, e.opacity - step);
      if (e.opacity <= 0 && e.target === 0) {
        this.live.delete(id);
        continue;
      }
      const label = this.labels[id]!;
      const fade =
        Math.max(...label.bands.map(bandFade)) * e.opacity * e.opacity * (3 - 2 * e.opacity);
      if (fade <= 0.002) continue;
      const quads = fresh?.get(id)?.quads ?? layoutLabel(atlas, label, e.candidate, view);
      if (!quads) continue;
      n = this.write(n, quads, label, fade, atlas);
    }
    this.geometry.instanceCount = n;
    for (const a of this.attrs) {
      a.needsUpdate = true;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * 4);
    }
  }

  private write(
    n: number,
    quads: GlyphQuad[],
    label: MapLabel,
    fade: number,
    atlas: FontAtlas,
  ): number {
    const style = LABEL_STYLES[label.style];
    const tc = linear(style.color);
    const hc = linear(style.halo);
    // Halo edge in field units: the field spans ±SPREAD atlas px over 0..1.
    const texel = style.size / EM_PX;
    const haloT = Math.max(0.02, 0.5 - style.haloWidth / texel / (2 * SPREAD));
    for (const q of quads) {
      if (n >= this.capacity) this.allocate(this.capacity * 2);
      const o = n * 4;
      const [rect, misc, uv, text, halo] = this.arrays as [
        Float32Array,
        Float32Array,
        Float32Array,
        Float32Array,
        Float32Array,
      ];
      rect.set([q.x, q.y, q.w, q.h], o);
      misc.set([q.angle, fade, haloT, style.haloOpacity], o);
      uv.set(
        [
          q.glyph.x / atlas.width,
          q.glyph.y / atlas.height,
          (q.glyph.x + q.glyph.w) / atlas.width,
          (q.glyph.y + q.glyph.h) / atlas.height,
        ],
        o,
      );
      text.set([tc[0], tc[1], tc[2], 1], o);
      halo.set([hc[0], hc[1], hc[2], 1], o);
      n++;
    }
    return n;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture?.dispose();
  }
}
