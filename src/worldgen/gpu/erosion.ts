/**
 * Stage: hydraulic (stream-power) and thermal erosion on the global grid
 * (design doc, pipeline step 4; decision 23).
 *
 * First, closed depressions are filled to `prefill` of their depth (sediment-
 * filled basins). Then each iteration, all in Earth-like reference meters so
 * the tuning does not depend on reliefScale:
 *  1. Every `fillEvery` iterations, refresh the depression-filled routing
 *     surface W with Planchon–Darboux passes, W = max(h, min_nb W + ε). The
 *     first fill starts from W = ∞ on land and converges in about one pass
 *     per cell of drainage path; later fills warm-start from the previous W,
 *     which stays at or above the new fixed point as erosion lowers spills.
 *     (Starting below the fixed point would creep up by ε per pass on flats.)
 *     W is used only for routing: closed basins keep their low terrain
 *     (lakes) but still pass their flow on through the outlet.
 *  2. Receivers: steepest descent on W over the 8 seam-aware neighbors.
 *  3. Drainage: `flowPasses` Jacobi passes of A_i = a_i·P_i + Σ donors A_j,
 *     gathered (no atomics). Drainage converges along with the erosion, as in
 *     Schott et al. 2023.
 *  4. Incision: implicit stream power (Braun & Willett 2013, Jacobi form),
 *     h' = (h + U + F·h_r) / (1 + F) with F = K·dt·A^m / L. A cell is never
 *     cut below its receiver. The uplift U rebounds toward the pre-erosion
 *     height (depression-filled, so it does not restore noise pits), so valleys deepen in proportion to drainage while ridges hold,
 *     and closed hollows below W slowly fill with sediment.
 *     Plus linear hillslope diffusion on land.
 *  5. Thermal: symmetric pairwise exchange wherever the slope between two
 *     neighbors exceeds the talus angle. Conserves material and is race-free.
 *
 * Ocean cells (h ≤ 0) are base level and do not erode by flow. Land never
 * erodes below a small height above sea level, so coastlines stay put.
 *
 * Landforms (decision 121): back in physical meters, relief above the local
 * valley floor keeps Earth's proportions instead of shrinking with the planet.
 * The valley floor V is the eroded height's minimum within LANDFORM.radius,
 * smoothed; on land h_phys = (h + (gain − 1) · blur(h − V)) · reliefScale,
 * the relief above the floor blurred over a few cells (LANDFORM.smoothing).
 * The coast and the broad valley floors stay where erosion left them; slopes
 * and ridges rise. A breach pass then lowers any cell the gain left above a
 * cell that drained into it, so the gain makes no new lakes. Drainage is
 * recomputed afterwards on the CPU, as always.
 *
 * Climate (decision 19) reads elevation as physical height ÷ reliefScale. The
 * landform excess is Earth-scaled, so it counts at its physical height: where
 * the grid has "seaLevelTemperature", it rises by LAPSE_RATE × the excess
 * (amplified − eroded, reference m) × (1 − reliefScale), and every reader of physical height ÷
 * reliefScale (biomes, treeline, snow and season in the shaders) then gets the
 * temperature of the Earth-like elevation without change. The correction
 * itself goes to map "landformExcess" (reference m), for rules that read
 * elevation directly (alpine biome). Landmass-scale height keeps decision
 * 14's scale.
 *
 * Maps on the grid: in "height" (physical m), "uplift" and "precipitation";
 * out "height" plus "flow" (drainage area, km² · m/yr of rain) and "receiver".
 */
import { CUBE_FACE_COUNT } from '../../core/coords';
import type { GlobalGrid } from './globalGrid';
import { LINEAR_ID_WGSL } from './gpuContext';
import { LAPSE_RATE } from '../climate';

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
  /**
   * Sediment infill of closed hollows: fraction of the gap to the routing
   * surface W filled per iteration (0.0008 fills about 60 % over 1,200
   * iterations). Noise leaves many small pits; real land has few such lakes.
   */
  infill: 0.0008,
  /**
   * Before erosion, fill every closed depression to this fraction of its
   * depth: intermontane basins full of sediment. Detail noise leaves about
   * 15 % of the land in closed hollows; only the deepest stay lakes.
   */
  prefill: 0.85,
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
  chunk: 5,
};

export type ErosionTuning = typeof EROSION_TUNING;

/**
 * Landform relief (decision 121): the gain on relief above the local valley
 * floor, and the radius (m) over which the floor is the lowest ground, about
 * half the 40 km wavelength that splits landforms (hills, valleys, ridges)
 * from landmasses (ranges, plateaus, continents).
 */
