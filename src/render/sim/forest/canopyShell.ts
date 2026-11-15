/**
 * The canopy shell (proposal 0003, decision 148): the terrain's tile meshes
 * drawn a second time over forest, each vertex lifted by the canopy height
 * field H (worldgen/canopy.ts), so a forest has mass, a skyline and cover at
 * every range for about the cost of the terrain.
 *
 * - **Height.** The stand's lumpy top times a lift that rises from the ground
 *   on the canopy threshold's contour to full height EDGE_RISE of density
 *   inside it (decision 153), below the edge trees' crowns. Trees are not
 *   exaggerated: the height adds to the exaggerated ground.
 * - **Edges.** The shell slopes to the ground across the mesh triangles that
 *   straddle the density contour (the contour the terrain's canopy shading
 *   follows, decision 71) and ends where it meets the ground (decision 157). Lanes open
 *   along roads, runways and taxiways, and over towns and industry.
 * - **Near the camera** the shell sinks to `understory` of H within
 *   `nearRadius`, where instanced crowns stand on it, and darkens: it fills the
 *   gaps between crowns. Beyond `range` − `fade` it flattens back onto the
 *   ground, where the terrain's canopy shading takes over.
 * - **Color.** Each face takes the stand at its center: conifer, broadleaf or
 *   rainforest canopy from Part I's palette times the stand's shade, with
 *   autumn, bare winter crowns and snow as the trees have. Seen from below, the
 *   sheet is the dark underside of the crowns.
 */
import { DoubleSide, MeshBasicNodeMaterial } from 'three/webgpu';
import type { Mesh, Node } from 'three/webgpu';
import {
  attribute,
  clamp,
  Discard,
  dot,
  float,
  Fn,
  fwidth,
  If,
  length,
  max,
  mix,
  modelWorldMatrix,
  normalize,
  positionLocal,
  positionWorld,
  select,
  smoothstep,
  uniform,
  varyingProperty,
  vec4,
  vertexIndex,
} from 'three/tsl';
import { Vector4 } from 'three/webgpu';
import { CANOPY_THRESHOLD, EDGE_RISE } from '../../../worldgen/canopy';
import { FALL, foliage, leafless } from './foliage';
import { LAPSE_RATE } from '../../../worldgen/climate';
import { sharesNode, standNode, standTopNode } from '../../common/canopyNode';
import type { ClimateTexture } from '../../common/climateTexture';
import { earthElevationNode } from '../../common/seasons';
import type { LightShading, RoadShading } from '../infra/roadShading';
import { ruralSpeckle } from '../infra/roadShading';
import type { PlanetLighting } from '../lighting/planetLighting';
import { FaceSampler, tileGridCoordinate } from '../terrain/faceShading';
import { facetNormal } from '../terrain/facets';
import type { LandShading } from '../terrain/landShading';

type F = Node<'float'>;
type U = Node<'uint'>;
type V3 = Node<'vec3'>;

/** Settings shared by the shell's materials, so GUI changes survive world changes. */
export class CanopyStyle {
  /** 0 hides the shell. */
  readonly enabled = uniform(1);
  /** Shell drawn within this distance of the camera (m), flattening over the last `fade`. */
  readonly range = uniform(12_000);
  readonly fade = uniform(3_000);
  /** Within this distance the shell is the understory under instanced crowns (0: none). */
  readonly nearRadius = uniform(0);
  /** The understory's height as a share of H. */
  readonly understory = uniform(0.6);
  /** Lanes along roads and runways: this far beyond the pavement's edge (m). */
  readonly roadMargin = uniform(6);
  /** The world's canopy seed (`canopySeed`). */
  readonly seed = uniform(0, 'uint');
}

export interface CanopyShellDeps {
  style: CanopyStyle;
  exaggeration: F;
  radius: number;
  reliefScale: F;
  lighting: PlanetLighting;
  climate: ClimateTexture;
  land: LandShading;
  roads: RoadShading;
  lights: LightShading;
}

