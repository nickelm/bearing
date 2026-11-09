/**
 * Stage: hydraulic (stream-power) and thermal erosion on the global grid
 * (design doc, pipeline step 4; decision 23).
 *
 * Each iteration, all in Earth-like reference meters so the tuning does not
 * depend on reliefScale:
 *  1. Every `fillEvery` iterations, refresh the depression-filled routing
 *     surface W with Planchon–Darboux passes, W = max(h, min_nb W + ε). The
 *     fixed point is unique, so passes can warm-start from the previous W.
 *     W is used only for routing: closed basins keep their low terrain
 *     (lakes) but still pass their flow on through the outlet.
 *  2. Receivers: steepest descent on W over the 8 seam-aware neighbors.
 *  3. Drainage: `flowPasses` Jacobi passes of A_i = a_i·P_i + Σ donors A_j,
 *     gathered (no atomics). Drainage converges along with the erosion, as in
 *     Schott et al. 2023.
 *  4. Incision: implicit stream power (Braun & Willett 2013, Jacobi form),
 *     h' = (h + U + F·h_r) / (1 + F) with F = K·dt·A^m / L. A cell is never
 *     cut below its receiver. The uplift U rebounds toward the pre-erosion
 *     height, so valleys deepen in proportion to drainage while ridges hold.
 *     Plus linear hillslope diffusion on land.
 *  5. Thermal: symmetric pairwise exchange wherever the slope between two
 *     neighbors exceeds the talus angle. Conserves material and is race-free.
 *
 * Ocean cells (h ≤ 0) are base level and do not erode by flow. Land never
 * erodes below a small height above sea level, so coastlines stay put.
 *
 * Maps on the grid: in "height" (physical m), "uplift" and "precipitation";
 * out "height" plus "flow" (drainage area, km² · m/yr of rain) and "receiver".
 */
import { CUBE_FACE_COUNT } from '../../core/coords';
import type { GlobalGrid } from './globalGrid';
import { LINEAR_ID_WGSL } from './gpuContext';

export const EROSION_TUNING = {
  /** Erosion iterations at erosionStrength 1. */
  iterations: 1200,
  /** Drainage-area exponent m in K·A^m·S (n = 1). */
  m: 0.45,
  /** K·dt in the incision factor F = K·dt·A^m / L, with A in km²·(m/yr) and L in m. */
  kdt: 4,
  flowPasses: 4,
  /** Hillslope diffusion: fraction of the gap to the 4-neighbor mean closed per iteration. */
  diffusion: 0.002,
  /**
   * Rebound toward the pre-erosion height: U = rebound · (h0 − h) per
   * iteration. Ridges, which drain little, stay near their tectonic height,
   * while valleys with large drainage cut down. This keeps the large-scale
   * relief (ranges, plateaus) without a separate rescale.
   */
  rebound: 0.001,
  /** Talus slope (rise over run, reference meters) for thermal erosion; tan 31°. */
  talus: 0.6,
  /** Fraction of the excess slope moved per neighbor pair per iteration (≤ 1/16 for stability). */
  thermalRate: 0.05,
  /** Planchon–Darboux gradient across filled flats (reference m per cell). */
  fillEpsilon: 0.02,
  fillEvery: 25,
  /** Fill passes per refresh (the first fill runs until it converges). */
  fillPasses: 48,
  /** Lowest reference height land may erode to (m). */
  minLand: 2,
  /** Iterations per GPU submission (keeps the browser responsive). */
  chunk: 25,
};

export type ErosionTuning = typeof EROSION_TUNING;

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));
const RCV_MASK = 0x0fffffff;

export interface ErosionOptions {
  reliefScale: number;
  radius: number;
  erosionStrength: number;
  tuning?: Partial<ErosionTuning>;
  onProgress?: (fraction: number) => void;
}