export const LANDFORM = {
  gain: 12,
  radius: 20_000,
  /**
   * Blur passes on the relief above the floor before the gain: the stepwise
   * descent of a channel across the grid is not magnified into terraces, and
   * valleys narrower than a few cells keep their eroded depth.
   */
  smoothing: 2,
  /**
   * Breach passes after the gain, and the drop (reference m) a cell keeps below
   * its donors: the blur raises narrow channels toward their banks, which made
   * closed hollows (9.5 % of the land became lakes); breaching cuts them open
   * downstream, as an overflow would.
   */
  breachPasses: 128,
  breachDrop: 0.05,
  /**
   * Physical height (m) above which land rises at `peakCompression` of the
   * rate, so the tallest massifs end near Earth's highest peaks (about 8 km)
   * rather than 11 km. Monotone, so drainage is unchanged.
   */
  peakSoftLimit: 6500,
  peakCompression: 0.4,
};

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));
const RCV_MASK = 0x0fffffff;

export interface ErosionOptions {
  reliefScale: number;
  radius: number;
  erosionStrength: number;
  tuning?: Partial<ErosionTuning>;
  /** Landform relief settings (decision 121); gain 1 leaves the eroded relief as it is. */
  landform?: Partial<typeof LANDFORM>;
  onProgress?: (fraction: number) => void;
}

