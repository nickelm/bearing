/**
 * Part I's acceptance checks 12 and 13 for the displays and the status strip
 * (decision 200): the real DisplaySystem over the stand-in scene in each master
 * mode, for the Kestrel and the Heron, in both faction skins, at 1366 × 768 and
 * 1920 × 1080, and each also as seen with protanopia, deuteranopia and tritanopia
 * (Chromium's own emulation). With the dev server up (npm run dev):
 *
 *   node tools/displays.screens.mjs [http://localhost:5173]
 *
 * Env: OUT_DIR (default tools/out/displays), MODES, SIZES (e.g. 1366x768,1920x1080),
 * CVD=0 to leave the color-vision views out. Prints, per shot, how many large and small
 * displays are expanded and whether any slot reaches into the central column.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadPlaywright } from './browser/launch.mjs';

const { chromium } = loadPlaywright();
const base = process.argv[2] ?? 'http://localhost:5173';
const out = process.env.OUT_DIR ?? join('tools', 'out', 'displays');
mkdirSync(out, { recursive: true });
const sizes = (process.env.SIZES ?? '1366x768,1920x1080')
  .split(',')
  .map((s) => s.split('x').map(Number));
const jetModes = ['ground', 'navigation', 'approach', 'air-to-air', 'dogfight', 'air-to-ground'];
const heloModes = ['ground', 'navigation', 'hover'];
const only = process.env.MODES?.split(',');
const cvd = process.env.CVD === '0' ? [] : ['protanopia', 'deuteranopia', 'tritanopia'];

const browser = await chromium.launch();
const problems = [];
for (const [aircraft, modes] of [
  ['kestrel', jetModes],
  ['utility', heloModes],
])
  for (const mode of modes.filter((m) => !only || only.includes(m)))
    for (const skin of ['alliance', 'pact'])
      for (const [width, height] of sizes) {
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        await page.goto(
          `${base}/tools/hud/composite.html?hover=transition&displays=${mode}&aircraft=${aircraft}&skin=${skin}`,
        );
        await page.waitForFunction(() => document.title === 'ready', null, { timeout: 60_000 });
        await page.waitForTimeout(400);
        const stats = await page.evaluate(() => {
          const boxes = [...document.querySelectorAll('.dsp-slot')].filter(
            (b) => !b.classList.contains('dsp-closed'),
          );
          const W = innerWidth;
          const rects = boxes.map((b) => b.getBoundingClientRect());
          const large = rects.filter((r) => r.top > innerHeight / 2).length;
          const small = rects.length - large;
          const inColumn = rects.some((r) => r.right > 0.2 * W + 1 && r.left < 0.8 * W - 1);
          return { large, small, inColumn };
        });
        const name = `${aircraft}-${mode}-${skin}-${width}x${height}`;
        await page.screenshot({ path: join(out, `${name}.png`) });
        if (stats.large > 2 || stats.small > 2 || stats.inColumn)
          problems.push(`${name}: ${JSON.stringify(stats)}`);
        console.log(
          `${name}: ${stats.large} large, ${stats.small} small expanded${stats.inColumn ? ', IN THE COLUMN' : ''}`,
        );
        if (width === sizes[0][0]) {
          const cdp = await page.context().newCDPSession(page);
          for (const type of cvd) {
            await cdp.send('Emulation.setEmulatedVisionDeficiency', { type });
            await page.screenshot({ path: join(out, `${name}-${type}.png`) });
          }
        }
        await page.close();
      }
// A caution and a warning in the strip, as seen with each color-vision deficiency (check 13).
for (const skin of ['alliance', 'pact']) {
  const [width, height] = sizes[0];
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(
    `${base}/tools/hud/composite.html?hover=transition&displays=ground&aircraft=kestrel&skin=${skin}&alerts=1`,
  );
  await page.waitForFunction(() => document.title === 'ready', null, { timeout: 60_000 });
  await page.waitForTimeout(400);
  const name = `kestrel-alerts-${skin}-${width}x${height}`;
  await page.screenshot({ path: join(out, `${name}.png`) });
  const cdp = await page.context().newCDPSession(page);
  for (const type of cvd) {
    await cdp.send('Emulation.setEmulatedVisionDeficiency', { type });
    await page.screenshot({ path: join(out, `${name}-${type}.png`) });
  }
  console.log(`${name}: with the color-vision views`);
  await page.close();
}
await browser.close();
for (const p of problems) console.error(p);
console.log(
  problems.length
    ? `${problems.length} problem(s)`
    : 'displays: every shot within the clutter limits',
);
process.exit(problems.length ? 1 : 0);