/** Runs erosion in place on grid map "height". Resolves when the GPU has finished. */
export async function runErosion(grid: GlobalGrid, opts: ErosionOptions): Promise<void> {
  const t = { ...EROSION_TUNING, ...opts.tuning };
  const gpu = grid.gpu;
  const n = grid.n;
  if (CUBE_FACE_COUNT * n * n > RCV_MASK) throw new RangeError(`Grid ${n} too large`);
  const cellLength = ((Math.PI / 2) * opts.radius) / n;
  const cellAreaKm2 = (4 * Math.PI * opts.radius * opts.radius) / grid.cellCount / 1e6;

  const head = /* wgsl */ `${grid.wgsl}${LINEAR_ID_WGSL}
const RELIEF: f32 = ${f(opts.reliefScale)};
const CELL_L: f32 = ${f(cellLength)};
const CELL_AREA: f32 = ${f(cellAreaKm2)};
const SQRT2: f32 = 1.41421356;
const RCV_MASK: u32 = ${RCV_MASK}u;
fn neighborDist(k: i32) -> f32 { return select(CELL_L, CELL_L * SQRT2, k >= 4); }
`;
  const main = (body: string) => /* wgsl */ `
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let id = linearId(gid, nwg);
  if (id >= CELL_COUNT) { return; }
  let c = i32(id);
${body}
}`;

  const toRef = gpu.kernel(`${head}
@group(0) @binding(0) var<storage, read> hPhys: array<f32>;
@group(0) @binding(1) var<storage, read_write> h: array<f32>;
@group(0) @binding(2) var<storage, read_write> w: array<f32>;
@group(0) @binding(3) var<storage, read_write> h0: array<f32>;
${main('  h[id] = hPhys[id] / RELIEF;\n  w[id] = h[id];\n  h0[id] = h[id];')}`);

  const toPhys = gpu.kernel(`${head}
@group(0) @binding(0) var<storage, read> h: array<f32>;
@group(0) @binding(1) var<storage, read_write> hPhys: array<f32>;
${main('  hPhys[id] = h[id] * RELIEF;')}`);

  const fill = gpu.kernel(`${head}
@group(0) @binding(0) var<storage, read> h: array<f32>;
@group(0) @binding(1) var<storage, read> wIn: array<f32>;
@group(0) @binding(2) var<storage, read_write> wOut: array<f32>;
${main(`  let hc = h[id];
  if (hc <= 0.0) { wOut[id] = hc; return; }
  var m = 3.4e38;
  for (var k = 0; k < 8; k++) {
    let nb = neighbor(c, k);
    if (nb >= 0) { m = min(m, wIn[nb]); }
  }
  wOut[id] = max(hc, m + ${f(t.fillEpsilon)});`)}`);

  const receivers = gpu.kernel(`${head}
@group(0) @binding(0) var<storage, read> h: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<f32>;
@group(0) @binding(2) var<storage, read_write> rcv: array<u32>;
${main(`  let wc = w[id];
  var best = u32(c);
  var bestK = 8u;
  var bestS = 0.0;
  if (h[id] > 0.0) {
    for (var k = 0; k < 8; k++) {
      let nb = neighbor(c, k);
      if (nb < 0) { continue; }
      let s = (wc - w[nb]) / neighborDist(k);
      if (s > bestS) { bestS = s; best = u32(nb); bestK = u32(k); }
    }
  }
  rcv[id] = best | (bestK << 28u);`)}`);

  const flow = gpu.kernel(`${head}
@group(0) @binding(0) var<storage, read> rcv: array<u32>;
@group(0) @binding(1) var<storage, read> rain: array<f32>;
@group(0) @binding(2) var<storage, read> aIn: array<f32>;
@group(0) @binding(3) var<storage, read_write> aOut: array<f32>;
${main(`  var a = CELL_AREA * max(rain[id], 0.0) / 1000.0;
  for (var k = 0; k < 8; k++) {
    let nb = neighbor(c, k);
    if (nb < 0) { continue; }
    if ((rcv[nb] & RCV_MASK) == u32(c) && nb != c) { a += aIn[nb]; }
  }
  aOut[id] = a;`)}`);

  const incise = gpu.kernel(`${head}
@group(0) @binding(0) var<storage, read> hIn: array<f32>;
@group(0) @binding(1) var<storage, read> rcv: array<u32>;
@group(0) @binding(2) var<storage, read> area: array<f32>;
@group(0) @binding(3) var<storage, read_write> hOut: array<f32>;
@group(0) @binding(4) var<storage, read> h0: array<f32>;
${main(`  let hc = hIn[id];
  if (hc <= 0.0) { hOut[id] = hc; return; }
  let u = ${f(t.rebound)} * max(h0[id] - hc, 0.0);
  var hn = hc + u;
  let r = rcv[id];
  let rc = r & RCV_MASK;
  if (rc != id) {
    let hr = hIn[rc];
    if (hc > hr) {
      let F = ${f(t.kdt)} * pow(max(area[id], 1e-6), ${f(t.m)}) / neighborDist(i32(r >> 28u));
      hn = (hc + u + F * hr) / (1.0 + F);
    }
  }
  var sum = 0.0;
  for (var k = 0; k < 4; k++) { sum += max(hIn[neighbor(c, k)], 0.0); }
  hn += ${f(t.diffusion)} * (0.25 * sum - hc);
  hOut[id] = max(hn, ${f(t.minLand)});`)}`);

  const thermal = gpu.kernel(`${head}
@group(0) @binding(0) var<storage, read> hIn: array<f32>;
@group(0) @binding(1) var<storage, read_write> hOut: array<f32>;
${main(`  let hc = hIn[id];
  var dh = 0.0;
  for (var k = 0; k < 8; k++) {
    let nb = neighbor(c, k);
    if (nb < 0) { continue; }
    let diff = hIn[nb] - hc;
    let excess = abs(diff) - ${f(t.talus)} * neighborDist(k);
    if (excess > 0.0) { dh += sign(diff) * ${f(t.thermalRate)} * excess; }
  }
  var hn = hc + dh;
  // Thermal creep must not turn land into sea or sea into land.
  if (hc > 0.0) { hn = max(hn, ${f(t.minLand)}); } else { hn = min(hn, 0.0); }
  hOut[id] = hn;`)}`);

  // Buffers.
  const hPhys = grid.get('height');
  const rain = grid.get('precipitation');
  for (const name of [
    'erosion.h',
    'erosion.h2',
    'erosion.h0',
    'erosion.w',
    'erosion.w2',
    'flow',
    'erosion.a2',
  ]) {
    grid.map(name);
  }
  const rcv = grid.map('receiver', 'u32');
  const count = grid.cellCount;

  gpu.dispatchLinear(
    toRef,
    [hPhys, grid.get('erosion.h'), grid.get('erosion.w'), grid.get('erosion.h0')],
    count,
  );
  // Ping-pong helpers keep the latest result in the first-named map.
  const fillPasses = (passes: number) => {
    for (let p = 0; p < passes; p++) {
      gpu.dispatchLinear(
        fill,
        [grid.get('erosion.h'), grid.get('erosion.w'), grid.get('erosion.w2')],
        count,
      );
      grid.swap('erosion.w', 'erosion.w2');
    }
  };
  // Initial fill: enough passes to cross the widest basin.
  const initialPasses = 2 * n;
  for (let p = 0; p < initialPasses; p += t.chunk * 4) {
    fillPasses(Math.min(t.chunk * 4, initialPasses - p));
    await gpu.finish();
  }

  const iterations = Math.max(0, Math.round(t.iterations * opts.erosionStrength));
  for (let it = 0; it < iterations; it++) {
    if (it > 0 && it % t.fillEvery === 0) fillPasses(t.fillPasses);
    gpu.dispatchLinear(receivers, [grid.get('erosion.h'), grid.get('erosion.w'), rcv], count);
    for (let p = 0; p < t.flowPasses; p++) {
      gpu.dispatchLinear(flow, [rcv, rain, grid.get('flow'), grid.get('erosion.a2')], count);
      grid.swap('flow', 'erosion.a2');
    }
    gpu.dispatchLinear(
      incise,
      [
        grid.get('erosion.h'),
        rcv,
        grid.get('flow'),
        grid.get('erosion.h2'),
        grid.get('erosion.h0'),
      ],
      count,
    );
    gpu.dispatchLinear(thermal, [grid.get('erosion.h2'), grid.get('erosion.h')], count);
    if ((it + 1) % t.chunk === 0 || it === iterations - 1) {
      await gpu.finish();
      opts.onProgress?.((it + 1) / iterations);
    }
  }
  gpu.dispatchLinear(toPhys, [grid.get('erosion.h'), hPhys], count);
  await gpu.finish();
  for (const name of [
    'erosion.h',
    'erosion.h2',
    'erosion.h0',
    'erosion.w',
    'erosion.w2',
    'erosion.a2',
  ]) {
    grid.release(name);
  }
}
