/**
 * The Kestrel's lockstep scenarios as charts (track H, decision 154): each
 * scenario of tests/helpers/lockstep.ts flown again with its path over the
 * runway, its height above the ground, its airspeed, and its pitch and bank,
 * with the monitor's events marked. One page, `tools/out/lockstep.html`.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/lockstep.preview.ts
 *
 * `ONLY=circuit,hill` limits it to some scenarios.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { KNOT } from '../src/core/units';
import { runwayFrame, toRunway } from '../src/sim/flight/runway';
import type { FlightEvent } from '../src/sim/flight/outcomes';
import { RADIUS, testRunway } from '../tests/helpers/flight';
import { LIB, runScenario, SCENARIOS } from '../tests/helpers/lockstep';
import type { ScenarioName } from '../tests/helpers/lockstep';

const NOTES: Record<ScenarioName, string> = {
  circuit:
    'The scripted test pilot: takeoff in afterburner, a 1,000 m circuit, approach, flare, touchdown and rollout to a stop.',
  maneuvers:
    'An air start at 7 km, then random full-range stick, pedal, throttle, speedbrake and gear inputs every quarter second for 150 s, pulling up when low.',
  'stand-and-taxi':
    'Parking brake at military power, then idle, then a slow taxi with the pedals and differential braking to a stop.',
  'crosswind-roll':
    'Full power in a 7 m/s crosswind with gusts, a pedal tap at 8 s, rotation at 150 kt, gear up at 30 s.',
  'gear-up':
    'A shallow idle descent from 150 m with the gear up, onto the runway: a belly landing.',
  'hard-landing': 'A push at idle from 60 m with the gear down, sinking at about 7 m/s or more.',
  ditching: 'A descent with the gear down past the runway into the water beyond 6 km.',
  hill: 'Straight and level at 300 m into a 600 m hill on the extended centerline.',
  respawn:
    'A gusty crosswind roll, a crash at 10 s, then a new spawn on the other end of the same model and a second roll.',
  'tail-slide':
    'Straight up at 120 m/s at idle with the stick let go: the aircraft stops, slides back and noses over.',
  'mouse-aim':
    'The flight director flies toward a new random direction every 4 s, as mouse aim drives it.',
  'free-pedal-roll':
    'A takeoff roll in a gusty crosswind with the pedals never touched: the track hold keeps it straight.',
  'belly-ditching': 'A glide with the gear up into the water: the fuselage, not a wheel, finds it.',
  excursion:
    'Military power with a pedal held from 6 s in a crosswind: off the side of the runway.',
  'stand-gale':
    'Parked with the brake set at military power, then a side wind rising from 15 to 60 m/s.',
};

interface Series {
  name: ScenarioName;
  note: string;
  crashed: string | null;
  seconds: number;
  /** Per sample: t (s), along, across, height above ground (m), CAS (kt), pitch, bank (deg). */
  rows: number[][];
  events: { t: number; label: string }[];
}

function label(e: FlightEvent): string {
  switch (e.kind) {
    case 'touchdown':
      return `Touchdown ${e.touchdown.sinkRate.toFixed(1)} m/s (${e.touchdown.grade})`;
    case 'crash':
      return `Crash: ${e.reason}`;
    case 'liftoff':
      return 'Liftoff';
    case 'stopped':
      return 'Stopped';
  }
}

