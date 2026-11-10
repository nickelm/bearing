/**
 * Briefing text generated from the cast (design, "Casting", step 6): the
 * theaters, the stakes in each and the first expected moves. Plain text with
 * one paragraph per theater, written for either side's player.
 */
import type { Point, StrategicGraph } from '../worldgen/strategic/graph';
import { pointLatLon, polylinePoint, surfaceDistance } from '../worldgen/strategic/graph';
import type { Cast, Theater } from './cast';
import type { NameGenerator } from './names';

const COMPASS = [
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
];

/** Compass direction of `to` as seen from `from`. */
export function compass(from: Readonly<Point>, to: Readonly<Point>): string {
  // Local east and north at `from` (+Y is the pole).
  let ex = from[2];
  const ey = 0;
  let ez = -from[0];
  const el = Math.hypot(ex, ey, ez);
  if (el < 1e-9) return to[1] < from[1] ? 'south' : 'north';
  ex /= el;
  ez /= el;
  const nx = from[1] * ez - from[2] * ey;
  const ny = from[2] * ex - from[0] * ez;
  const nz = from[0] * ey - from[1] * ex;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const east = dx * ex + dy * ey + dz * ez;
  const north = dx * nx + dy * ny + dz * nz;
  const bearing = Math.atan2(east, north);
  const k = Math.round(((bearing / (2 * Math.PI)) * 8 + 8) % 8) % 8;
  return COMPASS[k]!;
}