/** Runs erosion in place on grid map "height". Resolves when the GPU has finished. */
export async function runErosion(grid: GlobalGrid, opts: ErosionOptions): Promise<void> {
  const t = { ...EROSION_TUNING, ...opts.tuning };
  const lf = { ...LANDFORM, ...opts.landform };
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
// Depth of a cell below the filled surface. W still at its "infinite" start
// (no path to the sea yet, e.g. a world with no ocean) counts as no hollow.
fn fillGap(w: f32, h: f32) -> f32 { return select(0.0, max(w - h, 0.0), w < 1.0e29); }
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
${main(
  // Planchon–Darboux converges quickly only from above: land starts "infinitely" high.
  '  h[id] = hPhys[id] / RELIEF;\n  w[id] = select(h[id], 1.0e30, h[id] > 0.0);\n  h0[id] = h[id];',
)}`);

  // Landform relief (decision 121): the valley floor V by a minimum filter, then a blur.
  const floorMin = gpu.kernel(`${head}
@group(0) @binding(0) var<storage, read> vIn: array<f32>;
@group(0) @binding(1) var<storage, read_write> vOut: array<f32>;
${main(`  var m = vIn[id];
  for (var k = 0; k < 8; k++) {
    let nb = neighbor(c, k);
    if (nb >= 0) { m = min(m, vIn[nb]); }
  }
  vOut[id] = m;`)}`);
  const floorBlur = gpu.kernel(`${head}
@group(0) @binding(0) var<storage, read> vIn: array<f32>;
@group(0) @binding(1) var<storage, read_write> vOut: array<f32>;
${main(`  var sum = 2.0 * vIn[id];
  var wsum = 2.0;
  for (var k = 0; k < 8; k++) {
    let nb = neighbor(c, k);
    if (nb >= 0) { sum += vIn[nb]; wsum += 1.0; }
  }
  vOut[id] = sum / wsum;`)}`);
  // Relief above the floor (0 at sea), then blurred by floorBlur, then the gain.
  const aboveFloor = gpu.kernel(`${head}
@group(0) @binding(0) var<storage, read> h: array<f32>;
@group(0) @binding(1) var<storage, read> valleyFloor: array<f32>;
@group(0) @binding(2) var<storage, read_write> above: array<f32>;
${main(`  let hc = h[id];
  above[id] = select(0.0, max(hc - min(valleyFloor[id], hc), 0.0), hc > 0.0);`)}`);
  const amplify = gpu.kernel(`${head}
@group(0) @binding(0) var<storage, read> h: array<f32>;
@group(0) @binding(1) var<storage, read> above: array<f32>;
@group(0) @binding(2) var<storage, read_write> hA: array<f32>;
${main(`  let hc = h[id];
  hA[id] = select(hc, hc + ${f(lf.gain - 1)} * above[id], hc > 0.0);`)}`);
  // Breach: where the eroded surface ran downhill from a donor to this cell, the
  // amplified one must too, so the gain makes no new hollows. A lowered cell may
  // now stand above its own receiver's level; later passes carry the cut on.
  // Erosion lakes, whose routing runs uphill over the spill, are left alone.
  const breach = gpu.kernel(`${head}
@group(0) @binding(0) var<storage, read> h: array<f32>;
@group(0) @binding(1) var<storage, read> rcv: array<u32>;
@group(0) @binding(2) var<storage, read> hIn: array<f32>;
@group(0) @binding(3) var<storage, read_write> hOut: array<f32>;
${main(`  let hc = h[id];
  var m = hIn[id];
  if (hc > 0.0) {
    for (var k = 0; k < 8; k++) {
      let nb = neighbor(c, k);
      if (nb < 0 || nb == c) { continue; }
      if ((rcv[nb] & RCV_MASK) == u32(c) && h[nb] > hc) { m = min(m, hIn[nb] - ${f(lf.breachDrop)}); }
    }
    m = max(m, hc);
  }
  hOut[id] = m;`)}`);
  const toPhys = gpu.kernel(`${head}
@group(0) @binding(0) var<storage, read> hA: array<f32>;
@group(0) @binding(1) var<storage, read_write> hPhys: array<f32>;
${main(`  var p = hA[id] * RELIEF;
  if (p > ${f(lf.peakSoftLimit)}) { p = ${f(lf.peakSoftLimit)} + (p - ${f(lf.peakSoftLimit)}) * ${f(lf.peakCompression)}; }
  hPhys[id] = p;`)}`);
  const climateCorrection = gpu.kernel(`${head}
@group(0) @binding(0) var<storage, read> h: array<f32>;
@group(0) @binding(1) var<storage, read> hPhys: array<f32>;
@group(0) @binding(2) var<storage, read_write> seaLevelT: array<f32>;
@group(0) @binding(3) var<storage, read_write> excess: array<f32>;
${main(`  let e = select(0.0, max(hPhys[id] / RELIEF - h[id], 0.0) * (1.0 - RELIEF), h[id] > 0.0);
  seaLevelT[id] += ${f(LAPSE_RATE)} * e;
  excess[id] = e;`)}`);

  const prefill = gpu.kernel(`${head}
@group(0) @binding(0) var<storage, read_write> h: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<f32>;
${main(`  let hc = h[id];
  if (hc > 0.0) { h[id] = hc + ${f(t.prefill)} * fillGap(w[id], hc); }`)}`);

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
@group(0) @binding(5) var<storage, read> w: array<f32>;
${main(`  let hc = hIn[id];
  if (hc <= 0.0) { hOut[id] = hc; return; }
  // Closed hollows below the routing surface fill with sediment.
  let u = ${f(t.rebound)} * max(h0[id] - hc, 0.0) + ${f(t.infill)} * fillGap(w[id], hc);
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
  for (let p = 0; p < initialPasses; p += 64) {
    fillPasses(Math.min(64, initialPasses - p));
    await gpu.finish();
  }
  // Rebound toward the filled surface, so it never recreates the noise's closed pits.
  gpu.copy(grid.get('erosion.w'), grid.get('erosion.h0'));
  gpu.dispatchLinear(prefill, [grid.get('erosion.h'), grid.get('erosion.w')], count);

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
        grid.get('erosion.w'),
      ],
      count,
    );
    gpu.dispatchLinear(thermal, [grid.get('erosion.h2'), grid.get('erosion.h')], count);
    if ((it + 1) % t.chunk === 0 || it === iterations - 1) {
      await gpu.finish();
      opts.onProgress?.((it + 1) / iterations);
    }
  }
  // The valley floor: the lowest ground within the landform radius, then smoothed.
  const floorCells = Math.max(1, Math.round(lf.radius / cellLength));
  gpu.copy(grid.get('erosion.h'), grid.get('erosion.w'));
  for (let p = 0; p < floorCells; p++) {
    gpu.dispatchLinear(floorMin, [grid.get('erosion.w'), grid.get('erosion.w2')], count);
    grid.swap('erosion.w', 'erosion.w2');
  }
  for (let p = 0; p < 2 * floorCells; p++) {
    gpu.dispatchLinear(floorBlur, [grid.get('erosion.w'), grid.get('erosion.w2')], count);
    grid.swap('erosion.w', 'erosion.w2');
  }
  gpu.dispatchLinear(
    aboveFloor,
    [grid.get('erosion.h'), grid.get('erosion.w'), grid.get('erosion.h0')],
    count,
  );
  for (let p = 0; p < lf.smoothing; p++) {
    gpu.dispatchLinear(floorBlur, [grid.get('erosion.h0'), grid.get('erosion.w2')], count);
    grid.swap('erosion.h0', 'erosion.w2');
  }
  // The amplified surface, in reference meters, into erosion.w (the floor is no longer needed).
  gpu.dispatchLinear(
    amplify,
    [grid.get('erosion.h'), grid.get('erosion.h0'), grid.get('erosion.w')],
    count,
  );
  for (let p = 0; p < lf.breachPasses; p++) {
    gpu.dispatchLinear(
      breach,
      [grid.get('erosion.h'), rcv, grid.get('erosion.w'), grid.get('erosion.w2')],
      count,
    );
    grid.swap('erosion.w', 'erosion.w2');
    if (p % 32 === 31) await gpu.finish();
  }
  gpu.dispatchLinear(toPhys, [grid.get('erosion.w'), hPhys], count);
  if (grid.has('seaLevelTemperature')) {
    gpu.dispatchLinear(
      climateCorrection,
      [grid.get('erosion.h'), hPhys, grid.get('seaLevelTemperature'), grid.map('landformExcess')],
      count,
    );
  }
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
