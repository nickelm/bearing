/**
 * Parcels (proposal 0009, decision 263), after Vanegas, Kelly, Weber, Halatsch, Aliaga
 * and Müller, "Procedural Generation of Parcels in Urban Modeling" (Eurographics 2012),
 * oriented-bounding-box subdivision: a piece larger than the district's target area is
 * cut across the long axis of its smallest box, near the middle; a cut is kept only if
 * both halves keep street frontage (the block's own edges), else the other axis is
 * tried, else the piece stays whole. Every parcel thus fronts a street.
 */
import type { Rng } from '../../core/rng';
import { clipHalfPlane, minAreaBox, polyArea } from './geom';
import type { Poly } from './geom';

export interface RawParcel {
  polygon: Poly;
  frontage: [number, number, number, number];
}

/** Street frontage of a piece: its longest street edge, and the street edges' total length. */
function frontageOf(
  p: Poly,
  flags: number[],
): { edge: [number, number, number, number]; total: number } {
  const n = p.length / 2;
  let best = -1;
  let edge: [number, number, number, number] = [0, 0, 0, 0];
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (!flags[i]) continue;
    const j = (i + 1) % n;
    const l = Math.hypot(p[j * 2]! - p[i * 2]!, p[j * 2 + 1]! - p[i * 2 + 1]!);
    total += l;
    if (l > best) {
      best = l;
      edge = [p[i * 2]!, p[i * 2 + 1]!, p[j * 2]!, p[j * 2 + 1]!];
    }
  }
  return { edge, total };
}

export function subdivideBlock(
  block: Poly,
  targetArea: number,
  minFrontage: number,
  r: Rng,
  maxParcels = 400,
): RawParcel[] {
  const out: RawParcel[] = [];
  const stack: { p: Poly; f: number[] }[] = [
    { p: block, f: block.map(() => 1).slice(0, block.length / 2) },
  ];
  while (stack.length && out.length + stack.length < maxParcels) {
    const { p, f } = stack.pop()!;
    const area = polyArea(p);
    const fr = frontageOf(p, f);
    if (area <= targetArea * 1.4) {
      if (fr.total >= minFrontage) out.push({ polygon: p, frontage: fr.edge });
      continue;
    }
    const box = minAreaBox(p);
    const jitter = (r.nextFloat() - 0.5) * 0.2;
    let done = false;
    for (const across of [true, false]) {
      // Cut across the long axis (normal along it), or along it.
      const nx = across ? box.ux : -box.uy;
      const ny = across ? box.uy : box.ux;
      const half = across ? box.hu : box.hv;
      const ox = box.cx + nx * half * jitter;
      const oy = box.cy + ny * half * jitter;
      const a = clipHalfPlane(p, f, ox, oy, nx, ny, 0);
      const b = clipHalfPlane(p, f, ox, oy, -nx, -ny, 0);
      if (a.poly.length < 6 || b.poly.length < 6) continue;
      if (polyArea(a.poly) < targetArea * 0.3 || polyArea(b.poly) < targetArea * 0.3) continue;
      if (frontageOf(a.poly, a.flags).total < minFrontage) continue;
      if (frontageOf(b.poly, b.flags).total < minFrontage) continue;
      stack.push({ p: a.poly, f: a.flags }, { p: b.poly, f: b.flags });
      done = true;
      break;
    }
    if (!done && fr.total >= minFrontage) out.push({ polygon: p, frontage: fr.edge });
  }
  for (const s of stack) {
    const fr = frontageOf(s.p, s.f);
    if (fr.total >= minFrontage) out.push({ polygon: s.p, frontage: fr.edge });
  }
  return out;
}