function km(m: number): string {
  return `${Math.round(m / 1e3).toLocaleString('en-US')} km`;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function latitude(p: Readonly<Point>): string {
  const lat = (pointLatLon(p).lat * 180) / Math.PI;
  return `${Math.abs(Math.round(lat))}° ${lat >= 0 ? 'N' : 'S'}`;
}

function frontParagraph(g: StrategicGraph, cast: Cast, t: Theater, names: NameGenerator): string {
  const f = g.fronts[t.front!]!;
  const node = g.nodes[f.node]!;
  const name = cast.nodeNames[f.node]!;
  const start = g.barrierLines[f.start]!;
  const pact = start.sides[f.forwardSide];
  const alliance = start.sides[f.forwardSide === 1 ? 0 : 1];
  const strongest = g.barrierLines[f.strongest]!;
  const mid = (pts: Float64Array) => polylinePoint(pts, Math.floor(pts.length / 6));
  const fallback =
    f.strongest !== f.start
      ? ` About ${km(surfaceDistance(mid(start.points), mid(strongest.points), g.radius))} behind it lies the strongest natural line on ${name}, where the defense can hold if the start line breaks.`
      : ' The start line is also the strongest natural line on the continent; there is no prepared position behind it.';
  const corridors = f.corridors.filter((c) => c.line === f.start);
  const thrust =
    corridors.length > 0
      ? `Expect Pact armored thrusts through ${corridors.length === 1 ? 'one weak sector' : `${corridors.length} weak sectors`} of the line (Operation ${names.operation()}), with close air support and interdiction of the roads behind them.`
      : 'The line has no obvious weak sector; expect a broad-front assault prepared by heavy interdiction.';
  return (
    `${t.name.toUpperCase()}. ${name} (${(node.area / 1e6).toFixed(1)} million km² around ${latitude(node.centroid)}) is split by the start line, ${km(start.length)} from coast to coast. ` +
    `The Pact holds the ${compass(alliance.centroid, pact.centroid)} (${pct(pact.fraction)} of the land, up to ${km(pact.depth)} deep) and attacks; ` +
    `the Alliance holds the ${compass(pact.centroid, alliance.centroid)} (${pct(alliance.fraction)}, up to ${km(alliance.depth)} deep).` +
    `${fallback} ${thrust}`
  );
}

function laneParagraph(g: StrategicGraph, cast: Cast, t: Theater): string {
  const lane = g.lanes[t.lane!]!;
  const rear = cast.nodeNames[t.nodes[0]!]!;
  const front = cast.nodeNames[t.nodes[1]!]!;
  const narrow = Number.isFinite(lane.minWidth) ? `, narrowing to ${km(lane.minWidth)}` : '';
  return (
    `${t.name.toUpperCase()}. Alliance convoys carry reinforcements and supplies ${km(lane.length)} from ${rear} to the defenders on ${front}${narrow}${lane.ice > 0.05 ? ', partly through sea ice' : ''}. ` +
    `If the lane is cut, the front starves. Expect Pact maritime bombers and reconnaissance to hunt the convoys from the first day, and Alliance escort and patrol aircraft to cover them.`
  );
}

function chokeParagraph(g: StrategicGraph, cast: Cast, t: Theater): string {
  const cp = g.chokepoints[t.chokepoint!]!;
  const lane = cast.theaters.find((x) => x.kind === 'sea-lane' && x.lane === t.lane);
  const laneName = lane ? `the ${lane.name}` : 'the sea lane';
  if (cp.kind === 'strait') {
    return (
      `${t.name.toUpperCase()}. A strait ${km(cp.width)} wide on ${laneName}. Whoever controls the air over it controls the convoys through it. ` +
      `Expect Pact strikes and mining sorties against the strait and Alliance patrols to keep it open.`
    );
  }
  return (
    `${t.name.toUpperCase()}. An island of ${Math.round(cp.islandArea / 1e6).toLocaleString('en-US')} km² with room for ${cp.airfields} airfield${cp.airfields === 1 ? '' : 's'}, ${km(cp.width)} from ${laneName}. ` +
    `The Alliance garrisons it; a forward airfield there covers the convoys. If the Pact seizes it, its aircraft can strike the lane from close range. Expect an early Pact airborne or amphibious attempt.`
  );
}

function islandParagraph(cast: Cast, t: Theater): string {
  const pact = t.nodes.filter(
    (id) =>
      cast.owners[id]!.kind === 'whole' && (cast.owners[id] as { side: string }).side === 'pact',
  );
  const alliance = t.nodes.filter((id) => !pact.includes(id));
  const list = (ids: number[]) => ids.map((id) => cast.nodeNames[id]).join(', ');
  return (
    `${t.name.toUpperCase()}. A war of islands: ${t.nodes.length} land groups lie within strike range of each other and no landmass is large enough for a front. ` +
    `The Pact assembles its armada around ${list(pact)}; the Alliance holds a dispersed network of island airfields on ${list(alliance)}. ` +
    `Expect Pact carrier and amphibious groups to move against the nearest Alliance islands, under cover of long-range strikes on their airfields.`
  );
}

function strategicParagraph(cast: Cast, t: Theater): string {
  const ind = (side: 'alliance' | 'pact') =>
    cast.regions.filter((r) => r.kind === 'industry' && r.side === side).length;
  return (
    `${t.name.toUpperCase()}. Both sides' industry and logistics are targets: ${ind('pact')} Pact and ${ind('alliance')} Alliance industrial regions feed the other theaters. ` +
    `Expect strategic bombers against factories and depots, and air defense belts around them.`
  );
}

export function writeBriefing(g: StrategicGraph, cast: Cast, names: NameGenerator): string {
  const largest = g.nodes.filter((n) => n.kind === 'landmass');
  const geography =
    largest.length === 0
      ? 'The world has no landmass larger than 2,000 km², only scattered islands.'
      : `The world has ${largest.length} landmass${largest.length === 1 ? '' : 'es'} larger than 2,000 km²; the largest, ${cast.nodeNames[0]}, covers ${(largest[0]!.area / 1e6).toFixed(1)} million km². ` +
        `${g.nodes.length - largest.length} archipelago${g.nodes.length - largest.length === 1 ? '' : 's'}, ${g.lanes.length} sea lane${g.lanes.length === 1 ? '' : 's'} and ${g.chokepoints.length} chokepoint${g.chokepoints.length === 1 ? '' : 's'} complete the map.`;
  const paragraphs = [geography];
  if (cast.theaters.length === 0) {
    paragraphs.push('The world supports no theater of war.');
    return paragraphs.join('\n\n');
  }
  paragraphs.push(
    `The war runs in ${cast.theaters.length} theater${cast.theaters.length === 1 ? '' : 's'}. The Pact attacks; the Alliance defends.`,
  );
  for (const t of cast.theaters) {
    switch (t.kind) {
      case 'continental-front':
        paragraphs.push(frontParagraph(g, cast, t, names));
        break;
      case 'sea-lane':
        paragraphs.push(laneParagraph(g, cast, t));
        break;
      case 'chokepoint':
        paragraphs.push(chokeParagraph(g, cast, t));
        break;
      case 'island-campaign':
        paragraphs.push(islandParagraph(cast, t));
        break;
      case 'strategic':
        paragraphs.push(strategicParagraph(cast, t));
        break;
    }
  }
  paragraphs.push(
    `Aircraft carry ${pct(cast.rangeFactor)} of their real fuel, so that strike aircraft reach the depth of the theaters without crossing the world in one sortie. ` +
      `The Alliance has room for ${cast.airbases.alliance} airbases, the Pact for ${cast.airbases.pact}.`,
  );
  return paragraphs.join('\n\n');
}
