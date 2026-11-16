/**
 * Meander migration (decision 173, proposal 0005): large lowland rivers evolve
 * their bends in the manner of Howard and Knutson (1984), as the open-source
 * meanderpy implements it. Each node of the centerline moves sideways toward
 * its outer bank at a rate from the channel's curvature there and upstream:
 *
 *   R0(s) = W · C(s)
 *   R1(s) = Ω · R0(s) + Γ · Σₖ R0(s − k Δs) G(k Δs) / Σₖ G(k Δs),   G(ξ) = e^(−ξ / ℓ)
 *
 * with Ω = −1 and Γ = 2.5 (meanderpy's values), so bends grow, skew
 * downstream and migrate down the valley. When two parts of the channel come
 * within about a width of each other (a neck), the loop between them is cut
 * off and kept as an **oxbow**. The channel stays inside its floodplain (the
 * band around the valley axis the caller measures) and its two ends stay
 * where they are, so confluences and mouths do not move.
 *
 * The centerline is worked in a gnomonic plane at the polyline's middle (great
 * circles are straight lines in it; at 150 km from the center its scale is
 * off by 2%, irrelevant to a process measured in widths) and resampled every
 * iteration to a spacing of `spacing` widths. Each node carries its "valley
 * coordinate", the arc length along the original polyline it came from, so
 * width and water surface follow from the original points.
 *
 * Pure and deterministic: no random numbers; the initial bends come from the
 * caller (the procedural meander train, decision 126).
 */
import { Vec3d } from '../../core/vec3d';

export const MIGRATION_TUNING = {
  /** Rivers at least this wide (m) migrate; narrower lowland rivers keep the procedural train. */
  minWidth: 80,
  /** ...whose bed gradient over the polyline is below this (m/m). */
  maxGradient: 0.001,
  /**
   * The channel's room on either side of its original line, in widths: the measured
   * floodplain clamped to this range (the tile kernel's floodplain is 8 widths, and the
   * floodplain edit flattens the meander belt).
   */
  floodplainMin: 3,
  floodplainMax: 8,
  /** Node spacing, in widths. */
  spacing: 1.5,
  /** Iterations. */
  iterations: 300,
  /** Largest sideways move per iteration, in widths. */
  maxStep: 0.15,
  /** Migration coefficient: move per iteration = rate · R1 · W (clamped to maxStep). */
  rate: 0.25,
  omega: -1,
  gamma: 2.5,
  /** Decay length ℓ of the upstream weight, in widths; the sum runs over 5 ℓ. */
  decay: 0.8,
  /** Necks closer than this (widths) are cut off... */
  cutoff: 2,
  /** ...when the loop between them is at least this long (widths). */
  minLoop: 8,
  /** Migration fades in over this many widths from each end. */
  endTaper: 12,
  /** The channel keeps this many widths inside the floodplain's edge. */
  margin: 1,
  /** Largest number of nodes migrated per polyline (longer rivers are coarsened). */
  maxNodes: 6000,
};

export type MigrationTuning = typeof MIGRATION_TUNING;

export interface MigrationResult {
  /** The migrated centerline: [x, y, z, ...attributes] like the input. */
  line: number[][];
  /** Cut-off loops, each [x, y, z, ...attributes at the cut]. */
  oxbows: number[][][];
}

/**
 * Migrates a polyline of unit directions with attributes ([x, y, z, width,
 * ...]). `floodplain(u)` is the floodplain's half-width (m) at valley
 * coordinate u (m along the input polyline); `axis` is the input polyline,
 * whose distance confines the channel.
 */
