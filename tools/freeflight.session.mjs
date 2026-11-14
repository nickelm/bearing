/**
 * Runs a Free Flight session in headless Chromium without WebGPU (tools/hud/session.html:
 * the real FreeFlight class, its start screen, pause menu and cards, every weather preset)
 * and fails if anything it checks did not hold, a page error occurred or a console error
 * was logged. With the dev server up (npm run dev):
 *
 *   node tools/freeflight.session.mjs [http://localhost:5173]
 *
 * Env: VERBOSE=1 prints everything the page found; SHOT=<file.png> saves the start screen
 * as the session leaves it. Playwright is no dependency of the repo (as for
 * freeflight.screens.mjs): tools/browser/launch.mjs says where it is looked for. The page
 * generates the campaign world on the main thread, so a run takes about half a minute.
 *
 * This page has no WebGPU and draws nothing; tools/browser.smoke.mjs runs the app itself.
 */
import { loadPlaywright } from './browser/launch.mjs';

const { chromium } = loadPlaywright();
const base = process.argv[2] ?? 'http://localhost:5173';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console error: ${m.text().slice(0, 300)}`);
});
await page.goto(`${base}/tools/hud/session.html`);
await page.waitForFunction(() => document.title === 'ready', null, { timeout: 300_000 });
const result = await page.evaluate(() => window.result);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
await browser.close();

if (process.env.VERBOSE) console.log(JSON.stringify(result, null, 1));
for (const [preset, r] of Object.entries(result.perPreset ?? {})) {
  const f = r.first;
  console.log(
    `${preset.padEnd(10)} cover ${f.cover} vis ${f.visibility} m rain ${f.rain} snow ${f.snow} ` +
      `dust ${f.dust} storm ${f.storm} wet ${f.wetness} | wind on the aircraft ${r.wind} m/s, ` +
      `land ${r.temperatureShift} °C`,
  );
}
problems.push(
  ...result.errors.map((e) => `error: ${e}`),
  ...result.failures.map((f) => `failed: ${f}`),
);
for (const p of problems) console.error(p);
console.log(problems.length ? `${problems.length} problem(s)` : 'Free Flight session: ok');
process.exit(problems.length ? 1 : 0);