function eventTime(e: FlightEvent): number {
  return e.kind === 'touchdown' ? e.touchdown.time : e.time;
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

test('lockstep scenario charts', () => {
  const only = process.env.ONLY?.split(',').map((s) => s.trim());
  const runway = testRunway();
  const frame = runwayFrame(runway);
  const out: Series[] = [];
  for (const name of SCENARIOS) {
    if (only && !only.includes(name)) continue;
    const rows: number[][] = [];
    const events: Series['events'] = [];
    let t0 = -1;
    const d = runScenario(name, LIB, (m, i, evs) => {
      if (t0 < 0) t0 = m.time - (i + 1) / 120;
      for (const e of evs) {
        const t = round(eventTime(e) - t0, 2);
        // The monitor reports an air start as a liftoff half a second in.
        events.push({ t, label: e.kind === 'liftoff' && t < 1 ? 'Air start' : label(e) });
      }
      if (i % 12 !== 0 && evs.length === 0 && !m.crashed) return;
      const c = toRunway(runway, frame, m.pos, RADIUS);
      const t = m.telemetry;
      rows.push([
        round(m.time - t0, 2),
        round(c.along, 1),
        round(c.across, 1),
        round(t.radarAltitude, 2),
        round(t.cas / KNOT, 1),
        round((t.pitch * 180) / Math.PI, 2),
        round((t.bank * 180) / Math.PI, 2),
      ]);
    });
    out.push({
      name,
      note: NOTES[name],
      crashed: d.crashed,
      seconds: round(d.steps / 120, 1),
      rows,
      events,
    });
    console.log(`${name}: ${d.steps} steps, ${d.crashed ?? 'no crash'}`);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, 'out', 'lockstep.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, page(out, runway.length));
  console.log(`wrote ${file}`);
});

function page(data: Series[], runwayLength: number): string {
  const json = JSON.stringify({ scenarios: data, runwayLength }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kestrel Lockstep Scenarios</title>
<style>
:root {
  color-scheme: light;
  --surface-0: #f4f3ef;
  --surface-1: #fcfcfb;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --text-muted: #7a7974;
  --grid: #e4e3de;
  --axis: #b9b8b1;
  --runway: #52514e;
  --series-1: #2a78d6;
  --series-2: #eb6834;
  --event: #9a9993;
  --critical: #c0332f;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --surface-0: #121211;
    --surface-1: #1a1a19;
    --text-primary: #f0efec;
    --text-secondary: #c3c2b7;
    --text-muted: #8f8e86;
    --grid: #2b2b29;
    --axis: #4a4945;
    --runway: #c3c2b7;
    --series-1: #3987e5;
    --series-2: #d95926;
    --event: #6d6c66;
    --critical: #e66767;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --surface-0: #121211;
  --surface-1: #1a1a19;
  --text-primary: #f0efec;
  --text-secondary: #c3c2b7;
  --text-muted: #8f8e86;
  --grid: #2b2b29;
  --axis: #4a4945;
  --runway: #c3c2b7;
  --series-1: #3987e5;
  --series-2: #d95926;
  --event: #6d6c66;
  --critical: #e66767;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface-0); color: var(--text-primary);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1240px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.lede { color: var(--text-secondary); margin: 0 0 20px; max-width: 70ch; }
nav { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 20px; }
nav a { color: var(--text-secondary); text-decoration: none; border: 1px solid var(--axis);
  border-radius: 999px; padding: 2px 10px; font-size: 13px; }
nav a:hover { color: var(--text-primary); }
section { background: var(--surface-1); border-radius: 10px; padding: 16px; margin-bottom: 20px; }
section h2 { font-size: 17px; margin: 0; }
.meta { color: var(--text-secondary); margin: 2px 0 10px; }
.outcome { font-weight: 600; }
.outcome.crash { color: var(--critical); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
figure { margin: 0; }
figcaption { font-size: 13px; color: var(--text-secondary); margin-bottom: 2px; }
svg { width: 100%; height: auto; display: block; overflow: visible; }
svg text { fill: var(--text-muted); font-size: 11px; }
.readout { font: 12px ui-monospace, Menlo, Consolas, monospace; color: var(--text-secondary);
  min-height: 1.5em; margin-top: 6px; }
.legend { display: inline-flex; gap: 12px; font-size: 12px; color: var(--text-secondary); margin-left: 8px; }
.swatch { display: inline-block; width: 12px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 4px; }
</style>
</head>
<body>
<main>
<h1>Kestrel lockstep scenarios</h1>
<p class="lede">The fifteen flights the lockstep test hashes after every step
(<code>tests/helpers/lockstep.ts</code>). Each card shows the path over the runway seen from above,
the height above the ground, the airspeed, and the pitch and bank. Dashed lines mark the outcomes
monitor's events. Hover a chart to read the values at a moment.</p>
<nav id="nav"></nav>
<div id="cards"></div>
</main>
<script>
const DATA = ${json};
const NS = 'http://www.w3.org/2000/svg';
const W = 360, H = 190, M = { l: 44, r: 10, t: 12, b: 26 };
function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function nice(lo, hi, n) {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 5, 10].map((f) => f * mag).find((s) => s >= step0);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}
function fmt(v) {
  const a = Math.abs(v);
  return a >= 10000 ? (v / 1000).toFixed(0) + 'k' : a >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v * 10) / 10);
}
function frame(svg, xs, ys, xLabel) {
  const sx = (x) => M.l + ((x - xs[0]) / (xs[1] - xs[0] || 1)) * (W - M.l - M.r);
  const sy = (y) => H - M.b - ((y - ys[0]) / (ys[1] - ys[0] || 1)) * (H - M.t - M.b);
  for (const v of nice(ys[0], ys[1], 4)) {
    el('line', { x1: M.l, x2: W - M.r, y1: sy(v), y2: sy(v), stroke: 'var(--grid)', 'stroke-width': 1 }, svg);
    el('text', { x: M.l - 6, y: sy(v) + 4, 'text-anchor': 'end' }, svg).textContent = fmt(v);
  }
  for (const v of nice(xs[0], xs[1], 5)) {
    el('text', { x: sx(v), y: H - M.b + 14, 'text-anchor': 'middle' }, svg).textContent = fmt(v);
  }
  el('line', { x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b, stroke: 'var(--axis)' }, svg);
  el('text', { x: W - M.r, y: H - 2, 'text-anchor': 'end' }, svg).textContent = xLabel;
  return { sx, sy };
}
function path(rows, sx, sy, xi, yi) {
  let d = '';
  rows.forEach((r, i) => { d += (i ? 'L' : 'M') + sx(r[xi]).toFixed(1) + ',' + sy(r[yi]).toFixed(1); });
  return d;
}
function range(rows, i, pad) {
  let lo = Infinity, hi = -Infinity;
  for (const r of rows) { lo = Math.min(lo, r[i]); hi = Math.max(hi, r[i]); }
  const p = (hi - lo) * pad || 1;
  return [lo - p, hi + p];
}
function card(s) {
  const sec = document.createElement('section');
  sec.id = s.name;
  const outcome = s.crashed ? 'Crash: ' + s.crashed : 'No crash';
  sec.innerHTML = '<h2>' + s.name + '</h2><p class="meta">' + s.note + ' <span class="outcome' +
    (s.crashed ? ' crash' : '') + '">' + outcome + '</span> after ' + s.seconds + ' s.</p>';
  const grid = document.createElement('div');
  grid.className = 'grid';
  sec.appendChild(grid);
  const readout = document.createElement('div');
  readout.className = 'readout';
  readout.textContent = 'Hover a chart.';
  const rows = s.rows;
  const cursors = [];
  function fig(title, extra) {
    const f = document.createElement('figure');
    const c = document.createElement('figcaption');
    c.textContent = title;
    if (extra) c.appendChild(extra);
    f.appendChild(c);
    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': s.name + ': ' + title });
    f.appendChild(svg);
    grid.appendChild(f);
    return svg;
  }
  // Top view: along (x) against across (y), at one scale.
  {
    const svg = fig('Path seen from above (m along and across the runway)');
    let xs = range(rows, 1, 0.05), ys = range(rows, 2, 0.05);
    xs = [Math.min(xs[0], -DATA.runwayLength / 2 - 200), Math.max(xs[1], DATA.runwayLength / 2 + 200)];
    const sxSpan = xs[1] - xs[0], sySpan = ys[1] - ys[0];
    const pxW = W - M.l - M.r, pxH = H - M.t - M.b;
    const scale = Math.max(sxSpan / pxW, sySpan / pxH);
    const cx = (xs[0] + xs[1]) / 2, cy = (ys[0] + ys[1]) / 2;
    xs = [cx - (scale * pxW) / 2, cx + (scale * pxW) / 2];
    ys = [cy - (scale * pxH) / 2, cy + (scale * pxH) / 2];
    const { sx, sy } = frame(svg, xs, ys, 'm along');
    el('line', { x1: sx(-DATA.runwayLength / 2), x2: sx(DATA.runwayLength / 2), y1: sy(0), y2: sy(0),
      stroke: 'var(--runway)', 'stroke-width': 4, 'stroke-linecap': 'round', opacity: 0.45 }, svg);
    el('path', { d: path(rows, sx, sy, 1, 2), fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2,
      'stroke-linejoin': 'round' }, svg);
    const a = rows[0], z = rows[rows.length - 1];
    el('circle', { cx: sx(a[1]), cy: sy(a[2]), r: 4, fill: 'var(--surface-1)', stroke: 'var(--series-1)', 'stroke-width': 2 }, svg);
    el('text', { x: sx(a[1]) + 7, y: sy(a[2]) - 6 }, svg).textContent = 'start';
    if (s.crashed) {
      const g = el('g', { stroke: 'var(--critical)', 'stroke-width': 2.5, 'stroke-linecap': 'round' }, svg);
      el('line', { x1: sx(z[1]) - 5, y1: sy(z[2]) - 5, x2: sx(z[1]) + 5, y2: sy(z[2]) + 5 }, g);
      el('line', { x1: sx(z[1]) - 5, y1: sy(z[2]) + 5, x2: sx(z[1]) + 5, y2: sy(z[2]) - 5 }, g);
    } else {
      el('circle', { cx: sx(z[1]), cy: sy(z[2]), r: 4, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2 }, svg);
    }
    const dot = el('circle', { r: 5, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden' }, svg);
    cursors.push((r) => {
      if (!r) return dot.setAttribute('visibility', 'hidden');
      dot.setAttribute('cx', sx(r[1])); dot.setAttribute('cy', sy(r[2])); dot.setAttribute('visibility', 'visible');
    });
  }
  const ts = [0, Math.max(rows[rows.length - 1][0], 1)];
  function timeChart(title, series, extra) {
    const svg = fig(title, extra);
    let lo = Infinity, hi = -Infinity;
    for (const [i] of series) { const r = range(rows, i, 0.08); lo = Math.min(lo, r[0]); hi = Math.max(hi, r[1]); }
    if (series.some(([i]) => i === 3)) lo = Math.min(lo, 0);
    const { sx, sy } = frame(svg, ts, [lo, hi], 's');
    s.events.forEach((e, k) => {
      el('line', { x1: sx(e.t), x2: sx(e.t), y1: M.t, y2: H - M.b, stroke: 'var(--event)', 'stroke-dasharray': '3 3' }, svg);
      const tt = el('title', {}, el('rect', { x: sx(e.t) - 4, y: M.t, width: 8, height: H - M.t - M.b, fill: 'transparent' }, svg));
      tt.textContent = e.t.toFixed(1) + ' s: ' + e.label;
      if (k >= 3) return;
      const right = sx(e.t) > M.l + 0.7 * (W - M.l - M.r);
      el('text', { x: sx(e.t) + (right ? -3 : 3), y: M.t + 9 + 11 * k, 'text-anchor': right ? 'end' : 'start' }, svg)
        .textContent = e.label.split(/[:(]| \\d/)[0].trim();
    });
    for (const [i, color] of series) {
      el('path', { d: path(rows, sx, sy, 0, i), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
    }
    const line = el('line', { y1: M.t, y2: H - M.b, stroke: 'var(--text-muted)', visibility: 'hidden' }, svg);
    const dots = series.map(([, color]) => el('circle', { r: 4, fill: color, stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden' }, svg));
    cursors.push((r) => {
      const v = r ? 'visible' : 'hidden';
      line.setAttribute('visibility', v);
      dots.forEach((d) => d.setAttribute('visibility', v));
      if (!r) return;
      line.setAttribute('x1', sx(r[0])); line.setAttribute('x2', sx(r[0]));
      series.forEach(([i], k) => { dots[k].setAttribute('cx', sx(r[0])); dots[k].setAttribute('cy', sy(r[i])); });
    });
    const hit = el('rect', { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', (ev) => {
      const box = svg.getBoundingClientRect();
      const x = ((ev.clientX - box.left) / box.width) * W;
      const t = ts[0] + ((x - M.l) / (W - M.l - M.r)) * (ts[1] - ts[0]);
      let lo2 = 0, hi2 = rows.length - 1;
      while (hi2 - lo2 > 1) { const mid = (lo2 + hi2) >> 1; if (rows[mid][0] < t) lo2 = mid; else hi2 = mid; }
      const r = Math.abs(rows[lo2][0] - t) < Math.abs(rows[hi2][0] - t) ? rows[lo2] : rows[hi2];
      cursors.forEach((c) => c(r));
      readout.textContent = 't ' + r[0].toFixed(1) + ' s   height ' + r[3].toFixed(1) + ' m   CAS ' +
        r[4].toFixed(0) + ' kt   pitch ' + r[5].toFixed(1) + '°   bank ' + r[6].toFixed(1) + '°   along ' +
        r[1].toFixed(0) + ' m   across ' + r[2].toFixed(0) + ' m';
    });
    hit.addEventListener('pointerleave', () => { cursors.forEach((c) => c(null)); readout.textContent = 'Hover a chart.'; });
  }
  timeChart('Height above the ground (m)', [[3, 'var(--series-1)']]);
  timeChart('Calibrated airspeed (kt)', [[4, 'var(--series-1)']]);
  const legend = document.createElement('span');
  legend.className = 'legend';
  legend.innerHTML = '<span><span class="swatch" style="background:var(--series-1)"></span>pitch</span>' +
    '<span><span class="swatch" style="background:var(--series-2)"></span>bank</span>';
  timeChart('Pitch and bank (°)', [[5, 'var(--series-1)'], [6, 'var(--series-2)']], legend);
  sec.appendChild(readout);
  return sec;
}
const nav = document.getElementById('nav');
const cards = document.getElementById('cards');
for (const s of DATA.scenarios) {
  const a = document.createElement('a');
  a.href = '#' + s.name;
  a.textContent = s.name;
  nav.appendChild(a);
  cards.appendChild(card(s));
}
</script>
</body>
</html>
`;
}
