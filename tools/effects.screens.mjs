/**
 * Screenshots of the effects sandbox in Chromium with WebGPU (Proposal 0011, decision 327):
 * the built sandbox page (`effects.html`), driven through `window.bearingEffects`, each shot
 * stepped to its time and read back through the WebGPU device (tools/browser/page.mjs), so it
 * works on lavapipe too. Writes PNGs to OUT (docs/reports/screens/effects by default).
 *
 *   npm run build && npm run preview      (another shell)
 *   node tools/effects.screens.mjs        env: MODE (gpu, lavapipe), SHOTS, W, H, OUT, URL
 *
 * A sequence (several times) writes one PNG per time: `<shot>-<seconds>s.png`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './browser/launch.mjs';
import { capture, probe } from './browser/page.mjs';

const W = Number(process.env.W ?? 960);
const H = Number(process.env.H ?? 540);
const OUT = process.env.OUT ?? 'docs/reports/screens/effects';
const URL = process.env.URL ?? 'http://localhost:4173/bearing/effects.html';

/** Each shot: a camera station, what to set off (in the page), and the times to capture. */
const SHOTS = {
  'sam-launch': { view: 'sam', setup: 's.spawn("sam-launch")', at: [1, 3, 8] },
  'sam-20km': { view: 'sam-20km', setup: 's.spawn("sam-launch")', at: [8] },
  'air-burst': {
    view: 'range',
    setup:
      's.lookFrom(s.local(-160, -240, 170), s.local(0, 0, 225)); s.effects.explode(s.local(0, 0, 230), 39, "air")',
    at: [0.08, 0.5, 1.5, 5],
  },
  'bomb-impact': {
    view: 'range',
    setup: 's.effects.explode(s.local(0, 40, 0), 87, "ground")',
    at: [0.06, 0.4, 1.2, 3, 8, 20],
  },
  'burning-depot': {
    view: 'depot',
    setup: 's.effects.spawnPreset("fuel-fire", s.site("depot"), "depot")',
    at: [5],
  },
  contrails: { view: 'contrails', setup: 's.contrail(); s.hardTurn(7)', at: [30] },
  'chimney-row': { view: 'works', setup: 's.spawn("chimney"); s.spawn("cooling-tower")', at: [3] },
  downwash: { view: 'helipad', setup: 's.hover(30)', at: [4] },
  'night-strike': {
    view: 'range',
    sun: [-12, 220],
    setup:
      's.effects.explode(s.local(0, 40, 0), 429, "ground"); s.effects.spawnPreset("fuel-fire", s.local(-120, 160, 0), "night-fire")',
    at: [0.1, 6],
  },
  stress: { view: 'overview', setup: 's.stress()', at: [4] },
};

mkdirSync(OUT, { recursive: true });
const { context, page, mode } = await launch({ width: W, height: H });
await page.addInitScript(probe);
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`console: ${m.text()}`);
});
page.on('pageerror', (e) => console.log(`page error: ${e.message}`));
await page.goto(URL, { timeout: 120_000 });
await page.waitForFunction(() => window.bearingEffects && window.bearingEffectsPage, null, {
  timeout: 300_000,
});
console.log(`effects sandbox up (${mode})`);
const names = process.env.SHOTS?.split(',') ?? Object.keys(SHOTS);
for (const name of names) {
  const shot = SHOTS[name];
  if (!shot) throw new Error(`no shot ${name}`);
  await page.evaluate(
    ([view, sun, setup]) => {
      const s = window.bearingEffects;
      window.bearingEffectsPage.pause(true);
      s.reset();
      s.setSun(sun[0], sun[1]);
      s.setView(view);
      window.bearingEffectsPage.step(1 / 30);
      new Function('s', setup)(s);
    },
    [shot.view, shot.sun ?? [35, 220], shot.setup],
  );
  let t = 0;
  for (const at of shot.at) {
    await page.evaluate((dt) => window.bearingEffectsPage.step(dt), at - t);
    t = at;
    const frame = await capture(page);
    const file = join(OUT, shot.at.length > 1 ? `${name}-${at}s.png` : `${name}.png`);
    writeFileSync(file, frame.png);
    const stats = await page.evaluate(() => window.bearingEffects.effects.stats);
    console.log(`${name} at ${at} s: ${stats.live} puffs, ${stats.emitters} emitters → ${file}`);
  }
}
await context.close();