const objectUniform = (key: string) =>
  uniform(0).onObjectUpdate(
    ({ object }) => ((object as Mesh | undefined)?.userData[key] as number | undefined) ?? 0,
  );

const NO_TILE = new Vector4(-1, 0, 0, 0);

/** The shell's material: draws a terrain tile's geometry (tileMesh.ts attributes) as canopy. */
export function canopyShellMaterial(d: CanopyShellDeps): MeshBasicNodeMaterial {
  const { style, exaggeration, radius, lighting: L, land } = d;
  const m = new MeshBasicNodeMaterial({ side: DoubleSide });
  const morph = uniform(1).onObjectUpdate(
    ({ object }) => ((object as Mesh | undefined)?.userData.morph as number | undefined) ?? 1,
  );
  const tile = uniform(new Vector4()).onObjectUpdate(
    ({ object }) => ((object as Mesh | undefined)?.userData.tile as Vector4 | undefined) ?? NO_TILE,
  );
  const up = attribute('up', 'vec3');
  const surface = attribute('surface', 'vec4');
  const rawHeight = surface.x;
  const seed = style.seed as unknown as U;

  const grid = varyingProperty('vec3', 'vShellGrid');
  const rise = varyingProperty('float', 'vShellRise');
  const lifted = varyingProperty('float', 'vShellLift');
  const apInscatter = varyingProperty('vec3', 'vShellInscatter');
  const apTransmittance = varyingProperty('vec3', 'vShellTransmittance');

  /** Annual mean temperature (°C) at a height and direction, lapse-corrected as the terrain's. */
  const meanTemperature = (climate: Node<'vec4'>, height: F) =>
    climate.x.sub(earthElevationNode(height, climate.w, d.reliefScale).mul(LAPSE_RATE)) as F;

  m.positionNode = Fn(() => {
    const shown = max(rawHeight.add(max(surface.y, 0)), 0);
    const own = positionLocal.add(up.mul(shown.mul(exaggeration)));
    const parent = attribute('parentBase', 'vec3').add(
      attribute('parentDisp', 'vec3').mul(exaggeration),
    );
    const ground = mix(parent, own, morph);
    grid.assign(tileGridCoordinate(vertexIndex));
    const radial = normalize(up);
    const sea = radial.mul(radius) as V3;
    const climate = d.climate.sample(radial as V3);
    const shares = sharesNode(meanTemperature(climate, rawHeight));
    const stand = standNode(sea, shares.conifer, shares.tropical, seed);
    const top = standTopNode(stand, sea, seed);
    // The shell rises from the ground to the canopy inside the forest (decisions 153, 157):
    // on the least density around the vertex, so a vertex next to open ground stays on the
    // ground and the slope lies a cell inside the edge, behind the edge trees.
    const inner = attribute('canopyEdge', 'float');
    const lift = smoothstep(CANOPY_THRESHOLD, CANOPY_THRESHOLD + EDGE_RISE, inner);
    const dist = length(modelWorldMatrix.mul(vec4(ground, 1)).xyz);
    // 0 within the understory's reach, 1 beyond it.
    const near = max(style.nearRadius, 1);
    const outer = select(
      style.nearRadius.greaterThan(0),
      smoothstep(near.mul(0.7), near, dist),
      float(1),
    );
    const far = smoothstep(style.range, style.range.sub(style.fade), dist);
    const share = mix(style.understory, float(1), outer);
    rise.assign(outer);
    lifted.assign(lift);
    const h = top.mul(lift).mul(share).mul(far).mul(style.enabled);
    const p = ground.add(radial.mul(h));
    const ap = L.atmosphere.aerialPerspective(modelWorldMatrix.mul(vec4(p, 1)).xyz as V3);
    apInscatter.assign(ap.inscatter);
    apTransmittance.assign(ap.transmittance);
    return p;
  })();

  const roadStart = objectUniform('roadStart');
  const roadCount = objectUniform('roadCount');
  const lightStart = objectUniform('lightStart');
  const lightCount = objectUniform('lightCount');

  m.colorNode = Fn(() => {
    // Derivatives first, in uniform control flow (decision 69).
    const footprint = length(fwidth(positionWorld)).toVar();
    const radial = normalize(up).toVar();
    const normal = facetNormal(positionWorld, radial as V3, radial as V3, land.facets).toVar();
    const face = new FaceSampler(grid, tile, morph, radius, land.facets);
    const faceUp = normalize(face.at(up)).toVar();
    const faceHeight = face.at(rawHeight).toVar();
    const planet = L.planetPosition(positionWorld);

    // The edge: the shell slopes down to the ground on the triangles that straddle the
    // forest's contour and ends where it meets it (decision 157). Cutting on the density
    // instead left it hanging at half height where the density falls steeply, which is
    // most edges. Lanes along roads and through towns.
    If(lifted.lessThan(0.04).or(style.enabled.lessThan(0.5)), () => {
      Discard();
    });
    const lane = d.roads.clearance(planet, roadStart, roadCount, style.roadMargin);
    const built = d.lights.sample(
      planet,
      lightStart,
      lightCount,
      footprint,
      ruralSpeckle(planet, 2000),
    );
    If(lane.greaterThan(0.5).or(built.x.add(built.y).greaterThan(0.3)), () => {
      Discard();
    });

    // The stand at the face's center.
    const climate = d.climate.sample(faceUp as V3);
    const meanT = meanTemperature(climate, faceHeight as F);
    const shares = sharesNode(meanT);
    const stand = standNode(faceUp.mul(radius) as V3, shares.conifer, shares.tropical, seed);
    const conifer = stand.y;
    const canopy = mix(
      mix(land.broadleafCanopy, land.coniferCanopy, conifer),
      land.rainforestCanopy,
      shares.tropical,
    ).mul(stand.z);
    // Deeper in the understory, darker; seen from below, the crowns' shaded undersides.
    const view = normalize(positionWorld).negate();
    const below = dot(normal, view).lessThan(0);
    let albedo: V3 = canopy.mul(mix(float(0.7), float(1), rise)) as V3;
    albedo = select(below, albedo.mul(0.45), albedo) as V3;
    // Seasons as on the trees (decisions 43, 153): broadleaf stands turn yellow, orange or
    // red by stand, then brown, then leafless twigs with the ground's snow showing through.
    const t = land.surfaceTemperature(climate, faceHeight as F, faceUp as V3);
    const deciduous = float(1).sub(conifer).mul(float(1).sub(shares.tropical));
    const turned = foliage(albedo, t as F, stand.w as F);
    albedo = mix(albedo, turned, deciduous) as V3;
    const bare = leafless(t as F).mul(deciduous);
    const groundSnow = land.snowCover(t, float(0) as F, climate.z as F, face.jitter, float(1) as F);
    const twigs = mix(FALL.twigs.mul(stand.z), land.snowColor, groundSnow.mul(0.5));
    albedo = mix(albedo, select(below, twigs.mul(0.6), twigs), bare) as V3;
    // Snow where the ground has it (cold and wet enough, decided per face as on the
    // ground), on upward faces, less on conifers.
    const snow = land
      .snowCover(t, float(0) as F, climate.z as F, face.jitter, float(1) as F)
      .mul(clamp(dot(normal, radial).mul(1.5).sub(0.3), 0, 1))
      .mul(mix(float(0.8), float(0.45), conifer))
      .mul(float(1).sub(bare));
    albedo = land.wet(albedo);
    albedo = mix(albedo, land.snowColor, snow) as V3;
    const lit = L.shadeDiffuse(albedo, normal as V3, positionWorld as V3);
    return L.applyAerial(lit, apInscatter as V3, apTransmittance as V3);
  })();
  return m;
}