export function migrate(
  pts: readonly number[][],
  radius: number,
  floodplain: (u: number) => number,
  t: MigrationTuning = MIGRATION_TUNING,
): MigrationResult {
  const n0 = pts.length;
  if (n0 < 3) return { line: pts.map((p) => [...p]), oxbows: [] };
  // Gnomonic plane at the middle point.
  const c = new Vec3d(pts[n0 >> 1]![0]!, pts[n0 >> 1]![1]!, pts[n0 >> 1]![2]!).normalize();
  const east = new Vec3d(0, 1, 0).cross(c);
  if (east.length() < 1e-9) east.set(1, 0, 0);
  east.normalize();
  const north = c.clone().cross(east);
  const toPlane = (p: readonly number[]): [number, number] => {
    const k = p[0]! * c.x + p[1]! * c.y + p[2]! * c.z;
    const x = p[0]! / k;
    const y = p[1]! / k;
    const z = p[2]! / k;
    return [
      (x * east.x + y * east.y + z * east.z) * radius,
      (x * north.x + y * north.y + z * north.z) * radius,
    ];
  };
  const fromPlane = (x: number, y: number): [number, number, number] => {
    const px = c.x + (x * east.x + y * north.x) / radius;
    const py = c.y + (x * east.y + y * north.y) / radius;
    const pz = c.z + (x * east.z + y * north.z) / radius;
    const l = Math.hypot(px, py, pz);
    return [px / l, py / l, pz / l];
  };
  // The valley axis: the input in the plane, with its arc lengths.
  const ax = new Float64Array(n0);
  const ay = new Float64Array(n0);
  const au = new Float64Array(n0);
  for (let i = 0; i < n0; i++) {
    [ax[i], ay[i]] = toPlane(pts[i]!);
    if (i > 0) au[i] = au[i - 1]! + Math.hypot(ax[i]! - ax[i - 1]!, ay[i]! - ay[i - 1]!);
  }
  const L = au[n0 - 1]!;
  const attrAt = (u: number): number[] => {
    let lo = 0;
    let hi = n0 - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (au[m]! <= u) lo = m;
      else hi = m;
    }
    const f = au[hi]! > au[lo]! ? Math.min(1, Math.max(0, (u - au[lo]!) / (au[hi]! - au[lo]!))) : 0;
    return pts[lo]!.slice(3).map((v, k) => v + (pts[hi]![3 + k]! - v) * f);
  };
  let meanW = 0;
  for (const p of pts) meanW += p[3]!;
  meanW /= n0;
  const W = Math.max(meanW, 1);
  const ds = Math.max(t.spacing * W, L / t.maxNodes);
  /**
   * Nearest point on the valley axis to (x, y), among the axis segments within
   * `reach` m of valley coordinate u (a node's own coordinate locates it).
   */
  const nearestAxis = (x: number, y: number, u: number, reach: number) => {
    let lo = 0;
    let hi = n0 - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (au[m]! <= u - reach) lo = m;
      else hi = m;
    }
    let best = Infinity;
    let bx = 0;
    let by = 0;
    let bu = 0;
    for (let i = lo; i + 1 < n0 && au[i]! <= u + reach; i++) {
      const sx = ax[i + 1]! - ax[i]!;
      const sy = ay[i + 1]! - ay[i]!;
      const l2 = sx * sx + sy * sy;
      const f = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax[i]!) * sx + (y - ay[i]!) * sy) / l2)) : 0;
      const qx = ax[i]! + f * sx;
      const qy = ay[i]! + f * sy;
      const d = Math.hypot(x - qx, y - qy);
      if (d < best) {
        best = d;
        bx = qx;
        by = qy;
        bu = au[i]! + f * Math.sqrt(l2);
      }
    }
    return { d: best, x: bx, y: by, u: bu };
  };

  /** The axis point at valley coordinate u. */
  const axisAt = (u: number): [number, number] => {
    let lo = 0;
    let hi = n0 - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (au[m]! <= u) lo = m;
      else hi = m;
    }
    const f = au[hi]! > au[lo]! ? Math.min(1, Math.max(0, (u - au[lo]!) / (au[hi]! - au[lo]!))) : 0;
    return [ax[lo]! + (ax[hi]! - ax[lo]!) * f, ay[lo]! + (ay[hi]! - ay[lo]!) * f];
  };

  // The channel: positions and valley coordinates in typed buffers, resampled to ds
  // every iteration (`m` nodes in use; the buffers grow as the channel lengthens).
  let cap = Math.max(16, Math.ceil((2 * L) / ds));
  let xs = new Float64Array(cap);
  let ys = new Float64Array(cap);
  let us = new Float64Array(cap);
  let m = 0;
  let sArc = new Float64Array(cap);
  let ox = new Float64Array(cap);
  let oy = new Float64Array(cap);
  let ou = new Float64Array(cap);
  const grow = (need: number) => {
    if (need <= cap) return;
    cap = Math.ceil(need * 1.5);
    const g = (a: Float64Array) => {
      const b = new Float64Array(cap);
      b.set(a.subarray(0, Math.min(a.length, cap)));
      return b;
    };
    xs = g(xs);
    ys = g(ys);
    us = g(us);
    ox = new Float64Array(cap);
    oy = new Float64Array(cap);
    ou = new Float64Array(cap);
  };
  /** Resamples (sx, sy, su)[0..count) to spacing ds into (xs, ys, us). */
  const resample = (sx: Float64Array, sy: Float64Array, su: Float64Array, count: number) => {
    // The arc lengths have their own buffer: `grow` below must not replace it mid-use.
    if (sArc.length < count) sArc = new Float64Array(Math.ceil(count * 1.5));
    sArc[0] = 0;
    for (let i = 1; i < count; i++)
      sArc[i] = sArc[i - 1]! + Math.hypot(sx[i]! - sx[i - 1]!, sy[i]! - sy[i - 1]!);
    const total = sArc[count - 1]!;
    const out = Math.max(2, Math.round(total / ds) + 1);
    grow(out);
    let j = 0;
    for (let k = 0; k < out; k++) {
      const sk = (k / (out - 1)) * total;
      while (j < count - 2 && sArc[j + 1]! < sk) j++;
      const span = sArc[j + 1]! - sArc[j]!;
      const f = span > 0 ? Math.min(1, Math.max(0, (sk - sArc[j]!) / span)) : 0;
      ox[k] = sx[j]! + (sx[j + 1]! - sx[j]!) * f;
      oy[k] = sy[j]! + (sy[j + 1]! - sy[j]!) * f;
      ou[k] = su[j]! + (su[j + 1]! - su[j]!) * f;
    }
    // Exact ends.
    ox[0] = sx[0]!;
    oy[0] = sy[0]!;
    ou[0] = su[0]!;
    ox[out - 1] = sx[count - 1]!;
    oy[out - 1] = sy[count - 1]!;
    ou[out - 1] = su[count - 1]!;
    // Swap the output into place.
    [xs, ox] = [ox, xs];
    [ys, oy] = [oy, ys];
    [us, ou] = [ou, us];
    m = out;
  };
  grow(n0);
  resample(ax, ay, au, n0);

  const K = Math.max(1, Math.ceil((5 * t.decay * W) / ds));
  const G = new Float64Array(K + 1);
  let gSum = 0;
  for (let k = 1; k <= K; k++) {
    G[k] = Math.exp((-k * ds) / (t.decay * W));
    gSum += G[k]!;
  }
  const oxbows: { x: number[]; y: number[]; u: number }[] = [];
  const taperLen = t.endTaper * W;
  const minGap = Math.ceil((t.minLoop * W) / ds);
  const neck = t.cutoff * W;
  let r0 = new Float64Array(cap);
  let nx = new Float64Array(cap);
  let ny = new Float64Array(cap);
  let mx = new Float64Array(cap);
  let my = new Float64Array(cap);
  for (let it = 0; it < t.iterations; it++) {
    if (m < 5) break;
    if (r0.length < cap) {
      r0 = new Float64Array(cap);
      nx = new Float64Array(cap);
      ny = new Float64Array(cap);
      mx = new Float64Array(cap);
      my = new Float64Array(cap);
    }
    // Curvature (positive turning left) and the right-hand normal.
    r0[0] = 0;
    r0[m - 1] = 0;
    for (let i = 1; i + 1 < m; i++) {
      const dx = (xs[i + 1]! - xs[i - 1]!) / 2;
      const dy = (ys[i + 1]! - ys[i - 1]!) / 2;
      const ddx = xs[i + 1]! - 2 * xs[i]! + xs[i - 1]!;
      const ddy = ys[i + 1]! - 2 * ys[i]! + ys[i - 1]!;
      const q = Math.hypot(dx, dy);
      if (q < 1e-9) {
        r0[i] = 0;
        nx[i] = 0;
        ny[i] = 0;
        continue;
      }
      r0[i] = (W * (dx * ddy - dy * ddx)) / (q * q * q);
      nx[i] = dy / q;
      ny[i] = -dx / q;
    }
    // Upstream-weighted rate, moved toward the outer bank.
    let s = 0;
    mx[0] = xs[0]!;
    my[0] = ys[0]!;
    for (let i = 1; i + 1 < m; i++) {
      s += Math.hypot(xs[i]! - xs[i - 1]!, ys[i]! - ys[i - 1]!);
      let conv = 0;
      let wsum = 0;
      for (let k = 1; k <= K && i - k >= 0; k++) {
        conv += r0[i - k]! * G[k]!;
        wsum += G[k]!;
      }
      const r1 = t.omega * r0[i]! + (t.gamma * conv) / Math.max(wsum, gSum * 1e-9);
      const e = Math.min(s, Math.max(0, (m - 1 - i) * ds)) / taperLen;
      const taper = e >= 1 ? 1 : e * e * (3 - 2 * e);
      const step = Math.max(-t.maxStep, Math.min(t.maxStep, t.rate * r1)) * W * taper;
      let x = xs[i]! + step * nx[i]!;
      let y = ys[i]! + step * ny[i]!;
      // Inside the floodplain: no farther from the valley axis than its half-width less a
      // margin. The axis point at the node's own valley coordinate bounds its distance to
      // the axis from above, so only nodes beyond the limit from it need the search.
      const own = axisAt(us[i]!);
      const fp = floodplain(us[i]!);
      if (Math.hypot(x - own[0], y - own[1]) > Math.max(0, fp - t.margin * W)) {
        const a = nearestAxis(x, y, us[i]!, Math.max(fp, W) + 20 * W);
        const limit = Math.max(0, floodplain(a.u) - t.margin * W);
        if (a.d > limit && a.d < Infinity) {
          x = a.x + ((x - a.x) * limit) / a.d;
          y = a.y + ((y - a.y) * limit) / a.d;
        }
      }
      mx[i] = x;
      my[i] = y;
    }
    mx[m - 1] = xs[m - 1]!;
    my[m - 1] = ys[m - 1]!;
    resample(mx, my, us.slice(0, m), m);
    // Cutoffs, every third iteration (and on the last): the first neck closer than
    // `cutoff` widths around a loop of at least `minLoop` widths, then the next.
    if (it % 3 !== 2 && it !== t.iterations - 1) continue;
    for (let guard = 0; guard < 50; guard++) {
      const hash = new Map<number, number[]>();
      const hk = (gx: number, gy: number) => gx * 2654435761 + gy;
      for (let i = 0; i < m; i++) {
        const k = hk(Math.floor(xs[i]! / neck), Math.floor(ys[i]! / neck));
        let l = hash.get(k);
        if (!l) hash.set(k, (l = []));
        l.push(i);
      }
      let ci = -1;
      let cj = -1;
      for (let i = 0; i < m && ci < 0; i++) {
        const gx = Math.floor(xs[i]! / neck);
        const gy = Math.floor(ys[i]! / neck);
        for (let dx = -1; dx <= 1 && ci < 0; dx++)
          for (let dy = -1; dy <= 1 && ci < 0; dy++)
            for (const j of hash.get(hk(gx + dx, gy + dy)) ?? []) {
              if (j - i < minGap) continue;
              if (Math.hypot(xs[j]! - xs[i]!, ys[j]! - ys[i]!) < neck) {
                ci = i;
                cj = j;
                break;
              }
            }
      }
      if (ci < 0) break;
      oxbows.push({
        x: Array.from(xs.subarray(ci, cj + 1)),
        y: Array.from(ys.subarray(ci, cj + 1)),
        u: us[ci]!,
      });
      // Remove the loop's interior and resample the joined channel.
      const keep = m - (cj - ci - 1);
      const kx = new Float64Array(keep);
      const ky = new Float64Array(keep);
      const ku = new Float64Array(keep);
      kx.set(xs.subarray(0, ci + 1));
      ky.set(ys.subarray(0, ci + 1));
      ku.set(us.subarray(0, ci + 1));
      kx.set(xs.subarray(cj, m), ci + 1);
      ky.set(ys.subarray(cj, m), ci + 1);
      ku.set(us.subarray(cj, m), ci + 1);
      resample(kx, ky, ku, keep);
    }
  }
  // Back on the sphere, ends exactly as given.
  const line: number[][] = [];
  for (let i = 0; i < m; i++) line.push([...fromPlane(xs[i]!, ys[i]!), ...attrAt(us[i]!)]);
  line[0] = [...pts[0]!];
  line[line.length - 1] = [...pts[n0 - 1]!];
  return {
    line,
    oxbows: oxbows.map((o) => {
      const at = attrAt(o.u);
      return o.x.map((x, i) => [...fromPlane(x, o.y[i]!), ...at]);
    }),
  };
}

/** Channel length over the straight distance between the ends of a planar polyline. */
export function sinuosityOf(line: readonly number[][], radius: number): number {
  let len = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    len += Math.acos(Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!)) * radius;
  }
  const a = line[0]!;
  const b = line[line.length - 1]!;
  const chord = Math.acos(Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!)) * radius;
  return chord > 0 ? len / chord : 1;
}
